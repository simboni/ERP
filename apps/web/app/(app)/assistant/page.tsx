"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, fmtKes, getTenantToken } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import styles from "./assistant.module.css";

interface Artifact {
  type: "quote" | "invoice";
  id: string;
  label: string;
  href: string;
  totalCents?: number;
}

interface Turn {
  role: "user" | "assistant";
  content: string;
  artifacts?: Artifact[];
}

const SUGGESTION_KEYS = [
  "aiSuggestOverdue",
  "aiSuggestQuote",
  "aiSuggestVat",
  "aiSuggestInvoices",
] as const;

export default function AssistantPage() {
  const { t } = useI18n();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!getTenantToken()) return;
    api<{ enabled: boolean }>("/ai/status")
      .then((s) => setEnabled(s.enabled))
      .catch(() => setEnabled(false));
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [turns, busy]);

  const send = async (text?: string): Promise<void> => {
    const content = (text ?? input).trim();
    if (!content || busy) return;
    setError("");
    setInput("");
    const nextTurns: Turn[] = [...turns, { role: "user", content }];
    setTurns(nextTurns);
    setBusy(true);
    try {
      const res = await api<{ reply: string; artifacts: Artifact[] }>("/ai/ask", {
        method: "POST",
        body: {
          messages: nextTurns.map((tn) => ({ role: tn.role, content: tn.content })),
        },
      });
      setTurns((prev) => [
        ...prev,
        { role: "assistant", content: res.reply, artifacts: res.artifacts },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      // Roll the user turn back into the input so nothing is lost.
      setTurns(turns);
      setInput(content);
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
                <div className={styles.text}>{turn.content}</div>
                {turn.artifacts && turn.artifacts.length > 0 && (
                  <div className={styles.cards}>
                    {turn.artifacts.map((a) => (
                      <Link key={a.id} href={a.href} className={styles.card}>
                        <span className={styles.cardIcon}>
                          {a.type === "quote" ? "📄" : "🧾"}
                        </span>
                        <span className={styles.cardBody}>
                          <span className={styles.cardLabel}>{a.label}</span>
                          {a.totalCents !== undefined && (
                            <span className={styles.cardTotal}>
                              {fmtKes(a.totalCents)}
                            </span>
                          )}
                          <span className={styles.cardHint}>
                            {t("aiReviewAndIssue")} →
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

      <div className={styles.composer}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
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
          onClick={() => void send()}
          disabled={busy || !input.trim() || enabled === false}
        >
          {t("send")}
        </button>
      </div>
      <p className={styles.disclaimer}>{t("aiDisclaimer")}</p>
    </div>
  );
}
