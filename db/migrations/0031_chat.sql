-- 0031: Chat module — messaging, presence, reactions, document integration.
-- Comprehensive communication tool with direct, department, and broadcast messaging.

-- Conversation types and structure
CREATE TABLE IF NOT EXISTS chat_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('direct', 'department', 'broadcast')),
  name text,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),

  -- For direct conversations: ordered pair of user IDs (smaller, larger) for uniqueness
  user_a_id uuid REFERENCES users(id) ON DELETE CASCADE,
  user_b_id uuid REFERENCES users(id) ON DELETE CASCADE,

  -- For department/broadcast conversations
  department_id uuid REFERENCES departments(id) ON DELETE CASCADE,

  UNIQUE(tenant_id, type, user_a_id, user_b_id), -- Ensures one direct conv per pair
  UNIQUE(tenant_id, type, department_id) -- One department broadcast per dept
);

CREATE INDEX idx_chat_conversations_tenant ON chat_conversations(tenant_id);
CREATE INDEX idx_chat_conversations_type ON chat_conversations(type);
CREATE INDEX idx_chat_conversations_participants ON chat_conversations(user_a_id, user_b_id);

-- Participants in conversations (for quick lookups)
CREATE TABLE IF NOT EXISTS chat_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at timestamp NOT NULL DEFAULT now(),
  last_read_message_id uuid, -- Track read receipts
  unread_count int NOT NULL DEFAULT 0,
  is_pinned boolean NOT NULL DEFAULT false,

  UNIQUE(conversation_id, user_id)
);

CREATE INDEX idx_chat_participants_user ON chat_participants(user_id);
CREATE INDEX idx_chat_participants_conversation ON chat_participants(conversation_id);

-- Messages
CREATE TABLE IF NOT EXISTS chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  content text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  deleted_at timestamp, -- Soft delete

  -- Threading support
  reply_to_id uuid REFERENCES chat_messages(id) ON DELETE SET NULL,

  -- Rich metadata
  has_attachments boolean NOT NULL DEFAULT false
);

CREATE INDEX idx_chat_messages_conversation ON chat_messages(conversation_id);
CREATE INDEX idx_chat_messages_sender ON chat_messages(sender_id);
CREATE INDEX idx_chat_messages_created ON chat_messages(created_at);
CREATE INDEX idx_chat_messages_reply_to ON chat_messages(reply_to_id);

-- File attachments (linked to documents module for filing)
CREATE TABLE IF NOT EXISTS chat_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  document_id uuid REFERENCES documents(id) ON DELETE SET NULL, -- Links to documents module
  file_name text NOT NULL,
  file_size bigint NOT NULL,
  mime_type text,
  uploaded_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX idx_chat_attachments_message ON chat_attachments(message_id);
CREATE INDEX idx_chat_attachments_document ON chat_attachments(document_id);

-- Emoji reactions on messages
CREATE TABLE IF NOT EXISTS chat_reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji text NOT NULL, -- "👍", "❤️", etc.
  created_at timestamp NOT NULL DEFAULT now(),

  UNIQUE(message_id, user_id, emoji)
);

CREATE INDEX idx_chat_reactions_message ON chat_reactions(message_id);
CREATE INDEX idx_chat_reactions_user ON chat_reactions(user_id);

-- User presence tracking (online status, last seen)
CREATE TABLE IF NOT EXISTS user_presence (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  is_online boolean NOT NULL DEFAULT false,
  last_seen_at timestamp NOT NULL DEFAULT now(),
  last_activity_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_presence_tenant ON user_presence(tenant_id);
CREATE INDEX idx_user_presence_online ON user_presence(is_online);

-- RLS Policies for chat
ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_presence ENABLE ROW LEVEL SECURITY;

-- Users can only access conversations they're part of
CREATE POLICY chat_conversations_tenant ON chat_conversations
  FOR SELECT USING (
    tenant_id = current_setting('app.tenant_id')::uuid
    AND EXISTS (
      SELECT 1 FROM chat_participants cp
      WHERE cp.conversation_id = id
      AND cp.user_id = current_setting('app.user_id')::uuid
    )
  );

CREATE POLICY chat_participants_own ON chat_participants
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM chat_conversations cc
      WHERE cc.id = conversation_id
      AND cc.tenant_id = current_setting('app.tenant_id')::uuid
      AND EXISTS (
        SELECT 1 FROM chat_participants cp2
        WHERE cp2.conversation_id = cc.id
        AND cp2.user_id = current_setting('app.user_id')::uuid
      )
    )
  );

CREATE POLICY chat_messages_conversation_access ON chat_messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM chat_conversations cc
      WHERE cc.id = conversation_id
      AND cc.tenant_id = current_setting('app.tenant_id')::uuid
      AND EXISTS (
        SELECT 1 FROM chat_participants cp
        WHERE cp.conversation_id = cc.id
        AND cp.user_id = current_setting('app.user_id')::uuid
      )
    )
  );

-- Users can see presence of anyone in their tenant
CREATE POLICY user_presence_tenant ON user_presence
  FOR SELECT USING (
    tenant_id = current_setting('app.tenant_id')::uuid
  );

-- Grant permissions to app role for inserts/updates
GRANT SELECT ON chat_conversations TO jenga_app;
GRANT SELECT ON chat_participants TO jenga_app;
GRANT SELECT, INSERT ON chat_messages TO jenga_app;
GRANT SELECT, INSERT ON chat_attachments TO jenga_app;
GRANT SELECT, INSERT ON chat_reactions TO jenga_app;
GRANT SELECT, INSERT, UPDATE ON user_presence TO jenga_app;
