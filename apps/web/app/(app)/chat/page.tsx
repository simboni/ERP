"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import styles from "./chat.module.css";

interface Message {
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

interface Conversation {
  id: string;
  type: "direct" | "department" | "broadcast";
  name: string;
  participants: Array<{ id: string; name: string; isOnline: boolean }>;
  lastMessage: Message | null;
  unreadCount: number;
  isPinned: boolean;
  createdAt: string;
}

interface OnlineUser {
  id: string;
  name: string;
  lastSeen: string;
}

const EMOJI_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];

export default function ChatPage() {
  const { t } = useI18n();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);
  const [messageContent, setMessageContent] = useState("");
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showReactionPicker, setShowReactionPicker] = useState<string | null>(null);
  const messageListRef = useRef<HTMLDivElement>(null);

  // Load conversations
  useEffect(() => {
    const loadConversations = async () => {
      try {
        setLoading(true);
        const res = await api<Conversation[]>("/chat/conversations?limit=50");
        setConversations(res || []);
        if (res?.length > 0 && !selectedConversationId) {
          setSelectedConversationId(res[0].id);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load conversations");
      } finally {
        setLoading(false);
      }
    };

    loadConversations();
    const interval = setInterval(loadConversations, 10000); // Refresh every 10s
    return () => clearInterval(interval);
  }, [selectedConversationId]);

  // Load messages for selected conversation
  useEffect(() => {
    if (!selectedConversationId) return;

    const loadMessages = async () => {
      try {
        const res = await api<Message[]>(`/chat/messages?conversationId=${selectedConversationId}&limit=50`);
        setMessages((res || []).reverse());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load messages");
      }
    };

    loadMessages();
    const interval = setInterval(loadMessages, 5000); // Refresh every 5s
    return () => clearInterval(interval);
  }, [selectedConversationId]);

  // Load online users
  useEffect(() => {
    const loadOnlineUsers = async () => {
      try {
        const res = await api<OnlineUser[]>("/chat/presence/online");
        setOnlineUsers(res || []);
      } catch (err) {
        // Silently fail for online users
      }
    };

    loadOnlineUsers();
    const interval = setInterval(loadOnlineUsers, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, []);

  // Update presence
  useEffect(() => {
    const updatePresence = async () => {
      try {
        await api("/chat/presence/update", { method: "POST", body: { isOnline: true } });
      } catch (err) {
        // Silently fail
      }
    };

    updatePresence();
    const interval = setInterval(updatePresence, 60000); // Update every 60s
    return () => clearInterval(interval);

    // Cleanup: set offline on unmount
    return () => {
      api("/chat/presence/update", { method: "POST", body: { isOnline: false } }).catch(() => {});
    };
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    if (messageListRef.current) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
    }
  }, [messages]);

  const sendMessage = async () => {
    if (!messageContent.trim() || !selectedConversationId) return;

    try {
      const res = await api<Message>("/chat/messages", {
        method: "POST",
        body: {
          conversationId: selectedConversationId,
          content: messageContent,
          replyToId: replyingTo?.id || undefined,
        },
      });
      setMessages([...messages, res]);
      setMessageContent("");
      setReplyingTo(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    }
  };

  const addReaction = async (messageId: string, emoji: string) => {
    try {
      await api(`/chat/messages/${messageId}/reactions`, { method: "POST", body: { emoji } });
      // Refresh messages to show new reaction
      const res = await api<Message[]>(`/chat/messages?conversationId=${selectedConversationId}&limit=50`);
      setMessages((res || []).reverse());
      setShowReactionPicker(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add reaction");
    }
  };

  const removeReaction = async (messageId: string, emoji: string) => {
    try {
      await api(`/chat/messages/${messageId}/reactions/${emoji}`, { method: "DELETE" });
      // Refresh messages to show updated reactions
      const res = await api<Message[]>(`/chat/messages?conversationId=${selectedConversationId}&limit=50`);
      setMessages((res || []).reverse());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove reaction");
    }
  };

  const isOnline = (userId: string) => onlineUsers.some((u) => u.id === userId);

  const selectedConversation = conversations.find((c) => c.id === selectedConversationId);

  return (
    <div className={styles.container}>
      {/* Sidebar: Conversation list */}
      <div className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <h2>{t("chat")}</h2>
          <button className={styles.newButton} title={t("newConversation")}>
            +
          </button>
        </div>

        <div className={styles.conversationList}>
          {conversations.length === 0 ? (
            <div className={styles.emptyState}>{t("noConversations")}</div>
          ) : (
            conversations.map((conv) => (
              <div
                key={conv.id}
                className={`${styles.conversationItem} ${
                  selectedConversationId === conv.id ? styles.active : ""
                }`}
                onClick={() => setSelectedConversationId(conv.id)}
              >
                <div className={styles.convName}>
                  <div className={styles.convTitle}>{conv.name}</div>
                  {conv.unreadCount > 0 && (
                    <span className={styles.badge}>{conv.unreadCount}</span>
                  )}
                </div>
                {conv.lastMessage && (
                  <div className={styles.convPreview}>{conv.lastMessage.content.substring(0, 40)}</div>
                )}
              </div>
            ))
          )}
        </div>

        <div className={styles.sidebarFooter}>
          <h3>{t("onlineMembers")}</h3>
          <div className={styles.onlineList}>
            {onlineUsers.length === 0 ? (
              <div className={styles.emptyState}>{t("noOnlineUsers")}</div>
            ) : (
              onlineUsers.map((user) => (
                <div key={user.id} className={styles.onlineUser}>
                  <span className={styles.onlineIndicator}></span>
                  {user.name}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Main: Message view */}
      <div className={styles.main}>
        {selectedConversation ? (
          <>
            {/* Header */}
            <div className={styles.header}>
              <div>
                <h1>{selectedConversation.name}</h1>
                {selectedConversation.type === "direct" && (
                  <div className={styles.participantStatus}>
                    {selectedConversation.participants.map((p) => (
                      <span key={p.id} className={styles.participant}>
                        <span
                          className={`${styles.statusDot} ${isOnline(p.id) ? styles.online : ""}`}
                        ></span>
                        {p.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Messages */}
            <div className={styles.messageList} ref={messageListRef}>
              {messages.length === 0 ? (
                <div className={styles.emptyState}>{t("noMessages")}</div>
              ) : (
                messages.map((msg) => (
                  <div key={msg.id} className={styles.messageContainer}>
                    {msg.replyToId && (
                      <div className={styles.threadContext}>
                        {t("replyingTo")} {msg.senderName}
                      </div>
                    )}
                    <div className={styles.messageGroup}>
                      <div className={styles.messageSender}>{msg.senderName}</div>
                      <div className={styles.message}>
                        <div className={styles.messageContent}>{msg.content}</div>
                        {msg.hasAttachments && msg.attachments.length > 0 && (
                          <div className={styles.attachments}>
                            {msg.attachments.map((att) => (
                              <a
                                key={att.id}
                                href={`#`}
                                className={styles.attachment}
                                title={att.fileName}
                              >
                                📎 {att.fileName}
                              </a>
                            ))}
                          </div>
                        )}
                        {msg.reactions.length > 0 && (
                          <div className={styles.reactions}>
                            {msg.reactions.map((r) => (
                              <button
                                key={r.emoji}
                                className={styles.reactionBadge}
                                onClick={() => removeReaction(msg.id, r.emoji)}
                                title={r.users.join(", ")}
                              >
                                {r.emoji} {r.count}
                              </button>
                            ))}
                          </div>
                        )}
                        <div className={styles.messageTime}>
                          {new Date(msg.createdAt).toLocaleTimeString()}
                        </div>
                      </div>
                      <button
                        className={styles.reactionButton}
                        onClick={() =>
                          setShowReactionPicker(
                            showReactionPicker === msg.id ? null : msg.id
                          )
                        }
                      >
                        😊
                      </button>
                    </div>

                    {/* Reaction picker */}
                    {showReactionPicker === msg.id && (
                      <div className={styles.reactionPicker}>
                        {EMOJI_REACTIONS.map((emoji) => (
                          <button
                            key={emoji}
                            onClick={() => addReaction(msg.id, emoji)}
                            className={styles.reactionOption}
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* Reply context */}
            {replyingTo && (
              <div className={styles.replyContext}>
                <div className={styles.replyContent}>
                  <strong>{t("replyingTo")} {replyingTo.senderName}:</strong>
                  <p>{replyingTo.content.substring(0, 100)}</p>
                </div>
                <button onClick={() => setReplyingTo(null)}>×</button>
              </div>
            )}

            {/* Message composer */}
            <div className={styles.composer}>
              <textarea
                value={messageContent}
                onChange={(e) => setMessageContent(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.ctrlKey) {
                    sendMessage();
                  }
                }}
                placeholder={t("typeMessage")}
                className={styles.input}
              />
              <button onClick={sendMessage} className={styles.sendButton}>
                {t("send")}
              </button>
            </div>
          </>
        ) : (
          <div className={styles.emptyState}>{t("selectConversation")}</div>
        )}

        {error && <div className={styles.error}>{error}</div>}
      </div>
    </div>
  );
}
