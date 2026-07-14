-- 0005: Payroll — employees and statutory payroll runs (03-product-vision M6).
-- Computation happens in the payroll engine against the statutory rules
-- store AS OF the period; committed runs post to the ledger and are then
-- immutable (corrections = new reversing run, same as all posting).

CREATE TABLE employees (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  full_name    text NOT NULL,
  kra_pin      text,
  national_id  text,
  msisdn       text,          -- net pay via M-Pesa B2C later
  gross_cents  bigint NOT NULL CHECK (gross_cents >= 0),
  status       text NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'inactive')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX employees_tenant_idx ON employees (tenant_id, status);

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees FORCE ROW LEVEL SECURITY;
CREATE POLICY employees_tenant ON employees
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE TABLE payroll_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  period           text NOT NULL,           -- 'YYYY-MM'
  status           text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'committed')),
  employee_count   int NOT NULL DEFAULT 0,
  gross_cents      bigint NOT NULL DEFAULT 0,
  paye_cents       bigint NOT NULL DEFAULT 0,
  nssf_emp_cents   bigint NOT NULL DEFAULT 0,
  nssf_er_cents    bigint NOT NULL DEFAULT 0,
  shif_cents       bigint NOT NULL DEFAULT 0,
  ahl_emp_cents    bigint NOT NULL DEFAULT 0,
  ahl_er_cents     bigint NOT NULL DEFAULT 0,
  nita_cents       bigint NOT NULL DEFAULT 0,
  net_cents        bigint NOT NULL DEFAULT 0,
  journal_entry_id uuid REFERENCES journal_entries (id),
  created_by       uuid REFERENCES users (id),
  committed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period, status) -- one draft and one committed per period
);

ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_runs_tenant ON payroll_runs
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE TABLE payroll_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  run_id         uuid NOT NULL REFERENCES payroll_runs (id),
  employee_id    uuid NOT NULL REFERENCES employees (id),
  gross_cents    bigint NOT NULL,
  taxable_cents  bigint NOT NULL,
  paye_cents     bigint NOT NULL,
  nssf_emp_cents bigint NOT NULL,
  nssf_er_cents  bigint NOT NULL,
  shif_cents     bigint NOT NULL,
  ahl_emp_cents  bigint NOT NULL,
  ahl_er_cents   bigint NOT NULL,
  nita_cents     bigint NOT NULL,
  net_cents      bigint NOT NULL,
  UNIQUE (run_id, employee_id)
);

CREATE INDEX payroll_items_run_idx ON payroll_items (tenant_id, run_id);

ALTER TABLE payroll_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_items FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_items_tenant ON payroll_items
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON employees TO jenga_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON payroll_items TO jenga_app; -- draft rework only
GRANT SELECT, INSERT, UPDATE ON payroll_runs TO jenga_app;
