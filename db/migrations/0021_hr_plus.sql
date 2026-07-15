-- 0021: HR+ — salary history (a row per gross change, written by app code
-- in the employee PATCH path), employee notes (performance / training /
-- disciplinary / general), and trainings with attendee rosters. Same
-- tenancy contract as every table: RLS keyed on app.current_tenant,
-- FORCE ROW LEVEL SECURITY, grants to jenga_app.

-- ---------------------------------------------------------------------------
-- Salary history: one row per gross change. effective_date is the day the
-- change took effect; note records where the gross moved from.
-- ---------------------------------------------------------------------------
CREATE TABLE employee_salary_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  employee_id    uuid NOT NULL REFERENCES employees (id),
  effective_date date NOT NULL DEFAULT current_date,
  gross_cents    bigint NOT NULL CHECK (gross_cents > 0),
  note           text NOT NULL DEFAULT '',
  created_by     uuid REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX employee_salary_history_emp_idx
  ON employee_salary_history (tenant_id, employee_id, effective_date DESC);

ALTER TABLE employee_salary_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_salary_history FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_salary_history_tenant ON employee_salary_history
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON employee_salary_history TO jenga_app;

-- ---------------------------------------------------------------------------
-- Employee notes: dated free-text entries by kind.
-- ---------------------------------------------------------------------------
CREATE TABLE employee_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  employee_id uuid NOT NULL REFERENCES employees (id),
  kind        text NOT NULL
              CHECK (kind IN ('performance', 'training', 'disciplinary', 'general')),
  body        text NOT NULL,
  noted_on    date NOT NULL DEFAULT current_date,
  created_by  uuid REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX employee_notes_emp_idx
  ON employee_notes (tenant_id, employee_id, noted_on DESC);

ALTER TABLE employee_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_notes_tenant ON employee_notes
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON employee_notes TO jenga_app;

-- ---------------------------------------------------------------------------
-- Trainings + attendee roster (one row per training per employee).
-- ---------------------------------------------------------------------------
CREATE TABLE trainings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  name         text NOT NULL,
  provider     text NOT NULL DEFAULT '',
  scheduled_on date NOT NULL,
  completed    boolean NOT NULL DEFAULT false,
  created_by   uuid REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX trainings_tenant_idx
  ON trainings (tenant_id, completed, scheduled_on);

ALTER TABLE trainings ENABLE ROW LEVEL SECURITY;
ALTER TABLE trainings FORCE ROW LEVEL SECURITY;
CREATE POLICY trainings_tenant ON trainings
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON trainings TO jenga_app;

CREATE TABLE training_attendees (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  training_id uuid NOT NULL REFERENCES trainings (id),
  employee_id uuid NOT NULL REFERENCES employees (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (training_id, employee_id)
);

CREATE INDEX training_attendees_training_idx
  ON training_attendees (tenant_id, training_id);

ALTER TABLE training_attendees ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_attendees FORCE ROW LEVEL SECURITY;
CREATE POLICY training_attendees_tenant ON training_attendees
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON training_attendees TO jenga_app;
