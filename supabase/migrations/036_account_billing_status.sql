-- ============================================================
-- ACCOUNT BILLING STATUS
--
-- wacrm has no billing concept of its own — billing lives in
-- app.paskaperu.com (the operator's own control plane), which calls
-- the /api/internal/provisioning/* routes to create/suspend/reactivate
-- tenants here. This migration adds the minimal state those routes
-- need, plus a trigger that makes it tamper-proof: the existing
-- `accounts_update` RLS policy lets an account admin UPDATE any
-- column on their own account row (e.g. to rename it), which would
-- otherwise let a suspended tenant's admin just flip their own
-- status back to 'active' via the client SDK. The trigger closes
-- that regardless of which policy exists today or is added later.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended')),
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspended_reason TEXT;

CREATE OR REPLACE FUNCTION public.prevent_self_billing_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (
    NEW.status IS DISTINCT FROM OLD.status
    OR NEW.suspended_at IS DISTINCT FROM OLD.suspended_at
    OR NEW.suspended_reason IS DISTINCT FROM OLD.suspended_reason
  ) AND auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'billing status can only be changed by the provisioning service';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.prevent_self_billing_status_change() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_billing_status_immutable ON accounts;
CREATE TRIGGER enforce_billing_status_immutable
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION public.prevent_self_billing_status_change();
