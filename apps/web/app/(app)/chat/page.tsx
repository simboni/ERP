"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, getApiBaseSync, getTenantToken } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import styles from "./chat.module.css";

interface PendingFile {
  name: string;
  mime: string;
  dataBase64: string;
  size: number;
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;

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

/** Two-letter initials for avatars. */
function initials(name: string): string {
  const parts = (name || "?").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

/** Deterministic avatar colour bucket (0-3) from a name. */
function colorBucket(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h) % 4;
}

function shortTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/** Decode the current user id (sub) from the tenant JWT for own/other alignment. */
function currentUserId(): string | null {
  const tok = getTenantToken();
  if (!tok) return null;
  try {
    const part = tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part)).sub ?? null;
  } catch {
    return null;
  }
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
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);

  const messageListRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [me] = useState<string | null>(currentUserId);

  // Full-bleed: let the chat own the whole area below the top bar.
  useEffect(() => {
    document.body.classList.add("chat-fullbleed");
    return () => document.body.classList.remove("chat-fullbleed");
  }, []);

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
    if ((!content && pendingFiles.length === 0) || !selectedConversationId || sending)
      return;
    setSending(true);
    try {
      const res = await api<Message>("/chat/messages", {
        method: "POST",
        body: {
          conversationId: selectedConversationId,
          content,
          replyToId: replyingTo?.id || undefined,
          attachments: pendingFiles.map((f) => ({
            name: f.name,
            mime: f.mime,
            dataBase64: f.dataBase64,
          })),
        },
      });
      setMessages((prev) => [...prev, res]);
      setMessageContent("");
      setReplyingTo(null);
      setPendingFiles([]);
      loadConversations();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  };

  const onFilesPicked = async (fileList: FileList | null) => {
    if (!fileList) return;
    const picks: PendingFile[] = [];
    for (const file of Array.from(fileList)) {
      if (file.size > MAX_FILE_BYTES) {
        setError(`"${file.name}" is larger than 5MB`);
        continue;
      }
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          resolve(result.includes(",") ? result.split(",")[1] : result);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      picks.push({
        name: file.name,
        mime: file.type || "application/octet-stream",
        dataBase64,
        size: file.size,
      });
    }
    setPendingFiles((prev) => [...prev, ...picks]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const downloadAttachment = (documentId: string | null, fileName: string) => {
    if (!documentId) return;
    void fetch(
      `${getApiBaseSync()}/tenants/current/documents/${documentId}/download`,
      { headers: { Authorization: `Bearer ${getTenantToken()}` } },
    )
      .then((r) => r.blob())
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch(() => setError("Failed to download attachment"));
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
    <div
      className={`chat-shell ${styles.container} ${
        selectedConversationId ? styles.threadOpen : ""
      }`}
    >
      {/* Sidebar: Conversation list */}
      <div className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <h2>{t("chat")}</h2>
        </div>
        <button className={styles.newMessageBtn} onClick={openNewModal}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M12 5v14M5 12h14"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </svg>
          {t("newMessage")}
        </button>

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
                <span
                  className={`${styles.avatar} ${styles["c" + colorBucket(conv.name)]}`}
                >
                  {conv.type === "broadcast"
                    ? "📢"
                    : conv.type === "department"
                      ? "#"
                      : initials(conv.name)}
                </span>
                <div className={styles.convBody}>
                  <div className={styles.convRow}>
                    <span className={styles.convTitle}>{conv.name}</span>
                    {conv.lastMessage && (
                      <span className={styles.convTime}>
                        {shortTime(conv.lastMessage.createdAt)}
                      </span>
                    )}
                  </div>
                  <div className={styles.convRow}>
                    <span className={styles.convPreview}>
                      {conv.lastMessage
                        ? conv.lastMessage.content.substring(0, 38) || "📎 Attachment"
                        : "No messages yet"}
                    </span>
                    {conv.unreadCount > 0 && (
                      <span className={styles.badge}>{conv.unreadCount}</span>
                    )}
                  </div>
                </div>
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
              <button
                className={styles.backBtn}
                onClick={() => setSelectedConversationId(null)}
                aria-label="Back to conversations"
                title="Back to conversations"
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M15 5l-7 7 7 7"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <span
                className={`${styles.avatar} ${styles.avatarLg} ${styles["c" + colorBucket(selectedConversation.name)]}`}
              >
                {selectedConversation.type === "broadcast"
                  ? "📢"
                  : selectedConversation.type === "department"
                    ? "#"
                    : initials(selectedConversation.name)}
              </span>
              <div>
                <h1>{selectedConversation.name}</h1>
                <div className={styles.participantStatus}>
                  {headerSubtitle(selectedConversation)}
                </div>
              </div>
            </div>

            <div className={styles.messageList} ref={messageListRef}>
              {messages.length === 0 ? (
                <div className={styles.emptyThread}>
                  <div className={styles.emptyThreadIcon}>💬</div>
                  {t("noMessages")}
                </div>
              ) : (
                messages.map((msg, i) => {
                  const isOwn = !!me && msg.senderId === me;
                  const prev = messages[i - 1];
                  const grouped =
                    prev && prev.senderId === msg.senderId && !msg.replyToId;
                  return (
                    <div
                      key={msg.id}
                      className={`${styles.msgRow} ${isOwn ? styles.own : styles.other}`}
                    >
                      {!isOwn &&
                        (grouped ? (
                          <span className={styles.avatarSpacer} />
                        ) : (
                          <span
                            className={`${styles.avatar} ${styles.avatarSm} ${styles["c" + colorBucket(msg.senderName)]}`}
                          >
                            {initials(msg.senderName)}
                          </span>
                        ))}
                      <div className={styles.msgCol}>
                        {!isOwn && !grouped && (
                          <div className={styles.msgSender}>{msg.senderName}</div>
                        )}
                        {msg.replyToId && (
                          <div className={styles.replyRef}>↳ {t("replyingTo")}…</div>
                        )}
                        <div className={styles.bubbleWrap}>
                          <div className={styles.bubble}>
                            {msg.content && (
                              <div className={styles.msgText}>{msg.content}</div>
                            )}
                            {msg.hasAttachments && msg.attachments.length > 0 && (
                              <div className={styles.attachments}>
                                {msg.attachments.map((att) => (
                                  <button
                                    key={att.id}
                                    className={styles.attachment}
                                    title={att.fileName}
                                    onClick={() =>
                                      downloadAttachment(att.documentId, att.fileName)
                                    }
                                  >
                                    <span className={styles.attachIcon}>📄</span>
                                    <span className={styles.attachName}>
                                      {att.fileName}
                                    </span>
                                    <svg
                                      width="14"
                                      height="14"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      aria-hidden
                                    >
                                      <path
                                        d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                      />
                                    </svg>
                                  </button>
                                ))}
                              </div>
                            )}
                            <span className={styles.msgTime}>
                              {shortTime(msg.createdAt)}
                            </span>
                          </div>

                          <div className={styles.msgActions}>
                            <button
                              className={styles.actionBtn}
                              title="React"
                              onClick={() =>
                                setShowReactionPicker(
                                  showReactionPicker === msg.id ? null : msg.id,
                                )
                              }
                            >
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
                                <circle cx="9" cy="10" r="1.2" fill="currentColor" />
                                <circle cx="15" cy="10" r="1.2" fill="currentColor" />
                                <path d="M8.5 14.5c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                              </svg>
                            </button>
                            <button
                              className={styles.actionBtn}
                              title={t("replyingTo")}
                              onClick={() => setReplyingTo(msg)}
                            >
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                                <path d="M10 9V5l-7 7 7 7v-4c5 0 8 1.5 10 5 0-7-3-11-10-11z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" fill="none" />
                              </svg>
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
                      </div>
                    </div>
                  );
                })
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

            {pendingFiles.length > 0 && (
              <div className={styles.pendingFiles}>
                {pendingFiles.map((f, i) => (
                  <span key={i} className={styles.pendingChip}>
                    📎 {f.name}
                    <button
                      onClick={() =>
                        setPendingFiles((prev) => prev.filter((_, j) => j !== i))
                      }
                      aria-label="Remove"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className={styles.composer}>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: "none" }}
                onChange={(e) => onFilesPicked(e.target.files)}
              />
              <button
                className={styles.attachButton}
                title={t("attachFile")}
                onClick={() => fileInputRef.current?.click()}
                aria-label={t("attachFile")}
              >
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.6 1.6 0 0 1-2.3-2.3l7.8-7.8"
                    stroke="currentColor"
                    strokeWidth="1.9"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
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
                disabled={sending || (!messageContent.trim() && pendingFiles.length === 0)}
                aria-label={t("send")}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M4 12l16-8-6 16-3-7-7-1z"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinejoin="round"
                    fill="currentColor"
                  />
                </svg>
                <span className={styles.sendLabel}>{t("send")}</span>
              </button>
            </div>
          </>
        ) : (
          <div className={styles.welcome}>
            <div className={styles.welcomeIcon}>💬</div>
            <h2>{t("startConversation")}</h2>
            <p>{t("startConversationHint")}</p>
            <button className={styles.primaryButton} onClick={openNewModal}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M12 5v14M5 12h14"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                />
              </svg>
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
