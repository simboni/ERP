-- 0025: Project management — the delivery layer on top of Project Operations
-- (0020). Tasks give a project a kanban board (todo → in_progress → blocked →
-- done) with assignees, priorities, due dates and time estimates; milestones
-- track the deliverables a project is billed against. This is the engine
-- behind quotations: a project you can plan, assign and see progress on.
-- Money stays in Project Ops; this file adds only planning/scheduling data.
-- Every table copies the tenant-RLS pattern used across the schema.

-- ---------------------------------------------------------------------------
-- Extend projects with scheduling + ownership fields. Added via ALTER (the
-- table ships in 0020) and guarded with IF NOT EXISTS so re-runs are safe.
-- ---------------------------------------------------------------------------
ALTER TABLE projects ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS start_date date;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS end_date date;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS manager_employee_id uuid REFERENCES employees (id);

-- ---------------------------------------------------------------------------
-- Project tasks: the kanban card. status drives the board columns;
-- completed_at is stamped by the API when status moves to 'done' and cleared
-- when it moves back. assignee_employee_id links to the person on point;
-- sort_order lets a column be re-ordered without touching timestamps.
-- ---------------------------------------------------------------------------
CREATE TABLE project_tasks (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id),
  project_id           uuid NOT NULL REFERENCES projects (id),
  title                text NOT NULL,
  description          text NOT NULL DEFAULT '',
  status               text NOT NULL DEFAULT 'todo'
                       CHECK (status IN ('todo', 'in_progress', 'blocked', 'done')),
  priority             text NOT NULL DEFAULT 'medium'
                       CHECK (priority IN ('low', 'medium', 'high')),
  assignee_employee_id uuid REFERENCES employees (id),
  due_date             date,
  estimate_hours       numeric(7,2) CHECK (estimate_hours IS NULL OR estimate_hours >= 0),
  sort_order           int NOT NULL DEFAULT 0,
  created_by           uuid REFERENCES users (id),
  completed_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX project_tasks_project_idx
  ON project_tasks (tenant_id, project_id, status, sort_order);
-- fast cross-project "my work" lookup by assignee.
CREATE INDEX project_tasks_assignee_idx
  ON project_tasks (tenant_id, assignee_employee_id, status);

ALTER TABLE project_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY project_tasks_tenant ON project_tasks
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON project_tasks TO jenga_app;

-- ---------------------------------------------------------------------------
-- Project milestones: named deliverables with an optional due date. status
-- runs open → reached; reached_at is stamped by the API when a milestone is
-- marked reached and cleared if it is reopened.
-- ---------------------------------------------------------------------------
CREATE TABLE project_milestones (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  project_id   uuid NOT NULL REFERENCES projects (id),
  name         text NOT NULL,
  due_date     date,
  status       text NOT NULL DEFAULT 'open'
               CHECK (status IN ('open', 'reached')),
  reached_at   timestamptz,
  created_by   uuid REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX project_milestones_project_idx
  ON project_milestones (tenant_id, project_id, due_date);

ALTER TABLE project_milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_milestones FORCE ROW LEVEL SECURITY;
CREATE POLICY project_milestones_tenant ON project_milestones
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON project_milestones TO jenga_app;
