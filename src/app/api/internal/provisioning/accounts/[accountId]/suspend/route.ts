import { NextResponse } from 'next/server'
import { supabaseAdmin, checkProvisioningSecret } from '@/lib/provisioning/admin-client'

/**
 * POST /api/internal/provisioning/accounts/[accountId]/suspend
 * Body: { reason?: string }
 *
 * Called by app.paskaperu.com's SaasChargeService equivalent when a
 * tenant's WACRM subscription is suspended for non-payment. Enforced
 * in the app via the (dashboard) layout's status check, not by
 * revoking Supabase auth — the tenant can still log in and see why
 * they're locked out, they just can't use the CRM.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const authError = checkProvisioningSecret(request)
  if (authError) {
    return NextResponse.json({ error: authError }, { status: authError === 'Unauthorized' ? 401 : 503 })
  }

  const { accountId } = await params
  let reason: string | undefined
  try {
    const body = await request.json()
    reason = typeof body?.reason === 'string' ? body.reason : undefined
  } catch {
    // no body is fine, reason is optional
  }

  const admin = supabaseAdmin()
  const { data, error } = await admin
    .from('accounts')
    .update({
      status: 'suspended',
      suspended_at: new Date().toISOString(),
      suspended_reason: reason ?? null,
    })
    .eq('id', accountId)
    .select('id, status')
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'account not found' }, { status: 404 })

  return NextResponse.json(data)
}
