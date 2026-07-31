# Internal Provisioning API

wacrm has no billing of its own. Billing lives in `app.paskaperu.com`
(PaskaCRM's SuperAdmin panel), which is meant to become the operator's
single control plane for every product it sells, including wacrm.
This API is how that control plane creates and suspends wacrm tenants
without holding wacrm's Supabase service-role key directly.

## Why not just give Laravel the service-role key?

The service-role key bypasses RLS entirely — full read/write on every
table. If `app.paskaperu.com`'s `.env` ever leaked, that would mean
every tenant's conversations, contacts, and WhatsApp tokens, not just
"can create/suspend an account". This API exists so the blast radius
of a Laravel-side credential leak is "attacker can create bogus wacrm
accounts or flip suspension state" — annoying, not catastrophic.

## Required infra step (not done by this patch)

**Firewall `/api/internal/*` at the OpenLiteSpeed vhost so it is not
reachable from the public internet at all** — only from
`app.paskaperu.com`'s server (same VPS, `144.91.123.16`, so
`127.0.0.1` if both apps run there). The `x-provisioning-secret`
header check in the routes is defense in depth, not the only gate.
Add a `context` block for `/api/internal/` in
`/usr/local/lsws/conf/vhosts/wa.paskaperu.com/vhost.conf` that denies
by IP before it ever reaches the Docker container, the same way the
existing reverse-proxy `context` block was set up.

## Endpoints

All require header `x-provisioning-secret: $PROVISIONING_API_SECRET`.

### `POST /api/internal/provisioning/accounts`
Create a tenant. Body:
```json
{ "email": "owner@client.com", "full_name": "Owner Name", "account_name": "Client SAC" }
```
Returns `201` with `{ account_id, user_id, email, temporary_password }`.
`temporary_password` is returned exactly once — the caller must
deliver it to the tenant (e.g. via Brevo from PaskaCRM) and prompt a
password change on first login. This does NOT use Supabase's
`inviteUserByEmail` — that sends a link to `/auth/callback?next=/reset-password`,
and **neither of those routes exists in wacrm today** (pre-existing
gap, also affects the "forgot password" flow — separate fix, not part
of this patch).

### `POST /api/internal/provisioning/accounts/{accountId}/suspend`
Body (optional): `{ "reason": "pago vencido" }`. Sets `accounts.status
= 'suspended'`. Enforced server-side in `(dashboard)/layout.tsx` — the
tenant sees a "cuenta suspendida" screen instead of the CRM. Does not
revoke their Supabase session or delete data.

**Known gap:** this only blocks the dashboard UI. `/api/v1/*` (the
public API, authenticated via API keys — `src/lib/api-keys/`) is not
yet checked against `accounts.status`. Low risk for now (no tenant has
API keys issued to third parties yet) but close before that changes.

### `POST /api/internal/provisioning/accounts/{accountId}/reactivate`
Clears suspension.

## What PaskaCRM needs to add (not part of this patch — TRD reference)

Per `paskacrm-trd.md`, the natural hook points are:
- `SubscriptionActivationService` → call `POST .../accounts` when a
  tenant's WACRM plan activates, store `wacrm_account_id` on the
  tenant record.
- `SaasChargeService` → call `.../suspend` on the same past-due →
  suspended transition it already drives for PaskaCRM itself, and
  `.../reactivate` on recovery. Needs a way to know which
  subscriptions are "wacrm" vs "paskacrm" — i.e. a `product`
  dimension on `plans`/`TenantSaasSubscription`, since today that
  model assumes a single product.
