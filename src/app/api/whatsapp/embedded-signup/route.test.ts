import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Tests for POST /api/whatsapp/embedded-signup — the server side of Meta's
// WhatsApp Embedded Signup flow. This is the fix for the Biosol production
// bug: a tenant creating their own Meta App instead of connecting under
// wacrm's single App meant their WABA could never validate against our one
// META_APP_SECRET, so inbound webhooks failed silently. Embedded Signup
// keeps every tenant under wacrm's App id, and the `subscribed_apps` call
// is what actually wires up their webhooks.
// ---------------------------------------------------------------------------

let existingConfig: Record<string, unknown> | null = null
let claimedByOtherAccount: Record<string, unknown> | null = null
const updates: Array<Record<string, unknown>> = []
const inserts: Array<Record<string, unknown>> = []

function makeSupabaseMock() {
  function builder(table: string) {
    let didUpdate = false
    let didInsert = false

    const selectResult = () => {
      switch (table) {
        case 'profiles':
          return { data: { account_id: 'acct-1' }, error: null }
        case 'whatsapp_config':
          return { data: existingConfig, error: null }
        default:
          return { data: null, error: null }
      }
    }

    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ['select', 'eq', 'neq', 'order', 'limit']) b[m] = vi.fn(chain)
    b.update = vi.fn((payload: Record<string, unknown>) => {
      didUpdate = true
      updates.push(payload)
      return b
    })
    b.insert = vi.fn((payload: Record<string, unknown>) => {
      didInsert = true
      inserts.push(payload)
      return b
    })
    b.maybeSingle = vi.fn(() =>
      Promise.resolve(didUpdate || didInsert ? { data: null, error: null } : selectResult()),
    )
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve(didUpdate || didInsert ? { data: null, error: null } : selectResult())
    return b
  }

  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })),
    },
    from: vi.fn((table: string) => builder(table)),
  }
}

let supabaseMock = makeSupabaseMock()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => {
      const b: Record<string, unknown> = {}
      const chain = () => b
      for (const m of ['select', 'eq', 'neq']) b[m] = vi.fn(chain)
      b.maybeSingle = vi.fn(() =>
        Promise.resolve({ data: claimedByOtherAccount, error: null }),
      )
      return b
    }),
  })),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: vi.fn(() => 'enc-token'),
}))

const {
  exchangeCodeForToken,
  verifyPhoneNumber,
  subscribeWabaToApp,
  registerPhoneNumber,
} = vi.hoisted(() => ({
  exchangeCodeForToken: vi.fn(async () => ({ accessToken: 'real-access-token' })),
  verifyPhoneNumber: vi.fn(async () => ({ id: 'PNID-1', display_phone_number: '+1 555 0100', verified_name: 'Acme' })),
  subscribeWabaToApp: vi.fn(async () => undefined),
  registerPhoneNumber: vi.fn(async () => ({ success: true, alreadyRegistered: false })),
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  exchangeCodeForToken,
  verifyPhoneNumber,
  subscribeWabaToApp,
  registerPhoneNumber,
}))

import { POST } from './route'

function postSignup(overrides: Record<string, unknown> = {}) {
  return POST(
    new Request('http://localhost/api/whatsapp/embedded-signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: 'auth-code-1',
        waba_id: 'WABA-1',
        phone_number_id: 'PNID-1',
        ...overrides,
      }),
    }),
  )
}

describe('POST /api/whatsapp/embedded-signup', () => {
  beforeEach(() => {
    process.env.META_APP_ID = 'app-1'
    process.env.META_APP_SECRET = 'secret-1'
    existingConfig = null
    claimedByOtherAccount = null
    updates.length = 0
    inserts.length = 0
    supabaseMock = makeSupabaseMock()
    exchangeCodeForToken.mockClear()
    verifyPhoneNumber.mockClear()
    subscribeWabaToApp.mockClear()
    registerPhoneNumber.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('exchanges the code, subscribes the WABA, registers the number, and inserts a new row', async () => {
    const res = await postSignup()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.registered).toBe(true)

    expect(exchangeCodeForToken).toHaveBeenCalledWith({
      code: 'auth-code-1',
      appId: 'app-1',
      appSecret: 'secret-1',
    })
    // The subscribed_apps call is the actual fix for the multi-app bug —
    // must run, not be skipped.
    expect(subscribeWabaToApp).toHaveBeenCalledWith({
      wabaId: 'WABA-1',
      accessToken: 'real-access-token',
    })
    expect(registerPhoneNumber).toHaveBeenCalledTimes(1)
    const registerArgs = (registerPhoneNumber.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >
    expect(registerArgs).toMatchObject({
      phoneNumberId: 'PNID-1',
      accessToken: 'real-access-token',
    })

    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({
      account_id: 'acct-1',
      user_id: 'user-1',
      phone_number_id: 'PNID-1',
      waba_id: 'WABA-1',
      access_token: 'enc-token',
      status: 'connected',
    })
    expect(updates).toHaveLength(0)
  })

  it('updates the existing row instead of duplicating it on reconnect (idempotency)', async () => {
    existingConfig = {
      id: 'cfg-1',
      registered_at: null,
      phone_number_id: 'PNID-1',
    }

    const res = await postSignup()
    expect(res.status).toBe(200)

    expect(inserts).toHaveLength(0)
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ phone_number_id: 'PNID-1', waba_id: 'WABA-1' })
  })

  it('skips re-registration when the same number is already registered', async () => {
    existingConfig = {
      id: 'cfg-1',
      registered_at: '2026-01-01T00:00:00.000Z',
      phone_number_id: 'PNID-1',
    }

    const res = await postSignup()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.registered).toBe(true)
    expect(registerPhoneNumber).not.toHaveBeenCalled()
  })

  it('saves credentials but reports registration_error when /register fails', async () => {
    registerPhoneNumber.mockRejectedValueOnce(new Error('Two-step verification PIN required'))

    const res = await postSignup()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(false)
    expect(json.registered).toBe(false)
    expect(json.registration_error).toMatch(/PIN required/)
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({ last_registration_error: 'Two-step verification PIN required' })
  })

  it('409s when the phone number is already claimed by another account', async () => {
    claimedByOtherAccount = { account_id: 'other-acct' }

    const res = await postSignup()
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.error).toMatch(/already linked to another account/)
    expect(exchangeCodeForToken).not.toHaveBeenCalled()
  })

  it('400s when the code exchange fails', async () => {
    exchangeCodeForToken.mockRejectedValueOnce(new Error('This authorization code has expired'))

    const res = await postSignup()
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error).toMatch(/code exchange failed/i)
  })

  it('400s when required fields are missing', async () => {
    const res = await postSignup({ waba_id: undefined })
    expect(res.status).toBe(400)
  })

  it('401s when there is no session', async () => {
    supabaseMock.auth.getUser = vi.fn(
      async () => ({ data: { user: null }, error: null }) as never,
    )

    const res = await postSignup()
    expect(res.status).toBe(401)
  })

  it('500s with a clear message when META_APP_ID/META_APP_SECRET are not configured', async () => {
    delete process.env.META_APP_ID

    const res = await postSignup()
    const json = await res.json()

    expect(res.status).toBe(500)
    expect(json.error).toMatch(/not configured/i)
  })
})
