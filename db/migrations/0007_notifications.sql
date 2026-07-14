-- 0007: Notification outbox (03-product-vision M1 notification fabric).
-- Same durable-queue spine as fiscal_documents: tenant-RLS for the app,
-- explicit cross-tenant policy for the confined worker role.

CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  channel         text NOT NULL CHECK (channel IN ('sms', 'whatsapp', 'email')),
  recipient       text NOT NULL,
  template_key    text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  rendered        text,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'dead_letter')),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  provider_ref    text,
  last_error      text,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notifications_queue_idx
  ON notifications (status, next_attempt_at)
  WHERE status IN ('pending', 'sending', 'failed');
CREATE INDEX notifications_tenant_idx ON notifications (tenant_id, created_at DESC);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;

CREATE POLICY notifications_tenant ON notifications
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE POLICY notifications_worker ON notifications
  FOR ALL TO jenga_worker
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON notifications TO jenga_app;
GRANT SELECT, UPDATE ON notifications TO jenga_worker;
