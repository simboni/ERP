"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { DataTable, Column } from "@/components/DataTable";
import { useI18n } from "@/lib/i18n";
import { api, getApiBase, getTenantToken, getUserToken } from "@/lib/api";
import {
  BUSINESS_TYPES,
  OPTIONAL_MODULES,
  presetModules,
} from "@/lib/modules";

type Tab = "profile" | "business" | "branches" | "tax" | "payments" | "account";

interface Profile {
  name: string;
  legal_name: string | null;
  kra_pin: string | null;
  vat_number: string | null;
  phone: string | null;
  email: string | null;
  postal_address: string | null;
  physical_address: string | null;
  currency: string;
  fiscal_year_start_month: number;
  invoice_footer: string | null;
  invoice_prefix: string | null;
  quote_prefix: string | null;
  default_vat_rate: string;
  prices_vat_inclusive: boolean;
  default_payment_terms_days: number;
  business_type: string;
  enabled_modules: string[];
  next_invoice_no: number;
  next_quote_no: number;
  logo: string | null;
}

/** Reads the current member's role from the tenant JWT for read-only gating. */
function currentRole(): string {
  try {
    const tok = getTenantToken();
    if (!tok) return "";
    const payload = JSON.parse(atob(tok.split(".")[1] ?? "")) as {
      rol?: string;
    };
    return payload.rol ?? "";
  } catch {
    return "";
  }
}

interface Branch {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  address: string | null;
  is_default: boolean;
  active: boolean;
  created_at: string;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export default function SettingsPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("profile");
  const canEditBusiness = ["owner", "admin"].includes(currentRole());
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Business profile + tax/numbering (both edit the tenants row).
  const [profile, setProfile] = useState<Profile | null>(null);

  // Branches.
  const [branches, setBranches] = useState<Branch[]>([]);
  const [bForm, setBForm] = useState({ code: "", name: "", phone: "", address: "" });
  const [editing, setEditing] = useState<Branch | null>(null);

  // Payment channels.
  const [shortcode, setShortcode] = useState("");

  // Account & security.
  const [totp, setTotp] = useState<{ secret: string; otpauth: string } | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [showNewPw, setShowNewPw] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const [p, b] = await Promise.all([
      api<Profile>("/tenants/current/profile"),
      api<Branch[]>("/tenants/current/branches"),
    ]);
    setProfile(p);
    setBranches(b);
  }, []);

  useEffect(() => {
    if (!getTenantToken()) {
      router.replace("/login");
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

  const patchField = <K extends keyof Profile>(k: K, v: Profile[K]): void =>
    setProfile((p) => (p ? { ...p, [k]: v } : p));

  const saveProfile = (fields: (keyof Profile)[]) =>
    act(async () => {
      if (!profile) return "";
      const body: Record<string, unknown> = {};
      for (const f of fields) body[f] = profile[f];
      await api("/tenants/current/profile", { method: "PATCH", body });
      return t("setSaved");
    });

  // Business type + optional-module visibility. Saving refreshes the sidebar
  // cache and reloads so the nav reflects the new module set immediately.
  const saveBusiness = act(async () => {
    if (!profile) return "";
    const enabledModules = profile.enabled_modules;
    await api("/tenants/current/profile", {
      method: "PATCH",
      body: { businessType: profile.business_type, enabledModules },
    });
    try {
      sessionStorage.setItem("jenga.modules", JSON.stringify(enabledModules));
    } catch {
      /* in-memory only */
    }
    // Simplest reliable path: reload so AppShell re-reads the module set.
    window.location.reload();
    return t("setSaved");
  });

  // Picking a type re-suggests that preset's modules (does not wipe manual
  // tweaks elsewhere — it just sets enabled_modules to the preset).
  const pickBusinessType = (key: string): void =>
    setProfile((p) =>
      p ? { ...p, business_type: key, enabled_modules: presetModules(key) } : p,
    );

  const toggleModule = (key: string): void =>
    setProfile((p) => {
      if (!p) return p;
      const on = p.enabled_modules.includes(key);
      return {
        ...p,
        enabled_modules: on
          ? p.enabled_modules.filter((m) => m !== key)
          : [...p.enabled_modules, key],
      };
    });


  const uploadLogo = async (file: File): Promise<void> => {
    if (!profile) return;
    setBusy(true);
    setError("");
    setMsg("");
    try {
      const reader = new FileReader();
      reader.onload = async (e) => {
        const base64 = e.target?.result as string;
        await api("/tenants/current/profile", {
          method: "PATCH",
          body: { logo: base64 },
        });
        setProfile((p) => (p ? { ...p, logo: base64 } : p));
        setMsg(t("setSaved"));
      };
      reader.readAsDataURL(file);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to upload logo");
    } finally {
      setBusy(false);
    }
  };

  const removeLogo = async (): Promise<void> => {
    if (!profile) return;
    setBusy(true);
    setError("");
    try {
      await api("/tenants/current/profile", {
        method: "PATCH",
        body: { logo: null },
      });
      setProfile((p) => (p ? { ...p, logo: null } : p));
      setMsg(t("setSaved"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove logo");
    } finally {
      setBusy(false);
    }
  };
  const addBranch = act(async () => {
    await api("/tenants/current/branches", {
      method: "POST",
      body: {
        code: bForm.code,
        name: bForm.name,
        phone: bForm.phone || undefined,
        address: bForm.address || undefined,
      },
    });
    setBForm({ code: "", name: "", phone: "", address: "" });
    return t("setSaved");
  });

  const saveEdit = act(async () => {
    if (!editing) return "";
    await api(`/tenants/current/branches/${editing.id}`, {
      method: "PATCH",
      body: {
        code: editing.code,
        name: editing.name,
        phone: editing.phone ?? "",
        address: editing.address ?? "",
      },
    });
    setEditing(null);
    return t("setSaved");
  });

  const patchBranch = (id: string, body: Record<string, unknown>) =>
    act(async () => {
      await api(`/tenants/current/branches/${id}`, { method: "PATCH", body });
      return t("setSaved");
    });

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

  const branchCols: Column<Branch>[] = [
    { key: "code", label: t("setBranchCode") },
    { key: "name", label: t("setBranchName") },
    { key: "phone", label: t("setBranchPhone") },
    { key: "address", label: t("setBranchAddress") },
    {
      key: "is_default",
      label: t("setBranchDefault"),
      render: (r) => (r.is_default ? <span className="pill paid">✓</span> : "—"),
    },
    {
      key: "active",
      label: t("setBranchActive"),
      render: (r) =>
        r.active ? (
          <span className="pill paid">{t("setBranchActive")}</span>
        ) : (
          <span className="pill void">—</span>
        ),
    },
    {
      key: "actions",
      label: "",
      render: (r) => (
        <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
          <button
            type="button"
            className="secondary dt-btn"
            onClick={() => setEditing(r)}
          >
            {t("setBranchEdit")}
          </button>
          {!r.is_default && (
            <button
              type="button"
              className="secondary dt-btn"
              disabled={busy}
              onClick={() => void patchBranch(r.id, { isDefault: true })()}
            >
              {t("setBranchSetDefault")}
            </button>
          )}
          <button
            type="button"
            className="secondary dt-btn"
            disabled={busy}
            onClick={() => void patchBranch(r.id, { active: !r.active })()}
          >
            {r.active ? t("setBranchDeactivate") : t("setBranchReactivate")}
          </button>
        </span>
      ),
    },
  ];

  return (
    <>
      <p><Link href="/dashboard">← Dashboard</Link></p>
      <h1>{t("setTitle")}</h1>
      <div className="tabs">
        {(
          [
            ["profile", t("setTabProfile")],
            ["business", t("setTabBusiness")],
            ["branches", t("setTabBranches")],
            ["tax", t("setTabTax")],
            ["payments", t("setTabPayments")],
            ["account", t("setTabAccount")],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={tab === key ? "tab active" : "tab"}
            onClick={() => {
              setTab(key);
              setMsg("");
              setError("");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {msg && <div className="card" style={{ borderColor: "var(--brand)" }}>{msg}</div>}
      {error && <div className="err">{error}</div>}

      {tab === "profile" && profile && (
        <div className="card">
          <p className="muted">{t("setProfileIntro")}</p>
          <div className="row">
            <div>
              <label>{t("setDisplayName")}</label>
              <input value={profile.name} onChange={(e) => patchField("name", e.target.value)} />
            </div>
            <div>
              <label>{t("setLegalName")}</label>
              <input
                value={profile.legal_name ?? ""}
                onChange={(e) => patchField("legal_name", e.target.value)}
              />
            </div>
          </div>
          <div className="row">
            <div>
              <label>{t("setKraPin")}</label>
              <input
                value={profile.kra_pin ?? ""}
                onChange={(e) => patchField("kra_pin", e.target.value)}
              />
            </div>
            <div>
              <label>{t("setVatNumber")}</label>
              <input
                value={profile.vat_number ?? ""}
                onChange={(e) => patchField("vat_number", e.target.value)}
              />
            </div>
          </div>
          <div className="row">
            <div>
              <label>{t("setPhone")}</label>
              <input
                value={profile.phone ?? ""}
                onChange={(e) => patchField("phone", e.target.value)}
              />
            </div>
            <div>
              <label>{t("setEmail")}</label>
              <input
                value={profile.email ?? ""}
                onChange={(e) => patchField("email", e.target.value)}
              />
            </div>
          </div>
          <label>{t("setPostalAddress")}</label>
          <input
            value={profile.postal_address ?? ""}
            onChange={(e) => patchField("postal_address", e.target.value)}
          />
          <label>{t("setPhysicalAddress")}</label>
          <input
            value={profile.physical_address ?? ""}
            onChange={(e) => patchField("physical_address", e.target.value)}
          />
          <label>{t("setCurrency")}</label>
          <input
            value={profile.currency}
            maxLength={3}
            style={{ maxWidth: 120, textTransform: "uppercase" }}
            onChange={(e) => patchField("currency", e.target.value.toUpperCase())}
          />
          <label>Logo</label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {profile.logo && (
              <img
                src={profile.logo}
                alt="Logo"
                style={{ maxHeight: 80, maxWidth: 200, borderRadius: 4 }}
              />
            )}
            <div>
              <input
                type="file"
                accept="image/*"
                disabled={busy}
                onChange={(e) => {
                  if (e.target.files?.[0]) {
                    void uploadLogo(e.target.files[0]);
                  }
                }}
                style={{ marginBottom: 8, display: "block" }}
              />
              {profile.logo && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void removeLogo()}
                >
                  Remove logo
                </button>
              )}
            </div>
          </div>
          <p className="muted">{t("setOwnerOnly")}</p>
          <button
            disabled={busy}
            onClick={() =>
              void saveProfile([
                "name",
                "legal_name",
                "kra_pin",
                "vat_number",
                "phone",
                "email",
                "postal_address",
                "physical_address",
                "currency",
              ])()
            }
          >
            {t("setSave")}
          </button>
        </div>
      )}

      {tab === "business" && profile && (
        <div className="card">
          <p className="muted">{t("setBusinessIntro")}</p>

          <label>{t("setBusinessType")}</label>
          <div className="onb-biz-chips" style={{ marginBottom: 4 }}>
            {BUSINESS_TYPES.map((b) => (
              <button
                key={b.key}
                type="button"
                className={`onb-biz-chip${profile.business_type === b.key ? " active" : ""}`}
                disabled={!canEditBusiness || busy}
                title={b.blurb}
                onClick={() => pickBusinessType(b.key)}
              >
                <span className="onb-biz-emoji">{b.emoji}</span>
                {b.label}
              </button>
            ))}
          </div>
          <p className="muted">{t("setBusinessTuneNote")}</p>

          <h3 style={{ margin: "18px 0 2px" }}>{t("setBusinessModules")}</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            {t("setBusinessModulesHint")}
          </p>
          <div className="mod-matrix">
            {OPTIONAL_MODULES.map((m) => (
              <label key={m.key} className="mod-row">
                <input
                  type="checkbox"
                  checked={profile.enabled_modules.includes(m.key)}
                  disabled={!canEditBusiness || busy}
                  onChange={() => toggleModule(m.key)}
                  style={{ width: "auto", margin: 0 }}
                />
                <span>
                  <strong>{m.label}</strong>
                  <br />
                  <span className="muted">{m.description}</span>
                </span>
              </label>
            ))}
          </div>

          {canEditBusiness ? (
            <button
              disabled={busy}
              style={{ marginTop: 16 }}
              onClick={() => void saveBusiness()}
            >
              {t("setSave")}
            </button>
          ) : (
            <p className="muted">{t("setBusinessReadOnly")}</p>
          )}
        </div>
      )}

      {tab === "branches" && (
        <>
          <div className="card">
            <p className="muted">{t("setBranchesIntro")}</p>
            {editing ? (
              <>
                <div className="row">
                  <div>
                    <label>{t("setBranchCode")}</label>
                    <input
                      value={editing.code}
                      onChange={(e) => setEditing({ ...editing, code: e.target.value })}
                    />
                  </div>
                  <div>
                    <label>{t("setBranchName")}</label>
                    <input
                      value={editing.name}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    />
                  </div>
                </div>
                <div className="row">
                  <div>
                    <label>{t("setBranchPhone")}</label>
                    <input
                      value={editing.phone ?? ""}
                      onChange={(e) => setEditing({ ...editing, phone: e.target.value })}
                    />
                  </div>
                  <div>
                    <label>{t("setBranchAddress")}</label>
                    <input
                      value={editing.address ?? ""}
                      onChange={(e) => setEditing({ ...editing, address: e.target.value })}
                    />
                  </div>
                </div>
                <button disabled={busy || !editing.code.trim() || !editing.name.trim()} onClick={() => void saveEdit()}>
                  {t("setSave")}
                </button>{" "}
                <button className="secondary" onClick={() => setEditing(null)}>
                  {t("confirmNo")}
                </button>
              </>
            ) : (
              <>
                <div className="row">
                  <div>
                    <label>{t("setBranchCode")}</label>
                    <input
                      value={bForm.code}
                      onChange={(e) => setBForm({ ...bForm, code: e.target.value })}
                    />
                  </div>
                  <div>
                    <label>{t("setBranchName")}</label>
                    <input
                      value={bForm.name}
                      onChange={(e) => setBForm({ ...bForm, name: e.target.value })}
                    />
                  </div>
                </div>
                <div className="row">
                  <div>
                    <label>{t("setBranchPhone")}</label>
                    <input
                      value={bForm.phone}
                      onChange={(e) => setBForm({ ...bForm, phone: e.target.value })}
                    />
                  </div>
                  <div>
                    <label>{t("setBranchAddress")}</label>
                    <input
                      value={bForm.address}
                      onChange={(e) => setBForm({ ...bForm, address: e.target.value })}
                    />
                  </div>
                </div>
                <button
                  disabled={busy || !bForm.code.trim() || !bForm.name.trim()}
                  onClick={() => void addBranch()}
                >
                  {t("setBranchAdd")}
                </button>
              </>
            )}
          </div>
          <DataTable
            rows={branches}
            columns={branchCols}
            searchKeys={["code", "name", "phone", "address"]}
            csvName="branches"
            empty={<p className="muted">{t("setBranchNone")}</p>}
          />
        </>
      )}

      {tab === "tax" && profile && (
        <div className="card">
          <p className="muted">{t("setTaxIntro")}</p>
          <div className="row">
            <div>
              <label>{t("setDefaultVat")}</label>
              <input
                value={profile.default_vat_rate}
                onChange={(e) => patchField("default_vat_rate", e.target.value)}
                style={{ maxWidth: 120 }}
              />
            </div>
            <div>
              <label>{t("setPaymentTerms")}</label>
              <input
                type="number"
                min={0}
                value={profile.default_payment_terms_days}
                onChange={(e) =>
                  patchField("default_payment_terms_days", Number(e.target.value))
                }
                style={{ maxWidth: 120 }}
              />
            </div>
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={profile.prices_vat_inclusive}
              onChange={(e) => patchField("prices_vat_inclusive", e.target.checked)}
              style={{ width: "auto" }}
            />
            {t("setPricesInclusive")}
          </label>
          <div className="row">
            <div>
              <label>{t("setInvoicePrefix")}</label>
              <input
                value={profile.invoice_prefix ?? ""}
                onChange={(e) => patchField("invoice_prefix", e.target.value)}
              />
              <p className="muted">
                {t("setNextInvoice")}: {profile.invoice_prefix ?? ""}
                {profile.next_invoice_no}. {t("setReadOnly")}
              </p>
            </div>
            <div>
              <label>{t("setQuotePrefix")}</label>
              <input
                value={profile.quote_prefix ?? ""}
                onChange={(e) => patchField("quote_prefix", e.target.value)}
              />
              <p className="muted">
                {t("setNextQuote")}: {profile.quote_prefix ?? ""}
                {profile.next_quote_no}. {t("setReadOnly")}
              </p>
            </div>
          </div>
          <label>{t("setFiscalYearStart")}</label>
          <select
            value={profile.fiscal_year_start_month}
            onChange={(e) =>
              patchField("fiscal_year_start_month", Number(e.target.value))
            }
            style={{ maxWidth: 200 }}
          >
            {MONTHS.map((m, idx) => (
              <option key={m} value={idx + 1}>
                {m}
              </option>
            ))}
          </select>
          <label>{t("setInvoiceFooter")}</label>
          <input
            value={profile.invoice_footer ?? ""}
            onChange={(e) => patchField("invoice_footer", e.target.value)}
          />
          <p className="muted">{t("setOwnerOnly")}</p>
          <button
            disabled={busy}
            onClick={() =>
              void saveProfile([
                "default_vat_rate",
                "default_payment_terms_days",
                "prices_vat_inclusive",
                "invoice_prefix",
                "quote_prefix",
                "fiscal_year_start_month",
                "invoice_footer",
              ])()
            }
          >
            {t("setSave")}
          </button>
        </div>
      )}

      {tab === "payments" && (
        <>
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
        </>
      )}

      {tab === "account" && (
        <>
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
          </div>
        </>
      )}
    </>
  );
}
