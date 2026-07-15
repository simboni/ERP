-- Attendance: one row per employee per working day. Late is derived at
-- check-in against the tenant's shift start (09:00 Nairobi by default,
-- 5-minute grace). Absent = active employee with no row for the day.

CREATE TABLE attendance (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  employee_id uuid NOT NULL REFERENCES employees (id),
  work_date   date NOT NULL,
  check_in    timestamptz NOT NULL DEFAULT now(),
  check_out   timestamptz,
  late        boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, employee_id, work_date)
);
CREATE INDEX attendance_tenant_idx ON attendance (tenant_id, work_date DESC);
ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance FORCE ROW LEVEL SECURITY;
CREATE POLICY attendance_tenant ON attendance
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON attendance TO jenga_app;
