"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, getApiBase, getTenantToken, getUserToken } from "@/lib/api";

export default function SettingsPage() {
  const router = useRouter();
  const [shortcode, setShortcode] = useState("");
  const [totp, setTotp] = useState<{ secret: string; otpauth: string } | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [showNewPw, setShowNewPw] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    await api("/tenants/current");
  }, []);

  useEffect(() => {
    if (!getTenantToken()) {
      router.replace("/");
      return;
    }
    load().catch((e) => setError(e instanceof Error ? e.message : "load failed"));
  }, [load, router]);

  const act = (fn: () => Promise<string>) => async (): Promise<void> => {
    setBusy(true);
    setError("");
    setMsg("");
    try {
      setMsg(await fn());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  };

  const registerShortcode = act(async () => {
    await api("/tenants/current/payments/shortcodes", {
      method: "POST",
      body: { shortcode },
    });
    return `Paybill/till ${shortcode} registered — M-Pesa payments to it will reconcile here.`;
  });

  const startTotp = act(async () => {
    const r = await api<{ secret: string; otpauth: string }>("/auth/totp/setup", {
      method: "POST",
      token: getUserToken(),
    });
    setTotp(r);
    return "Scan the code in Google Authenticator, then confirm below.";
  });

  const enableTotp = act(async () => {
    await api("/auth/totp/enable", {
      method: "POST",
      body: { code: totpCode },
      token: getUserToken(),
    });
    setTotp(null);
    return "Two-factor authentication is ON. You'll need your authenticator at every sign-in.";
  });

  const exportData = async (): Promise<void> => {
    const res = await fetch(`${await getApiBase()}/tenants/current/export`, {
      headers: { Authorization: `Bearer ${getTenantToken()}` },
    });
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `jenga-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };

  return (
    <>
      <p><Link href="/dashboard">← Dashboard</Link></p>
      <h1>Settings</h1>
      {msg && <div className="card" style={{ borderColor: "var(--brand)" }}>{msg}</div>}
      {error && <div className="err">{error}</div>}
      <p className="muted">
        Team members and staff onboarding live under <Link href="/hr">HR</Link>{" "}
        (Team access and Employees tabs).
      </p>

      <h2>M-Pesa paybill / till</h2>
      <div className="card">
        <label>Shortcode (5-7 digits)</label>
        <input value={shortcode} onChange={(e) => setShortcode(e.target.value)} />
        <button disabled={busy || !/^\d{5,7}$/.test(shortcode)} onClick={() => void registerShortcode()}>
          Register shortcode
        </button>
      </div>

      <h2>Security — password</h2>
      <div className="card">
        <p className="muted">
          Locked out on your phone? Set a new password here (letters and
          numbers, no quotes or spaces type easiest on mobile keyboards),
          then sign in on the phone with it. All other devices are signed
          out when it changes.
        </p>
        <label>Current password</label>
        <input
          type="password"
          value={curPw}
          onChange={(e) => setCurPw(e.target.value)}
        />
        <label>New password (min 10 characters)</label>
        <div style={{ position: "relative" }}>
          <input
            type={showNewPw ? "text" : "password"}
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            style={{ paddingRight: 44 }}
          />
          <button
            type="button"
            onClick={() => setShowNewPw((v) => !v)}
            style={{
              position: "absolute",
              right: 6,
              top: "50%",
              transform: "translateY(-50%)",
              margin: 0,
              padding: "2px 8px",
              background: "transparent",
              color: "var(--muted)",
            }}
          >
            {showNewPw ? "🙈" : "👁"}
          </button>
        </div>
        <button
          disabled={busy || newPw.length < 10 || !curPw}
          onClick={() =>
            void act(async () => {
              await api("/auth/change-password", {
                method: "POST",
                body: { currentPassword: curPw, newPassword: newPw },
                token: getUserToken(),
              });
              setCurPw("");
              setNewPw("");
              return "Password changed — use the new one on all devices.";
            })()
          }
        >
          Change password
        </button>
      </div>

      <h2>Security — two-factor authentication</h2>
      <div className="card">
        {!totp ? (
          <button className="secondary" disabled={busy} onClick={() => void startTotp()}>
            Set up 2FA
          </button>
        ) : (
          <>
            <p className="muted">
              Add this secret to Google Authenticator / Authy:
            </p>
            <pre style={{ background: "var(--bg)", padding: 12, borderRadius: 8, overflowX: "auto" }}>
              {totp.secret}
            </pre>
            <label>6-digit code from the app</label>
            <input value={totpCode} onChange={(e) => setTotpCode(e.target.value)} maxLength={6} />
            <button disabled={busy || totpCode.length !== 6} onClick={() => void enableTotp()}>
              Confirm & enable
            </button>
          </>
        )}
      </div>

      <h2>Your data</h2>
      <div className="card">
        <p className="muted">
          Download everything — invoices, books, payroll, payments — as JSON.
          Your data is never locked in. (Owner only.)
        </p>
        <button className="secondary" onClick={() => void exportData()}>
          Export all data
        </button>
      </div>

      <h2>Demo data</h2>
      <div className="card">
        <p className="muted">
          Fill this workspace with a realistic sample business — 100
          customers, 100 invoices across six months, payments, quotes,
          suppliers, bills, expenses, stock and a payroll run — so you can
          explore every module populated. Takes about a minute. Only works
          on a workspace that is still mostly empty.
        </p>
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setMsg("Generating demo data — this takes about a minute…");
            setError("");
            api<{ counts: Record<string, number> }>(
              "/tenants/current/demo-data",
              { method: "POST" },
            )
              .then((r) =>
                setMsg(
                  `Demo data loaded: ${Object.entries(r.counts)
                    .map(([k, v]) => `${v} ${k}`)
                    .join(", ")}. Open the Dashboard to see it.`,
                ),
              )
              .catch((e) =>
                setError(e instanceof Error ? e.message : "seeding failed"),
              )
              .finally(() => setBusy(false));
          }}
        >
          Load demo data
        </button>{" "}
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError("");
            api<{ counts: Record<string, number> }>(
              "/tenants/current/demo-data/hr-crm",
              { method: "POST" },
            )
              .then((r) =>
                setMsg(
                  `HR + CRM demo loaded: ${Object.entries(r.counts)
                    .map(([k, v]) => `${v} ${k}`)
                    .join(", ")}.`,
                ),
              )
              .catch((e) =>
                setError(e instanceof Error ? e.message : "seeding failed"),
              )
              .finally(() => setBusy(false));
          }}
        >
          Load HR + CRM demo data
        </button>
        {msg && <p className="muted">{msg}</p>}
      </div>
    </>
  );
}
