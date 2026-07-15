"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

interface Hit {
  type: string;
  id: string;
  title: string;
  subtitle: string;
  href: string;
}

/**
 * Ctrl/Cmd-K universal search. Debounced query against
 * /tenants/current/search; arrow keys + Enter to navigate.
 */
export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setHits([]);
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  const runSearch = useCallback((needle: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (needle.trim().length < 2) {
        setHits([]);
        return;
      }
      setBusy(true);
      api<Hit[]>(
        `/tenants/current/search?q=${encodeURIComponent(needle.trim())}`,
      )
        .then((r) => {
          setHits(r);
          setActive(0);
        })
        .catch(() => setHits([]))
        .finally(() => setBusy(false));
    }, 220);
  }, []);

  const go = useCallback(
    (hit: Hit) => {
      onClose();
      router.push(hit.href);
    },
    [onClose, router],
  );

  if (!open) return null;

  return (
    <div className="palette-scrim" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          placeholder="Search customers, invoices, items, people…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            runSearch(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, hits.length - 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            }
            if (e.key === "Enter" && hits[active]) go(hits[active]);
          }}
        />
        <div className="palette-results">
          {busy && <div className="muted palette-note">Searching…</div>}
          {!busy && q.trim().length >= 2 && hits.length === 0 && (
            <div className="muted palette-note">No matches for “{q}”.</div>
          )}
          {!busy && q.trim().length < 2 && (
            <div className="muted palette-note">
              Type at least two characters — searches every module.
            </div>
          )}
          {hits.map((h, i) => (
            <div
              key={`${h.type}-${h.id}`}
              className={`palette-hit${i === active ? " active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(h)}
            >
              <span className="pill sent">{h.type}</span>
              <span className="palette-title">{h.title}</span>
              <span className="muted">{h.subtitle}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
