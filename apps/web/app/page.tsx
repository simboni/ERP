"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  api,
  clearTokens,
  setTenantToken,
  setUserToken,
} from "@/lib/api";

interface Membership {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: string;
}

export default function AuthPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [memberships, setMemberships] = useState<Membership[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const selectTenant = async (tenantId: string): Promise<void> => {
    const res = await api<{ accessToken: string }>("/auth/tenant-token", {
      method: "POST",
      body: { tenantId },
    });
    setTenantToken(res.accessToken);
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
      const login = await api<{ accessToken: string }>("/auth/login", {
        method: "POST",
        body: { email, password },
      });
      setUserToken(login.accessToken);
      const me = await api<{ memberships: Membership[] }>("/auth/me");
      if (me.memberships.length === 1) {
        await selectTenant(me.memberships[0].tenantId);
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
      <>
        <h1>Choose a workspace</h1>
        {memberships.map((m) => (
          <div className="card" key={m.tenantId}>
            <strong>{m.tenantName}</strong>{" "}
            <span className="muted">({m.role})</span>
            <br />
            <button onClick={() => void selectTenant(m.tenantId)}>Open</button>
          </div>
        ))}
      </>
    );
  }

  return (
    <>
      <h1>Jenga ERP</h1>
      <p className="muted">
        eTIMS invoicing · M-Pesa reconciliation · compliant books
      </p>
      <div className="card">
        <form onSubmit={(e) => void submit(e)}>
          {mode === "signup" && (
            <>
              <label>Your name</label>
              <input
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
              />
              <label>Business name</label>
              <input
                value={tenantName}
                onChange={(e) => setTenantName(e.target.value)}
                required
              />
            </>
          )}
          <label>Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <label>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={10}
            required
          />
          {error && <div className="err">{error}</div>}
          <button disabled={busy} type="submit">
            {mode === "login" ? "Sign in" : "Create workspace"}
          </button>{" "}
          <button
            type="button"
            className="secondary"
            onClick={() => setMode(mode === "login" ? "signup" : "login")}
          >
            {mode === "login" ? "New business? Sign up" : "Have an account? Sign in"}
          </button>
        </form>
      </div>
    </>
  );
}
