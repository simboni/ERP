import { Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DbService } from "../db/db.service";
import type { TenantTokenClaims } from "@jenga/shared";

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  replyToId: string | null;
  hasAttachments: boolean;
  attachments: Array<{ id: string; fileName: string; documentId: string | null }>;
  reactions: Array<{ emoji: string; users: string[]; count: number }>;
}

export interface Conversation {
  id: string;
  type: "direct" | "department" | "broadcast";
  name: string;
  participants: Array<{ id: string; name: string; isOnline: boolean }>;
  lastMessage: Message | null;
  unreadCount: number;
  isPinned: boolean;
  createdAt: string;
}

@Injectable()
export class ChatService {
  constructor(private readonly db: DbService) {}

  /**
   * Directory of people and departments the current user can start a
   * conversation with. Available to every tenant member regardless of
   * privilege — chat is a company-wide tool. Excludes the caller from the
   * people list (you don't DM yourself).
   */
  async getDirectory(
    claims: TenantTokenClaims,
  ): Promise<{
    users: Array<{ id: string; name: string; email: string }>;
    departments: Array<{ id: string; name: string }>;
  }> {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const users = await client.query(
        `SELECT u.id, u.full_name AS name, u.email
         FROM memberships m
         JOIN users u ON u.id = m.user_id
         WHERE m.tenant_id = $1 AND m.status = 'active' AND u.id <> $2
         ORDER BY u.full_name`,
        [claims.tid, claims.sub],
      );
      const departments = await client.query(
        `SELECT id, name FROM departments
         WHERE tenant_id = $1 ORDER BY name`,
        [claims.tid],
      );
      return { users: users.rows, departments: departments.rows };
    });
  }

  /**
   * Get or create a direct message conversation between two users.
   * Direct conversations are uniquely identified by the sorted pair of user IDs.
   */
  async getOrCreateDirectConversation(
    claims: TenantTokenClaims,
    otherUserId: string,
  ): Promise<string> {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const [smaller, larger] = [claims.sub, otherUserId].sort();

      // Check if conversation exists
      const existing = await client.query(
        `SELECT id FROM chat_conversations
         WHERE tenant_id = $1 AND type = 'direct'
         AND user_a_id = $2 AND user_b_id = $3`,
        [claims.tid, smaller, larger],
      );

      if (existing.rows[0]) return existing.rows[0].id;

      // Create new conversation
      const conv = await client.query(
        `INSERT INTO chat_conversations
         (tenant_id, type, user_a_id, user_b_id, created_by)
         VALUES ($1, 'direct', $2, $3, $4)
         RETURNING id`,
        [claims.tid, smaller, larger, claims.sub],
      );

      // Add participants
      await client.query(
        `INSERT INTO chat_participants (conversation_id, user_id)
         VALUES ($1, $2), ($1, $3)`,
        [conv.rows[0].id, claims.sub, otherUserId],
      );

      return conv.rows[0].id;
    });
  }

  /**
   * Get department broadcast conversation (auto-create if needed).
   */
  async getDepartmentConversation(
    claims: TenantTokenClaims,
    departmentId: string,
  ): Promise<string> {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const existing = await client.query(
        `SELECT id FROM chat_conversations
         WHERE tenant_id = $1 AND type = 'department' AND department_id = $2`,
        [claims.tid, departmentId],
      );

      const dept = await client.query(
        `SELECT name FROM departments WHERE id = $1 AND tenant_id = $2`,
        [departmentId, claims.tid],
      );
      const name = dept.rows[0]?.name ? `# ${dept.rows[0].name}` : "# Department";

      let conversationId: string;
      if (existing.rows[0]) {
        conversationId = existing.rows[0].id;
      } else {
        const conv = await client.query(
          `INSERT INTO chat_conversations
           (tenant_id, type, name, department_id, created_by)
           VALUES ($1, 'department', $2, $3, $4)
           RETURNING id`,
          [claims.tid, name, departmentId, claims.sub],
        );
        conversationId = conv.rows[0].id;
      }

      // A channel is only useful if its messages reach people: every active
      // member of the tenant is a participant (idempotent, so members who
      // join later are picked up the next time anyone opens it).
      await this.ensureAllMembersParticipants(client, claims.tid, conversationId);
      return conversationId;
    });
  }

  /**
   * Get organization-wide broadcast conversation.
   */
  async getOrgBroadcastConversation(claims: TenantTokenClaims): Promise<string> {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const existing = await client.query(
        `SELECT id FROM chat_conversations
         WHERE tenant_id = $1 AND type = 'broadcast' AND department_id IS NULL`,
        [claims.tid],
      );

      let conversationId: string;
      if (existing.rows[0]) {
        conversationId = existing.rows[0].id;
      } else {
        const conv = await client.query(
          `INSERT INTO chat_conversations
           (tenant_id, type, name, created_by)
           VALUES ($1, 'broadcast', $2, $3)
           RETURNING id`,
          [claims.tid, "📢 Everyone", claims.sub],
        );
        conversationId = conv.rows[0].id;
      }

      await this.ensureAllMembersParticipants(client, claims.tid, conversationId);
      return conversationId;
    });
  }

  /**
   * Make every active member of the tenant a participant of a channel.
   * Idempotent — safe to call on every open so newly-added members join.
   */
  private async ensureAllMembersParticipants(
    client: PoolClient,
    tenantId: string,
    conversationId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO chat_participants (conversation_id, user_id)
       SELECT $1, m.user_id FROM memberships m
       WHERE m.tenant_id = $2 AND m.status = 'active'
       ON CONFLICT (conversation_id, user_id) DO NOTHING`,
      [conversationId, tenantId],
    );
  }

  /**
   * List conversations for the current user with unread counts.
   */
  async listConversations(
    claims: TenantTokenClaims,
    limit = 50,
  ): Promise<Conversation[]> {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const convs = await client.query(
        `SELECT
           cc.id, cc.type, cc.name, cc.created_at,
           cp.unread_count, cp.is_pinned,
           cm.id as last_msg_id, cm.content, cm.created_at as msg_created_at,
           u_sender.id as sender_id, u_sender.full_name as sender_name
         FROM chat_conversations cc
         JOIN chat_participants cp ON cp.conversation_id = cc.id AND cp.user_id = $2
         LEFT JOIN chat_messages cm ON cm.conversation_id = cc.id AND cm.deleted_at IS NULL
           AND cm.id = (SELECT id FROM chat_messages WHERE conversation_id = cc.id
                        AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1)
         LEFT JOIN users u_sender ON u_sender.id = cm.sender_id
         WHERE cc.tenant_id = $1
         ORDER BY cp.is_pinned DESC, cc.updated_at DESC
         LIMIT $3`,
        [claims.tid, claims.sub, limit],
      );

      return await Promise.all(
        convs.rows.map((row) => this.enrichConversation(claims, row, client)),
      );
    });
  }

  /**
   * Send a message to a conversation.
   */
  async sendMessage(
    claims: TenantTokenClaims,
    conversationId: string,
    content: string,
    replyToId?: string,
  ): Promise<Message> {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      // Verify access
      await this.verifyConversationAccess(client, claims.tid, conversationId, claims.sub);

      // Insert message
      const msg = await client.query(
        `INSERT INTO chat_messages
         (conversation_id, sender_id, content, reply_to_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id, created_at, updated_at`,
        [conversationId, claims.sub, content, replyToId || null],
      );

      // Update conversation timestamp
      await client.query(
        `UPDATE chat_conversations SET updated_at = now() WHERE id = $1`,
        [conversationId],
      );

      // Increment unread for other participants
      await client.query(
        `UPDATE chat_participants
         SET unread_count = unread_count + 1
         WHERE conversation_id = $1 AND user_id != $2`,
        [conversationId, claims.sub],
      );

      return {
        id: msg.rows[0].id,
        conversationId,
        senderId: claims.sub,
        senderName: "",
        content,
        createdAt: msg.rows[0].created_at,
        updatedAt: msg.rows[0].updated_at,
        replyToId: replyToId || null,
        hasAttachments: false,
        attachments: [],
        reactions: [],
      };
    });
  }

  /**
   * Get messages in a conversation with pagination.
   */
  async getMessages(
    claims: TenantTokenClaims,
    conversationId: string,
    limit = 50,
    offset = 0,
  ): Promise<Message[]> {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      // Verify access
      await this.verifyConversationAccess(client, claims.tid, conversationId, claims.sub);

      // Mark as read
      await client.query(
        `UPDATE chat_participants
         SET unread_count = 0, last_read_message_id = (
           SELECT id FROM chat_messages WHERE conversation_id = $1
           AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1
         )
         WHERE conversation_id = $1 AND user_id = $2`,
        [conversationId, claims.sub],
      );

      const msgs = await client.query(
        `SELECT cm.*, u.full_name as sender_name
         FROM chat_messages cm
         JOIN users u ON u.id = cm.sender_id
         WHERE cm.conversation_id = $1 AND cm.deleted_at IS NULL
         ORDER BY cm.created_at DESC
         LIMIT $2 OFFSET $3`,
        [conversationId, limit, offset],
      );

      return await Promise.all(
        msgs.rows.map((row) => this.enrichMessage(claims, row, client)),
      );
    });
  }

  /**
   * Add an emoji reaction to a message.
   */
  async addReaction(
    claims: TenantTokenClaims,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      await client.query(
        `INSERT INTO chat_reactions (message_id, user_id, emoji)
         VALUES ($1, $2, $3)
         ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
        [messageId, claims.sub, emoji],
      );
    });
  }

  /**
   * Remove a reaction from a message.
   */
  async removeReaction(
    claims: TenantTokenClaims,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      await client.query(
        `DELETE FROM chat_reactions
         WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
        [messageId, claims.sub, emoji],
      );
    });
  }

  /**
   * Update online presence.
   */
  async updatePresence(claims: TenantTokenClaims, isOnline: boolean): Promise<void> {
    // Must run inside a tenant transaction so RLS sees app.current_tenant;
    // the user_presence policy's WITH CHECK is keyed off it.
    await this.db.withTenant(claims.tid, claims.sub, async (client) => {
      await client.query(
        `INSERT INTO user_presence (user_id, tenant_id, is_online, last_activity_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id) DO UPDATE SET
           is_online = $3, last_activity_at = now()`,
        [claims.sub, claims.tid, isOnline],
      );
    });
  }

  /**
   * Get online users in tenant.
   */
  async getOnlineUsers(claims: TenantTokenClaims): Promise<
    Array<{ id: string; name: string; lastSeen: string }>
  > {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const users = await client.query(
        `SELECT u.id, u.full_name as name, up.last_seen_at
         FROM user_presence up
         JOIN users u ON u.id = up.user_id
         WHERE up.tenant_id = $1 AND up.is_online = true
         ORDER BY up.last_activity_at DESC`,
        [claims.tid],
      );
      return users.rows;
    });
  }

  // Private helpers

  private async verifyConversationAccess(
    client: any,
    tenantId: string,
    conversationId: string,
    userId: string,
  ): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM chat_conversations cc
       WHERE cc.id = $1 AND cc.tenant_id = $2
       AND EXISTS (
         SELECT 1 FROM chat_participants cp
         WHERE cp.conversation_id = cc.id AND cp.user_id = $3
       )`,
      [conversationId, tenantId, userId],
    );

    if (!result.rows[0]) {
      // 404 (not 403) so we never reveal that a conversation exists in
      // another tenant — RLS already hid it from this query.
      throw new NotFoundException("Conversation not found");
    }
  }

  private async enrichConversation(claims: TenantTokenClaims, row: any, client: any) {
    // Participants (with live online status) power the header and, for
    // direct chats, the display name (the other person).
    const parts = await client.query(
      `SELECT u.id, u.full_name AS name,
              COALESCE(up.is_online, false) AS is_online
       FROM chat_participants cp
       JOIN users u ON u.id = cp.user_id
       LEFT JOIN user_presence up ON up.user_id = u.id
       WHERE cp.conversation_id = $1`,
      [row.id],
    );
    const participants = parts.rows.map((p: any) => ({
      id: p.id,
      name: p.name,
      isOnline: p.is_online,
    }));

    let name: string = row.name;
    if (!name) {
      if (row.type === "direct") {
        const other = participants.find((p: any) => p.id !== claims.sub);
        name = other?.name || "Direct message";
      } else {
        name = this.getConversationName(claims, row);
      }
    }

    const conv: Conversation = {
      id: row.id,
      type: row.type,
      name,
      participants,
      lastMessage: null,
      unreadCount: row.unread_count || 0,
      isPinned: row.is_pinned,
      createdAt: row.created_at,
    };

    if (row.last_msg_id) {
      conv.lastMessage = {
        id: row.last_msg_id,
        conversationId: row.id,
        senderId: row.sender_id,
        senderName: row.sender_name,
        content: row.content,
        createdAt: row.msg_created_at,
        updatedAt: row.msg_created_at,
        replyToId: null,
        hasAttachments: false,
        attachments: [],
        reactions: [],
      };
    }

    return conv;
  }

  private async enrichMessage(
    claims: TenantTokenClaims,
    row: any,
    client: any,
  ): Promise<Message> {
    const attachments = await client.query(
      `SELECT id, file_name, document_id FROM chat_attachments WHERE message_id = $1`,
      [row.id],
    );

    const reactions = await client.query(
      `SELECT emoji, array_agg(u.full_name) as users, count(*) as cnt
       FROM chat_reactions cr
       JOIN users u ON u.id = cr.user_id
       WHERE cr.message_id = $1
       GROUP BY emoji`,
      [row.id],
    );

    return {
      id: row.id,
      conversationId: row.conversation_id,
      senderId: row.sender_id,
      senderName: row.sender_name,
      content: row.content,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      replyToId: row.reply_to_id,
      hasAttachments: row.has_attachments,
      attachments: attachments.rows,
      reactions: reactions.rows.map((r: any) => ({
        emoji: r.emoji,
        users: r.users,
        count: Number(r.cnt),
      })),
    };
  }

  private getConversationName(claims: TenantTokenClaims, row: any): string {
    if (row.type === "direct") {
      return "Direct Message";
    } else if (row.type === "department") {
      return "Department Chat";
    }
    return "Organization Chat";
  }
}
