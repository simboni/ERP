"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export interface SelectOption {
  id: string;
  label: string;
  /** Muted second line (e.g. phone, SKU). Also searched. */
  sub?: string;
}

/**
 * A select that stays usable when the list is large: type to filter,
 * click (or Enter) to choose. Drop-in wherever a native <select> over
 * hundreds of customers/suppliers/items would mean endless scrolling.
 */
export function SearchSelect({
  options,
  value,
  onChange,
  placeholder = "Type to search…",
}: {
  options: SelectOption[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.id === value);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return options.slice(0, 50);
    return options
      .filter(
        (o) =>
          o.label.toLowerCase().includes(needle) ||
          (o.sub ?? "").toLowerCase().includes(needle),
      )
      .slice(0, 50);
  }, [options, q]);

  // Click anywhere outside closes the menu.
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const pick = (id: string): void => {
    onChange(id);
    setQ("");
    setOpen(false);
  };

  return (
    <div className="sselect" ref={wrapRef}>
      <input
        value={open ? q : (selected?.label ?? "")}
        placeholder={selected?.label ?? placeholder}
        onFocus={() => {
          setQ("");
          setOpen(true);
        }}
        onChange={(e) => {
          setQ(e.target.value);
          if (!open) setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (filtered[0]) pick(filtered[0].id);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && (
        <div className="sselect-menu">
          {filtered.length === 0 ? (
            <p className="muted sselect-none">Nothing matches “{q}”.</p>
          ) : (
            filtered.map((o) => (
              <button
                key={o.id}
                type="button"
                className={o.id === value ? "sselect-opt hl" : "sselect-opt"}
                onClick={() => pick(o.id)}
              >
                {o.label}
                {o.sub && (
                  <>
                    {" "}
                    <span className="muted">{o.sub}</span>
                  </>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
