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

interface Participant {
  id: string;
  name: string;
  isOnline: boolean;
}

interface Conversation {
  id: string;
  type: "direct" | "department" | "broadcast";
  name: string;
  participants: Participant[];
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

interface Directory {
  users: Array<{ id: string; name: string; email: string }>;
  departments: Array<{ id: string; name: string }>;
}

const EMOJI_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];

function iconFor(type: Conversation["type"]): string {
  if (type === "broadcast") return "📢";
  if (type === "department") return "#";
  return "";
}

export default function ChatPage() {
  const { t } = useI18n();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);
  const [messageContent, setMessageContent] = useState("");
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showReactionPicker, setShowReactionPicker] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // New-conversation modal
  const [showNew, setShowNew] = useState(false);
  const [directory, setDirectory] = useState<Directory>({ users: [], departments: [] });
  const [newTab, setNewTab] = useState<"people" | "departments" | "everyone">("people");
  const [peopleSearch, setPeopleSearch] = useState("");
  const [busy, setBusy] = useState(false);

  const messageListRef = useRef<HTMLDivElement>(null);

  const loadConversations = useCallback(async () => {
    try {
      const res = await api<Conversation[]>("/chat/conversations?limit=50");
      setConversations(res || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load conversations");
    }
  }, []);

  // Conversations: initial load + gentle polling.
  useEffect(() => {
    loadConversations();
    const interval = setInterval(loadConversations, 10000);
    return () => clearInterval(interval);
  }, [loadConversations]);

  // Messages for the selected conversation.
  useEffect(() => {
    if (!selectedConversationId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    const loadMessages = async () => {
      try {
        const res = await api<Message[]>(
          `/chat/messages?conversationId=${selectedConversationId}&limit=50`,
        );
        if (!cancelled) setMessages((res || []).slice().reverse());
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load messages");
      }
    };
    loadMessages();
    const interval = setInterval(loadMessages, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedConversationId]);

  // Online users.
  useEffect(() => {
    const load = async () => {
      try {
        setOnlineUsers((await api<OnlineUser[]>("/chat/presence/online")) || []);
      } catch {
        /* non-critical */
      }
    };
    load();
    const interval = setInterval(load, 20000);
    return () => clearInterval(interval);
  }, []);

  // Presence heartbeat.
  useEffect(() => {
    const beat = () =>
      api("/chat/presence/update", { method: "POST", body: { isOnline: true } }).catch(
        () => {},
      );
    beat();
    const interval = setInterval(beat, 45000);
    return () => {
      clearInterval(interval);
      api("/chat/presence/update", { method: "POST", body: { isOnline: false } }).catch(
        () => {},
      );
    };
  }, []);

  // Auto-scroll to newest.
  useEffect(() => {
    if (messageListRef.current) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
    }
  }, [messages]);

  const openConversation = useCallback(
    (id: string) => {
      setSelectedConversationId(id);
      setShowNew(false);
      loadConversations();
    },
    [loadConversations],
  );

  const openNewModal = async () => {
    setShowNew(true);
    setNewTab("people");
    setPeopleSearch("");
    try {
      setDirectory(await api<Directory>("/chat/directory"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load directory");
    }
  };

  const startDirect = async (userId: string) => {
    setBusy(true);
    try {
      const res = await api<{ conversationId: string }>("/chat/conversations/direct", {
        method: "POST",
        body: { otherUserId: userId },
      });
      openConversation(res.conversationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start conversation");
    } finally {
      setBusy(false);
    }
  };

  const openDepartment = async (departmentId: string) => {
    setBusy(true);
    try {
      const res = await api<{ conversationId: string }>(
        "/chat/conversations/department",
        { method: "POST", body: { departmentId } },
      );
      openConversation(res.conversationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open department channel");
    } finally {
      setBusy(false);
    }
  };

  const openEveryone = async () => {
    setBusy(true);
    try {
      const res = await api<{ conversationId: string }>(
        "/chat/conversations/org-broadcast",
      );
      openConversation(res.conversationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open channel");
    } finally {
      setBusy(false);
    }
  };

  const sendMessage = async () => {
    const content = messageContent.trim();
    if (!content || !selectedConversationId || sending) return;
    setSending(true);
    try {
      const res = await api<Message>("/chat/messages", {
        method: "POST",
        body: {
          conversationId: selectedConversationId,
          content,
          replyToId: replyingTo?.id || undefined,
        },
      });
      setMessages((prev) => [...prev, res]);
      setMessageContent("");
      setReplyingTo(null);
      loadConversations();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  };

  const refreshMessages = async () => {
    if (!selectedConversationId) return;
    const res = await api<Message[]>(
      `/chat/messages?conversationId=${selectedConversationId}&limit=50`,
    );
    setMessages((res || []).slice().reverse());
  };

  const addReaction = async (messageId: string, emoji: string) => {
    try {
      await api(`/chat/messages/${messageId}/reactions`, {
        method: "POST",
        body: { emoji },
      });
      setShowReactionPicker(null);
      await refreshMessages();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add reaction");
    }
  };

  const removeReaction = async (messageId: string, emoji: string) => {
    try {
      await api(`/chat/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, {
        method: "DELETE",
      });
      await refreshMessages();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove reaction");
    }
  };

  const selectedConversation = conversations.find(
    (c) => c.id === selectedConversationId,
  );

  const filteredPeople = directory.users.filter((u) =>
    (u.name + " " + u.email).toLowerCase().includes(peopleSearch.toLowerCase()),
  );

  const headerSubtitle = (conv: Conversation): string => {
    if (conv.type === "direct") {
      const anyOnline = conv.participants.some((p) => p.isOnline);
      return anyOnline ? t("online") : t("offline");
    }
    return `${conv.participants.length} ${t("members")}`;
  };

  return (
    <div className={`chat-shell ${styles.container}`}>
      {/* Sidebar: Conversation list */}
      <div className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <h2>{t("chat")}</h2>
          <button
            className={styles.newButton}
            title={t("newMessage")}
            onClick={openNewModal}
          >
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
                  <div className={styles.convTitle}>
                    {iconFor(conv.type)} {conv.name}
                  </div>
                  {conv.unreadCount > 0 && (
                    <span className={styles.badge}>{conv.unreadCount}</span>
                  )}
                </div>
                {conv.lastMessage && (
                  <div className={styles.convPreview}>
                    {conv.lastMessage.content.substring(0, 40)}
                  </div>
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
            <div className={styles.header}>
              <div>
                <h1>
                  {iconFor(selectedConversation.type)} {selectedConversation.name}
                </h1>
                <div className={styles.participantStatus}>
                  {headerSubtitle(selectedConversation)}
                </div>
              </div>
            </div>

            <div className={styles.messageList} ref={messageListRef}>
              {messages.length === 0 ? (
                <div className={styles.emptyState}>{t("noMessages")}</div>
              ) : (
                messages.map((msg) => (
                  <div key={msg.id} className={styles.messageContainer}>
                    {msg.replyToId && (
                      <div className={styles.threadContext}>↳ {t("replyingTo")}…</div>
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
                                href="#"
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
                          {new Date(msg.createdAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </div>
                      </div>
                      <button
                        className={styles.reactionButton}
                        title="React"
                        onClick={() =>
                          setShowReactionPicker(
                            showReactionPicker === msg.id ? null : msg.id,
                          )
                        }
                      >
                        😊
                      </button>
                      <button
                        className={styles.reactionButton}
                        title={t("replyingTo")}
                        onClick={() => setReplyingTo(msg)}
                      >
                        ↩
                      </button>
                    </div>

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

            {replyingTo && (
              <div className={styles.replyContext}>
                <div className={styles.replyContent}>
                  <strong>
                    {t("replyingTo")} {replyingTo.senderName}
                  </strong>
                  <p>{replyingTo.content.substring(0, 100)}</p>
                </div>
                <button onClick={() => setReplyingTo(null)}>×</button>
              </div>
            )}

            <div className={styles.composer}>
              <textarea
                value={messageContent}
                onChange={(e) => setMessageContent(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder={t("typeMessage")}
                className={styles.input}
                rows={1}
              />
              <button
                onClick={sendMessage}
                className={styles.sendButton}
                disabled={sending || !messageContent.trim()}
              >
                {t("send")}
              </button>
            </div>
          </>
        ) : (
          <div className={styles.welcome}>
            <div className={styles.welcomeIcon}>💬</div>
            <h2>{t("startConversation")}</h2>
            <p>{t("startConversationHint")}</p>
            <button className={styles.primaryButton} onClick={openNewModal}>
              {t("newMessage")}
            </button>
          </div>
        )}

        {error && (
          <div className={styles.error} onClick={() => setError(null)}>
            {error}
          </div>
        )}
      </div>

      {/* New-conversation modal */}
      {showNew && (
        <div className={styles.modalOverlay} onClick={() => setShowNew(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3>{t("newMessage")}</h3>
              <button onClick={() => setShowNew(false)}>×</button>
            </div>

            <div className={styles.tabs}>
              <button
                className={newTab === "people" ? styles.tabActive : styles.tab}
                onClick={() => setNewTab("people")}
              >
                {t("catPeople")}
              </button>
              <button
                className={newTab === "departments" ? styles.tabActive : styles.tab}
                onClick={() => setNewTab("departments")}
              >
                {t("catDepartments")}
              </button>
              <button
                className={newTab === "everyone" ? styles.tabActive : styles.tab}
                onClick={() => setNewTab("everyone")}
              >
                {t("catEveryone")}
              </button>
            </div>

            <div className={styles.modalBody}>
              {newTab === "people" && (
                <>
                  <input
                    className={styles.searchInput}
                    placeholder={t("searchPeople")}
                    value={peopleSearch}
                    onChange={(e) => setPeopleSearch(e.target.value)}
                    autoFocus
                  />
                  <div className={styles.pickList}>
                    {filteredPeople.length === 0 ? (
                      <div className={styles.emptyState}>{t("noMatches")}</div>
                    ) : (
                      filteredPeople.map((u) => (
                        <button
                          key={u.id}
                          className={styles.pickItem}
                          disabled={busy}
                          onClick={() => startDirect(u.id)}
                        >
                          <span className={styles.pickAvatar}>
                            {u.name.charAt(0).toUpperCase()}
                          </span>
                          <span className={styles.pickInfo}>
                            <span className={styles.pickName}>{u.name}</span>
                            <span className={styles.pickSub}>{u.email}</span>
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                </>
              )}

              {newTab === "departments" && (
                <div className={styles.pickList}>
                  {directory.departments.length === 0 ? (
                    <div className={styles.emptyState}>{t("noDepartments")}</div>
                  ) : (
                    directory.departments.map((d) => (
                      <button
                        key={d.id}
                        className={styles.pickItem}
                        disabled={busy}
                        onClick={() => openDepartment(d.id)}
                      >
                        <span className={styles.pickAvatar}>#</span>
                        <span className={styles.pickInfo}>
                          <span className={styles.pickName}>{d.name}</span>
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}

              {newTab === "everyone" && (
                <div className={styles.pickList}>
                  <button
                    className={styles.pickItem}
                    disabled={busy}
                    onClick={openEveryone}
                  >
                    <span className={styles.pickAvatar}>📢</span>
                    <span className={styles.pickInfo}>
                      <span className={styles.pickName}>{t("everyoneChannel")}</span>
                      <span className={styles.pickSub}>{t("everyoneDesc")}</span>
                    </span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
