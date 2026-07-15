-- CRM: contacts with lifecycle stages, deals pipeline, activities with
-- follow-up dates. Contacts can graduate into accounting customers
-- (customer_id link) so the funnel feeds invoicing directly.

CREATE TABLE crm_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  name        text NOT NULL,
  company     text,
  phone       text,
  email       text,
  stage       text NOT NULL DEFAULT 'lead'
              CHECK (stage IN ('lead', 'opportunity', 'customer')),
  source      text,
  customer_id uuid REFERENCES customers (id), -- set on conversion
  created_by  uuid REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_contacts_tenant_idx ON crm_contacts (tenant_id, stage, created_at DESC);
ALTER TABLE crm_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY crm_contacts_tenant ON crm_contacts
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON crm_contacts TO jenga_app;

CREATE TABLE deals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  contact_id     uuid NOT NULL REFERENCES crm_contacts (id),
  title          text NOT NULL,
  value_cents    bigint NOT NULL DEFAULT 0 CHECK (value_cents >= 0),
  stage          text NOT NULL DEFAULT 'new'
                 CHECK (stage IN ('new', 'qualified', 'proposal', 'won', 'lost')),
  expected_close date,
  quote_id       uuid REFERENCES quotes (id), -- set when converted to a quote
  created_by     uuid REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deals_tenant_idx ON deals (tenant_id, stage, created_at DESC);
ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals FORCE ROW LEVEL SECURITY;
CREATE POLICY deals_tenant ON deals
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON deals TO jenga_app;

CREATE TABLE crm_activities (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  contact_id uuid NOT NULL REFERENCES crm_contacts (id),
  deal_id    uuid REFERENCES deals (id),
  kind       text NOT NULL DEFAULT 'note'
             CHECK (kind IN ('note', 'call', 'meeting', 'task')),
  body       text NOT NULL,
  due_date   date,               -- set => it is a follow-up
  done       boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_activities_tenant_idx
  ON crm_activities (tenant_id, done, due_date);
ALTER TABLE crm_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_activities FORCE ROW LEVEL SECURITY;
CREATE POLICY crm_activities_tenant ON crm_activities
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON crm_activities TO jenga_app;
