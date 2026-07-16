-- 0032: Fix chat RLS policies shipped in 0031.
--
-- 0031 created the chat tables correctly but its row-level-security policies
-- were broken in four ways, so every chat query failed for the runtime role
-- (jenga_app, a non-owner, for whom RLS is always enforced):
--
--   1. They referenced session variables `app.tenant_id` / `app.user_id`,
--      but the whole codebase sets `app.current_tenant` / `app.current_user`
--      (see DbService.withTenant). Worse, `current_setting('app.tenant_id')`
--      with no `missing_ok` argument THROWS "unrecognized configuration
--      parameter" when unset — turning every request into a 500.
--   2. They were `FOR SELECT` only, so INSERT/UPDATE/DELETE were denied —
--      no messages could be sent, no conversations created.
--   3. The GRANTs to jenga_app omitted the UPDATE/DELETE the service needs.
--   4. The conversations<->participants policies referenced each other,
--      risking "infinite recursion detected in policy" errors.
--
-- This migration replaces them with the project's canonical pattern (see
-- 0016_documents.sql): FORCE RLS + one policy per table covering ALL
-- commands via USING + WITH CHECK, scoped to the tenant. Child tables are
-- scoped through their (tenant-scoped) parent conversation, which is
-- recursion-free because the conversations policy is a plain tenant check
-- and never refers back to a child table. Participant-level privacy for
-- direct messages is enforced in the application layer
-- (ChatService.verifyConversationAccess and the participant JOIN in
-- listConversations); the DB boundary here is tenant isolation.

-- Drop the broken 0031 policies (idempotent).
DROP POLICY IF EXISTS chat_conversations_tenant ON chat_conversations;
DROP POLICY IF EXISTS chat_participants_own ON chat_participants;
DROP POLICY IF EXISTS chat_messages_conversation_access ON chat_messages;
DROP POLICY IF EXISTS user_presence_tenant ON user_presence;

-- Enforce RLS even for the table owner, matching every other module.
ALTER TABLE chat_conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE chat_participants FORCE ROW LEVEL SECURITY;
ALTER TABLE chat_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE chat_attachments FORCE ROW LEVEL SECURITY;
ALTER TABLE chat_reactions FORCE ROW LEVEL SECURITY;
ALTER TABLE user_presence FORCE ROW LEVEL SECURITY;

-- Conversations: direct tenant scope (no reference to child tables).
CREATE POLICY chat_conversations_rls ON chat_conversations
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Participants: scoped through the (tenant-scoped) conversation.
CREATE POLICY chat_participants_rls ON chat_participants
  USING (
    EXISTS (SELECT 1 FROM chat_conversations cc WHERE cc.id = conversation_id)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM chat_conversations cc WHERE cc.id = conversation_id)
  );

-- Messages: scoped through the (tenant-scoped) conversation.
CREATE POLICY chat_messages_rls ON chat_messages
  USING (
    EXISTS (SELECT 1 FROM chat_conversations cc WHERE cc.id = conversation_id)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM chat_conversations cc WHERE cc.id = conversation_id)
  );

-- Attachments: scoped through the message (which is tenant-scoped).
CREATE POLICY chat_attachments_rls ON chat_attachments
  USING (
    EXISTS (SELECT 1 FROM chat_messages m WHERE m.id = message_id)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM chat_messages m WHERE m.id = message_id)
  );

-- Reactions: scoped through the message (which is tenant-scoped).
CREATE POLICY chat_reactions_rls ON chat_reactions
  USING (
    EXISTS (SELECT 1 FROM chat_messages m WHERE m.id = message_id)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM chat_messages m WHERE m.id = message_id)
  );

-- Presence: direct tenant scope.
CREATE POLICY user_presence_rls ON user_presence
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Grant the full set of privileges the ChatService actually uses. 0031
-- granted only SELECT/INSERT on most tables, which blocked the UPDATEs
-- (unread counts, conversation timestamps, presence) and the reaction
-- DELETE even once the policies were correct.
GRANT SELECT, INSERT, UPDATE, DELETE ON chat_conversations TO jenga_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON chat_participants TO jenga_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON chat_messages TO jenga_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON chat_attachments TO jenga_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON chat_reactions TO jenga_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_presence TO jenga_app;
