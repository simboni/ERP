-- HR suite: departments, designations, leave management, announcements.
-- Same tenancy contract as every table: RLS keyed on app.current_tenant,
-- FORCE ROW LEVEL SECURITY, least-privilege grants to jenga_app.

CREATE TABLE departments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments FORCE ROW LEVEL SECURITY;
CREATE POLICY departments_tenant ON departments
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON departments TO jenga_app;

ALTER TABLE employees
  ADD COLUMN department_id uuid REFERENCES departments (id),
  ADD COLUMN designation   text,
  ADD COLUMN hired_on      date;

CREATE TABLE leave_policies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  name          text NOT NULL,
  days_per_year numeric(5,1) NOT NULL CHECK (days_per_year > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
ALTER TABLE leave_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY leave_policies_tenant ON leave_policies
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON leave_policies TO jenga_app;

CREATE TABLE leave_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  employee_id uuid NOT NULL REFERENCES employees (id),
  policy_id   uuid NOT NULL REFERENCES leave_policies (id),
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  days        numeric(5,1) NOT NULL CHECK (days > 0),
  reason      text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by  uuid REFERENCES users (id),
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX leave_requests_tenant_idx
  ON leave_requests (tenant_id, status, start_date);
ALTER TABLE leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY leave_requests_tenant ON leave_requests
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON leave_requests TO jenga_app;

CREATE TABLE announcements (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  title      text NOT NULL,
  body       text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX announcements_tenant_idx ON announcements (tenant_id, created_at DESC);
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcements FORCE ROW LEVEL SECURITY;
CREATE POLICY announcements_tenant ON announcements
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT ON announcements TO jenga_app;
