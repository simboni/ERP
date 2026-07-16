"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  api,
  clearTokens,
  getApiBase,
  setRefreshToken,
  setTenantId,
  setTenantToken,
  setUserToken,
} from "@/lib/api";
import { LangToggle, useI18n } from "@/lib/i18n";

interface Membership {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: string;
}

export default function AuthPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [fullName, setFullName] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [memberships, setMemberships] = useState<Membership[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [serverInfo, setServerInfo] = useState("checking server…");

  useEffect(() => {
    void (async () => {
      const base = await getApiBase();
      const shown = base || window.location.origin;
      try {
        const res = await fetch(`${base}/health`);
        const body = (await res.json().catch(() => ({}))) as { db?: string };
        const ok = res.ok
          ? body.db === "ok" ? "✓ online" : `⚠ ${body.db ?? "degraded"}`
          : `✗ HTTP ${res.status}`;
        setServerInfo(`Server: ${shown} ${ok}`);
      } catch {
        setServerInfo(`Server: ${shown} ✗ unreachable`);
      }
    })();
  }, []);

  const selectTenant = async (m: Membership): Promise<void> => {
    const res = await api<{ accessToken: string }>("/auth/tenant-token", {
      method: "POST",
      body: { tenantId: m.tenantId },
    });
    setTenantToken(res.accessToken);
    setTenantId(m.tenantId);
    // Cache the active role so AppShell can scope the sidebar without a
    // round-trip (mirrors jenga.tenantName / jenga.modules). Cleared on
    // sign out alongside those.
    try {
      sessionStorage.setItem("jenga.role", m.role);
    } catch {
      /* private mode: AppShell falls back to decoding the token */
    }
    router.push("/dashboard");
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      clearTokens();
      if (mode === "signup") {
        const slug =
          tenantName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 30) + `-${Math.floor(Math.random() * 9000 + 1000)}`;
        await api("/auth/signup", {
          method: "POST",
          body: { email, password, fullName, tenantName, tenantSlug: slug },
        });
      }
      const login = await api<{ accessToken: string; refreshToken?: string }>(
        "/auth/login",
        {
          method: "POST",
          body: { email: email.trim(), password },
        },
      );
      setUserToken(login.accessToken);
      if (login.refreshToken) setRefreshToken(login.refreshToken);
      const me = await api<{ memberships: Membership[] }>("/auth/me");
      if (me.memberships.length === 1) {
        await selectTenant(me.memberships[0]);
      } else {
        setMemberships(me.memberships);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  if (memberships) {
    return (
      <main className="auth">
        <h1>{t("chooseWorkspace")}</h1>
        {memberships.map((m) => (
          <div className="card" key={m.tenantId}>
            <strong>{m.tenantName}</strong>{" "}
            <span className="muted">({m.role})</span>
            <br />
            <button onClick={() => void selectTenant(m)}>{t("open")}</button>
          </div>
        ))}
      </main>
    );
  }

  return (
    <main className="auth">
      <h1>Jenga ERP</h1>
      <p className="muted"><LangToggle /></p>
      <p className="muted" style={{ fontSize: "0.75rem" }}>{serverInfo}</p>
      <p className="muted">
        {t("tagline")}
      </p>
      <div className="card">
        <form onSubmit={(e) => void submit(e)}>
          {mode === "signup" && (
            <>
              <label>{t("yourName")}</label>
              <input
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
              />
              <label>{t("businessName")}</label>
              <input
                value={tenantName}
                onChange={(e) => setTenantName(e.target.value)}
                required
              />
            </>
          )}
          <label>{t("email")}</label>
          <input
            type="email"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <label>{t("password")}</label>
          <div style={{ position: "relative" }}>
            <input
              type={showPw ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={10}
              required
              style={{ paddingRight: 44 }}
            />
            <button
              type="button"
              aria-label={showPw ? "Hide password" : "Show password"}
              onClick={() => setShowPw((v) => !v)}
              style={{
                position: "absolute",
                right: 6,
                top: "50%",
                transform: "translateY(-50%)",
                margin: 0,
                padding: "2px 8px",
                background: "transparent",
                color: "var(--muted)",
                fontSize: "1rem",
              }}
            >
              {showPw ? "🙈" : "👁"}
            </button>
          </div>
          {error && <div className="err">{error}</div>}
          <button disabled={busy} type="submit">
            {mode === "login" ? t("signIn") : t("createWorkspace")}
          </button>{" "}
          <button
            type="button"
            className="secondary"
            onClick={() => setMode(mode === "login" ? "signup" : "login")}
          >
            {mode === "login" ? t("newHere") : t("haveAccount")}
          </button>
        </form>
      </div>
    </main>
  );
}
