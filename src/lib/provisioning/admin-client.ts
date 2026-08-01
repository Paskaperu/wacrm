import { timingSafeEqual } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Service-role client for /api/internal/provisioning/*. Mirrors
// src/lib/ai/admin-client.ts and src/lib/flows/admin-client.ts —
// these requests are authenticated by a shared secret (see
// requireProvisioningSecret below), not a Supabase session, so
// there is no `auth.uid()` to scope through RLS.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

/**
 * Validates the `x-provisioning-secret` header against
 * PROVISIONING_API_SECRET. Returns an error message on failure, or
 * null on success — mirrors the AUTOMATION_CRON_SECRET check in
 * src/app/api/automations/cron/route.ts.
 *
 * These routes are also expected to be firewalled at the reverse
 * proxy so they are unreachable from the public internet at all
 * (see docs/internal-provisioning-api.md) — the shared secret is
 * defense in depth, not the only barrier.
 */
export function checkProvisioningSecret(request: Request): string | null {
  const expected = process.env.PROVISIONING_API_SECRET
  if (!expected) return 'provisioning API not configured'
  // Constant-time compare so an attacker who can reach this endpoint can't
  // recover the secret byte-by-byte from response-time deltas. Length
  // pre-check is required by timingSafeEqual (throws on mismatched
  // lengths) and only leaks the length itself, which isn't sensitive.
  const supplied = request.headers.get('x-provisioning-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return 'Unauthorized'
  }
  return null
}
