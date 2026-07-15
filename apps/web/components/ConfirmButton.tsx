"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n";

/**
 * Two-step guard for destructive/irreversible actions. First click swaps
 * the button for an inline "Sure? Yes / No" pair (no window.confirm, no
 * modal); doing nothing for 4 seconds quietly reverts. Pass the original
 * handler as onConfirm and keep the original className/style — the armed
 * state inherits the same footprint so table rows don't jump.
 */
export function ConfirmButton({
  onConfirm,
  children,
  className,
  style,
  disabled,
  title,
}: {
  onConfirm: () => void;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  title?: string;
}) {
  const { t } = useI18n();
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = (): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);

  const arm = (): void => {
    clear();
    setArmed(true);
    timer.current = setTimeout(() => setArmed(false), 4000);
  };
  const disarm = (): void => {
    clear();
    setArmed(false);
  };

  if (!armed) {
    return (
      <button
        type="button"
        className={className}
        style={style}
        disabled={disabled}
        title={title}
        onClick={arm}
      >
        {children}
      </button>
    );
  }

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        whiteSpace: "nowrap",
      }}
    >
      <span className="muted" style={{ fontSize: "0.82rem", fontWeight: 600 }}>
        {t("confirmSure")}
      </span>
      <button
        type="button"
        className="dt-btn"
        style={{ marginTop: 0, background: "var(--danger)", color: "#fff" }}
        disabled={disabled}
        onClick={() => {
          disarm();
          onConfirm();
        }}
      >
        {t("confirmYes")}
      </button>
      <button
        type="button"
        className="secondary dt-btn"
        style={{ marginTop: 0 }}
        onClick={disarm}
      >
        {t("confirmNo")}
      </button>
    </span>
  );
}
