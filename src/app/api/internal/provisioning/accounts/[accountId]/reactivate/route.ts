import { NextResponse } from 'next/server'
import { supabaseAdmin, checkProvisioningSecret } from '@/lib/provisioning/admin-client'

/**
 * POST /api/internal/provisioning/accounts/[accountId]/reactivate
 *
 * Called by app.paskaperu.com when a past-due WACRM subscription
 * recovers (successful retry charge, or the tenant is marked
 * is_courtesy). Mirrors PaskaCRM's own suspend/reactivate symmetry
 * from TenantSaasSubscription.
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

  const admin = supabaseAdmin()
  const { data, error } = await admin
    .from('accounts')
    .update({
      status: 'active',
      suspended_at: null,
      suspended_reason: null,
    })
    .eq('id', accountId)
    .select('id, status')
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'account not found' }, { status: 404 })

  return NextResponse.json(data)
}
