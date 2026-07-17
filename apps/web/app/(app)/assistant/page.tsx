"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, fmtKes, getTenantToken } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import styles from "./assistant.module.css";

interface Artifact {
  type: "quote" | "invoice" | "page";
  id: string;
  label: string;
  href: string;
  totalCents?: number;
}

interface Attachment {
  name: string;
  mime: string;
  /** Kept only until the turn is accepted by the server, then stripped. */
  dataBase64?: string;
}

interface Turn {
  role: "user" | "assistant";
  content: string;
  attachments?: Attachment[];
  artifacts?: Artifact[];
}

/**
 * Replies are plain text with at most **bold** figures. Render the bold
 * inline (newlines survive via pre-wrap) so no raw ** ever shows.
 */
function renderRich(text: string): ReactNode {
  return text
    .split(/(\*\*[^*\n]+\*\*)/g)
    .map((seg, i) =>
      seg.startsWith("**") && seg.endsWith("**") && seg.length > 4 ? (
        <strong key={i}>{seg.slice(2, -2)}</strong>
      ) : (
        seg
      ),
    );
}

const SUGGESTION_KEYS = [
  "aiSuggestOverdue",
  "aiSuggestQuote",
  "aiSuggestVat",
  "aiSuggestInvoices",
] as const;

const ACCEPT_MIMES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
];
const MAX_FILES = 3;
const MAX_BYTES = 5 * 1024 * 1024;

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("read failed"));
    r.readAsDataURL(file);
  });
}

export default function AssistantPage() {
  const { t } = useI18n();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Full-bleed: the assistant owns the whole area below the top bar,
  // same as Chat, instead of sitting inside the padded page frame.
  useEffect(() => {
    document.body.classList.add("chat-fullbleed");
    return () => document.body.classList.remove("chat-fullbleed");
  }, []);

  // The text area grows with the message (capped in CSS) so longer
  // instructions never scroll inside a single squeezed row.
  const autoGrow = (): void => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  };

  useEffect(() => {
    if (!getTenantToken()) return;
    api<{ enabled: boolean }>("/ai/status")
      .then((s) => setEnabled(s.enabled))
      .catch(() => setEnabled(false));
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [turns, busy]);

  const onPick = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;
    setError("");
    const next = [...pending];
    for (const f of Array.from(files)) {
      if (next.length >= MAX_FILES) {
        setError(t("aiAttachLimit"));
        break;
      }
      if (!ACCEPT_MIMES.includes(f.type)) {
        setError(t("aiAttachUnsupported"));
        continue;
      }
      if (f.size > MAX_BYTES) {
        setError(t("aiAttachTooLarge"));
        continue;
      }
      try {
        next.push({ name: f.name, mime: f.type, dataBase64: await readBase64(f) });
      } catch {
        setError(t("aiAttachUnsupported"));
      }
    }
    setPending(next);
  };

  const send = async (text?: string): Promise<void> => {
    const content = (text ?? input).trim();
    if ((!content && pending.length === 0) || busy) return;
    setError("");
    setInput("");
    if (taRef.current) taRef.current.style.height = "auto";
    const sentAttachments = pending;
    setPending([]);
    const nextTurns: Turn[] = [
      ...turns,
      {
        role: "user",
        content,
        attachments: sentAttachments.length > 0 ? sentAttachments : undefined,
      },
    ];
    setTurns(nextTurns);
    setBusy(true);
    try {
      const res = await api<{ reply: string; artifacts: Artifact[] }>("/ai/ask", {
        method: "POST",
        body: {
          messages: nextTurns.map((tn, i) => ({
            role: tn.role,
            content: tn.content,
            // Full bytes only for the newest turn; older ones send names so
            // the payload stays small as the conversation grows.
            attachments: tn.attachments?.map((a) =>
              i === nextTurns.length - 1
                ? a
                : { name: a.name, mime: a.mime },
            ),
          })),
        },
      });
      setTurns((prev) => [
        ...prev.map((p) =>
          p.attachments
            ? {
                ...p,
                attachments: p.attachments.map(({ name, mime }) => ({ name, mime })),
              }
            : p,
        ),
        { role: "assistant", content: res.reply, artifacts: res.artifacts },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      // Roll the user turn back into the composer so nothing is lost.
      setTurns(turns);
      setInput(content);
      setPending(sentAttachments);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <h1>
          <span className={styles.spark}>✦</span> {t("aiTitle")}
        </h1>
        <p className={styles.tagline}>{t("aiTagline")}</p>
      </div>

      {enabled === false && (
        <div className={styles.notice}>{t("aiNotConfigured")}</div>
      )}

      <div className={styles.thread} ref={listRef}>
        {turns.length === 0 ? (
          <div className={styles.empty}>
            <p>{t("aiEmptyHint")}</p>
            <div className={styles.chips}>
              {SUGGESTION_KEYS.map((k) => (
                <button
                  key={k}
                  className={styles.chip}
                  disabled={busy || enabled === false}
                  onClick={() => void send(t(k))}
                >
                  {t(k)}
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((turn, i) => (
            <div
              key={i}
              className={`${styles.row} ${turn.role === "user" ? styles.user : styles.assistant}`}
            >
              <div className={styles.bubble}>
                {turn.attachments && turn.attachments.length > 0 && (
                  <div className={styles.attRow}>
                    {turn.attachments.map((a, j) => (
                      <span key={j} className={styles.attChip}>
                        📎 {a.name}
                      </span>
                    ))}
                  </div>
                )}
                <div className={styles.text}>{renderRich(turn.content)}</div>
                {turn.artifacts && turn.artifacts.length > 0 && (
                  <div className={styles.cards}>
                    {turn.artifacts.map((a) => (
                      <Link key={a.id} href={a.href} className={styles.card}>
                        <span className={styles.cardIcon}>
                          {a.type === "quote" ? "📄" : a.type === "invoice" ? "🧾" : "📍"}
                        </span>
                        <span className={styles.cardBody}>
                          <span className={styles.cardLabel}>{a.label}</span>
                          {a.totalCents !== undefined && (
                            <span className={styles.cardTotal}>
                              {fmtKes(a.totalCents)}
                            </span>
                          )}
                          <span className={styles.cardHint}>
                            {(a.type === "page" ? t("aiOpen") : t("aiReviewAndIssue"))} →
                          </span>
                        </span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
        {busy && (
          <div className={`${styles.row} ${styles.assistant}`}>
            <div className={`${styles.bubble} ${styles.typing}`}>
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
      </div>

      {error && <div className="err">{error}</div>}

      {pending.length > 0 && (
        <div className={styles.pendRow}>
          {pending.map((a, i) => (
            <span key={i} className={styles.pendChip}>
              📎 {a.name}
              <button
                className={styles.pendRemove}
                aria-label={`Remove ${a.name}`}
                onClick={() =>
                  setPending((prev) => prev.filter((_, j) => j !== i))
                }
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <div className={styles.composerBox}>
        <button
          className={styles.attachBtn}
          title={t("aiAttach")}
          aria-label={t("aiAttach")}
          disabled={busy || enabled === false}
          onClick={() => fileRef.current?.click()}
        >
          📎
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT_MIMES.join(",")}
          multiple
          hidden
          onChange={(e) => {
            void onPick(e.target.files);
            e.target.value = "";
          }}
        />
        <textarea
          ref={taRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            autoGrow();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={t("aiPlaceholder")}
          disabled={enabled === false}
          rows={1}
        />
        <button
          className={styles.sendBtn}
          onClick={() => void send()}
          disabled={busy || (!input.trim() && pending.length === 0) || enabled === false}
        >
          {t("send")}
        </button>
      </div>
      <p className={styles.disclaimer}>{t("aiDisclaimer")}</p>
    </div>
  );
}
