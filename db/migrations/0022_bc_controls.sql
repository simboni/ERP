-- 0022: Business controls — approval thresholds (maker-checker money gates).
-- A tenant sets a per-document-type threshold; bill payments and
-- purchase-order sends at/above it require an approved approval_requests
-- row before the action proceeds. Self-approval is blocked in the API
-- (decider must differ from requester). The audit_log (0001) records
-- policy changes, request creation and every decision.

-- ---------------------------------------------------------------------------
-- Approval policies: one row per (tenant, doc_type). threshold_cents is the
-- gate ("amounts at/above this need sign-off"); active=false suspends the
-- gate without losing the configured threshold.
-- ---------------------------------------------------------------------------
CREATE TABLE approval_policies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  doc_type        text NOT NULL
                  CHECK (doc_type IN ('bill_payment', 'purchase_order')),
  threshold_cents bigint NOT NULL CHECK (threshold_cents >= 0),
  active          boolean NOT NULL DEFAULT true,
  updated_by      uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, doc_type)
);

ALTER TABLE approval_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY approval_policies_tenant ON approval_policies
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON approval_policies TO jenga_app;

-- ---------------------------------------------------------------------------
-- Approval requests: at most one per (tenant, doc_type, document) — the
-- unique key doubles as the concurrency guard when two gated attempts race.
-- status runs pending → approved | rejected; reason is required on reject.
-- ---------------------------------------------------------------------------
CREATE TABLE approval_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  doc_type     text NOT NULL
               CHECK (doc_type IN ('bill_payment', 'purchase_order')),
  doc_id       uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by uuid NOT NULL REFERENCES users (id),
  decided_by   uuid REFERENCES users (id),
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  UNIQUE (tenant_id, doc_type, doc_id)
);

CREATE INDEX approval_requests_status_idx
  ON approval_requests (tenant_id, status, created_at DESC);

ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY approval_requests_tenant ON approval_requests
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON approval_requests TO jenga_app;
