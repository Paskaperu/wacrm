import { randomInt } from 'crypto'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  exchangeCodeForToken,
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'
import { encrypt } from '@/lib/whatsapp/encryption'

/**
 * POST /api/whatsapp/embedded-signup
 *
 * Server side of Meta's WhatsApp Embedded Signup flow. The client runs
 * `FB.login()` with our Embedded Signup `config_id` and, on success,
 * posts us the authorization `code` plus the `waba_id` / `phone_number_id`
 * the operator picked in Meta's popup (read from the `message` event
 * Meta fires with `{ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data }`
 * — see whatsapp-config.tsx).
 *
 * This exists to fix a real production bug: a tenant (Biosol) created
 * their *own* Meta App instead of connecting under wacrm's App, so their
 * WABA could never validate against our single META_APP_SECRET and every
 * inbound webhook failed silently. Embedded Signup keeps every tenant's
 * WABA under wacrm's one App — the `code` only exists because the user
 * authorized *this* app_id in the popup, and the subscribed_apps call
 * below is what actually wires up their webhooks correctly.
 *
 * Same tenancy rules as POST /api/whatsapp/config: writes only to the
 * authenticated caller's account_id (never accepted from the body), and
 * idempotent — reconnecting updates the existing row instead of
 * duplicating it.
 */

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

export async function POST(request: Request) {
  try {
    const appId = process.env.META_APP_ID
    const appSecret = process.env.META_APP_SECRET
    if (!appId || !appSecret) {
      console.error('[embedded-signup] META_APP_ID / META_APP_SECRET not set')
      return NextResponse.json(
        { error: 'Embedded Signup is not configured on this server (missing META_APP_ID/META_APP_SECRET).' },
        { status: 500 },
      )
    }

    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json()
    const { code, waba_id, phone_number_id } = body

    if (
      typeof code !== 'string' || !code ||
      typeof waba_id !== 'string' || !waba_id ||
      typeof phone_number_id !== 'string' || !phone_number_id
    ) {
      return NextResponse.json(
        { error: 'code, waba_id and phone_number_id are required' },
        { status: 400 },
      )
    }

    // Reject if another account already claimed this phone_number_id —
    // same constraint the manual save path enforces (issue #136: two
    // accounts on one number breaks the webhook's `.single()` lookup).
    const { data: claimed, error: claimedError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', phone_number_id)
      .neq('account_id', accountId)
      .maybeSingle()

    if (claimedError) {
      console.error('[embedded-signup] ownership check failed:', claimedError)
      return NextResponse.json({ error: 'Failed to validate configuration' }, { status: 500 })
    }
    if (claimed) {
      return NextResponse.json(
        {
          error:
            'This WhatsApp phone number is already linked to another account on this instance. Each phone number can only be connected to one wacrm user.',
        },
        { status: 409 },
      )
    }

    // Exchange the authorization code for a real access token. Must
    // happen server-side — appSecret can never reach the browser.
    let accessToken: string
    try {
      ;({ accessToken } = await exchangeCodeForToken({ code, appId, appSecret }))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('[embedded-signup] code exchange failed:', message)
      return NextResponse.json({ error: `Meta code exchange failed: ${message}` }, { status: 400 })
    }

    // Confirm the token actually works for the chosen number.
    let phoneInfo
    try {
      phoneInfo = await verifyPhoneNumber({ phoneNumberId: phone_number_id, accessToken })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('[embedded-signup] phone verification failed:', message)
      return NextResponse.json({ error: `Meta API error: ${message}` }, { status: 400 })
    }

    // Look up any pre-existing row for this account for idempotency and
    // to avoid re-registering a number that's already live.
    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id, registered_at, phone_number_id')
      .eq('account_id', accountId)
      .maybeSingle()

    const alreadyRegistered =
      existing?.phone_number_id === phone_number_id && existing?.registered_at != null

    // Step 1 (the fix for the Biosol bug): subscribe THIS app to the
    // WABA's webhooks. Without this, Meta keeps routing events to
    // whichever app the WABA was last wired to — never omit this call.
    let subscribedAppsAt: string | null = null
    try {
      await subscribeWabaToApp({ wabaId: waba_id, accessToken })
      subscribedAppsAt = new Date().toISOString()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn('[embedded-signup] WABA subscribed_apps failed (non-fatal):', message)
    }

    // Step 2: register the phone number for inbound webhook delivery.
    // Numbers that just came through Embedded Signup have no existing
    // 2-step PIN to reuse, so we mint a random one — Meta requires a
    // `pin` on /register regardless of whether 2FA was already on.
    let registeredAt: string | null = existing?.registered_at ?? null
    let registrationError: string | null = null
    if (!alreadyRegistered) {
      try {
        const pin = String(randomInt(100000, 1000000))
        await registerPhoneNumber({ phoneNumberId: phone_number_id, accessToken, pin })
        registeredAt = new Date().toISOString()
      } catch (err) {
        registrationError = err instanceof Error ? err.message : 'Unknown Meta API error'
        console.error('[embedded-signup] /register failed:', registrationError)
        // Fall through and still save credentials — the existing
        // "Verify with Meta" / re-save path lets the user retry.
      }
    }

    const encryptedAccessToken = encrypt(accessToken)
    const baseRow = {
      phone_number_id,
      waba_id,
      access_token: encryptedAccessToken,
      status: registrationError ? 'disconnected' : 'connected',
      connected_at: registrationError ? null : new Date().toISOString(),
      registered_at: registrationError ? null : registeredAt,
      subscribed_apps_at: subscribedAppsAt ?? null,
      last_registration_error: registrationError,
      updated_at: new Date().toISOString(),
    }

    if (existing) {
      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update(baseRow)
        .eq('account_id', accountId)

      if (updateError) {
        console.error('[embedded-signup] update failed:', updateError)
        return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
      }
    } else {
      const { error: insertError } = await supabase
        .from('whatsapp_config')
        .insert({ account_id: accountId, user_id: user.id, ...baseRow })

      if (insertError) {
        console.error('[embedded-signup] insert failed:', insertError)
        return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
      }
    }

    if (registrationError) {
      return NextResponse.json({
        success: false,
        saved: true,
        registered: false,
        registration_error: registrationError,
        phone_info: phoneInfo,
      })
    }

    return NextResponse.json({
      success: true,
      saved: true,
      registered: registeredAt != null,
      phone_info: phoneInfo,
    })
  } catch (error) {
    console.error('[embedded-signup] unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
