import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { supabaseAdmin, checkProvisioningSecret } from '@/lib/provisioning/admin-client'

/**
 * POST /api/internal/provisioning/accounts
 *
 * Creates a new wacrm tenant. Called by app.paskaperu.com when a
 * WACRM subscription activates.
 *
 * Body: { email: string, full_name: string, account_name?: string }
 *
 * We deliberately do NOT use supabase.auth.admin.inviteUserByEmail()
 * here — that sends Supabase's own email with a link to
 * /auth/callback?next=/reset-password, and neither of those routes
 * exists in this app today (see docs/internal-provisioning-api.md).
 * Until that's fixed, we create the user with a random temporary
 * password and hand it back once in the response; the caller
 * (app.paskaperu.com, via Brevo) is responsible for delivering it
 * to the tenant and prompting a change on first login.
 *
 * `handle_new_user()` (migration 017) fires on the auth.users INSERT
 * below and creates the `accounts` + `profiles` rows automatically —
 * this route does not touch those tables directly except to rename
 * the account afterward if `account_name` was supplied.
 */
export async function POST(request: Request) {
  const authError = checkProvisioningSecret(request)
  if (authError) {
    return NextResponse.json({ error: authError }, { status: authError === 'Unauthorized' ? 401 : 503 })
  }

  let body: { email?: string; full_name?: string; account_name?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { email, full_name, account_name } = body
  if (!email || typeof email !== 'string' || !full_name || typeof full_name !== 'string') {
    return NextResponse.json({ error: 'email and full_name are required' }, { status: 400 })
  }

  const admin = supabaseAdmin()

  // Fail clearly instead of letting a duplicate email 500 out of
  // admin.createUser with a less obvious error.
  const { data: existing } = await admin.auth.admin.listUsers()
  if (existing?.users?.some((u) => u.email?.toLowerCase() === email.toLowerCase())) {
    return NextResponse.json({ error: 'A wacrm account already exists for this email' }, { status: 409 })
  }

  const temporaryPassword = crypto.randomBytes(18).toString('base64url')

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password: temporaryPassword,
    email_confirm: true,
    user_metadata: { full_name },
  })

  if (createError || !created?.user) {
    return NextResponse.json(
      { error: createError?.message ?? 'Failed to create user' },
      { status: 500 },
    )
  }

  // handle_new_user() already inserted accounts + profiles by this
  // point (it runs synchronously in the same transaction as the
  // auth.users INSERT). Look up the account_id it created.
  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('account_id')
    .eq('user_id', created.user.id)
    .single()

  if (profileError || !profile?.account_id) {
    return NextResponse.json(
      { error: 'User created but account bootstrap did not complete — check handle_new_user logs' },
      { status: 500 },
    )
  }

  if (account_name) {
    await admin.from('accounts').update({ name: account_name }).eq('id', profile.account_id)
  }

  return NextResponse.json({
    account_id: profile.account_id,
    user_id: created.user.id,
    email,
    temporary_password: temporaryPassword,
  }, { status: 201 })
}
