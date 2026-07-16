"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { BUSINESS_TYPES, presetModules } from "@/lib/modules";

/**
 * First-run guided setup, rendered as a card sequence at the top of the
 * dashboard (never a modal takeover). Shown only while the workspace has
 * no invoices; each step's "done" state is re-derived from the data
 * itself (branch/customer/item exists), so progress survives reloads and
 * devices without any local bookkeeping. A sessionStorage flag lets
 * experienced users hide it for the session.
 */

const HIDE_KEY = "jenga.onbHidden";
// Marks the "what kind of business" step complete (chosen or skipped). The DB
// column defaults to 'general', so we can't tell "picked general" from "never
// asked" — this flag carries that intent across reloads for the session.
const BIZ_KEY = "jenga.onbBizDone";

interface Counts {
  branches: number;
  customers: number;
  items: number;
}

/** First item's SKU, derived from its name so the form stays one field. */
function skuFromName(name: string): string {
  const sku = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 16);
  return sku || "ITEM-1";
}

export function Onboarding({ invoiceCount }: { invoiceCount: number }) {
  const { t } = useI18n();
  const [dismissed, setDismissed] = useState(true); // hidden until confirmed
  const [counts, setCounts] = useState<Counts | null>(null);
  const [skippedCustomer, setSkippedCustomer] = useState(false);
  const [bizDone, setBizDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [error, setError] = useState("");

  const [branchName, setBranchName] = useState("");
  const [custName, setCustName] = useState("");
  const [custPhone, setCustPhone] = useState("");
  const [itemName, setItemName] = useState("");
  const [itemPriceKes, setItemPriceKes] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    const [branches, customers, items] = await Promise.all([
      api<unknown[]>("/tenants/current/branches"),
      api<unknown[]>("/tenants/current/customers"),
      api<unknown[]>("/tenants/current/items"),
    ]);
    setCounts({
      branches: branches.length,
      customers: customers.length,
      items: items.length,
    });
  }, []);

  useEffect(() => {
    let hidden = false;
    try {
      hidden = sessionStorage.getItem(HIDE_KEY) === "1";
    } catch {
      /* private mode: show it */
    }
    setDismissed(hidden);
    try {
      setBizDone(sessionStorage.getItem(BIZ_KEY) === "1");
    } catch {
      /* private mode: ask again */
    }
    if (hidden || invoiceCount > 0) return;
    refresh().catch(() => setCounts(null)); // can't derive state → stay hidden
  }, [invoiceCount, refresh]);

  // Auto-hidden once invoices exist; also while dismissed or still loading.
  if (invoiceCount > 0 || dismissed || !counts) return null;

  const hide = (): void => {
    try {
      sessionStorage.setItem(HIDE_KEY, "1");
    } catch {
      /* in-memory only */
    }
    setDismissed(true);
  };

  const run = (fn: () => Promise<void>) => (): void => {
    setBusy(true);
    setError("");
    void (async () => {
      try {
        await fn();
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "failed");
      } finally {
        setBusy(false);
      }
    })();
  };

  const createBranch = run(async () => {
    await api("/tenants/current/branches", {
      method: "POST",
      body: { code: "HQ", name: branchName.trim() },
    });
    // A usable ledger from minute one: seed the standard chart of accounts.
    await api("/tenants/current/accounts/seed-defaults", { method: "POST" });
  });

  const createCustomer = run(async () => {
    await api("/tenants/current/customers", {
      method: "POST",
      body: {
        name: custName.trim(),
        phone: custPhone.trim() || undefined,
      },
    });
  });

  const createItem = run(async () => {
    await api("/tenants/current/items", {
      method: "POST",
      body: {
        sku: skuFromName(itemName.trim()),
        name: itemName.trim(),
        priceCents: Math.round(Number(itemPriceKes || 0) * 100),
      },
    });
  });

  // Records the choice and advances. Picking a type applies its preset of
  // optional modules; skipping leaves the workspace on the all-modules default.
  const markBizDone = (): void => {
    try {
      sessionStorage.setItem(BIZ_KEY, "1");
    } catch {
      /* in-memory only */
    }
    setBizDone(true);
  };

  const chooseBizType = (key: string): void => {
    setBusy(true);
    setError("");
    const enabledModules = presetModules(key);
    void api("/tenants/current/profile", {
      method: "PATCH",
      body: { businessType: key, enabledModules },
    })
      .then(() => {
        // Keep the sidebar cache in step so modules update without a reload.
        try {
          sessionStorage.setItem("jenga.modules", JSON.stringify(enabledModules));
        } catch {
          /* in-memory only */
        }
        markBizDone();
      })
      .catch((e) => setError(e instanceof Error ? e.message : "failed"))
      .finally(() => setBusy(false));
  };

  const loadDemo = (): void => {
    setDemoBusy(true);
    setError("");
    void api("/tenants/current/demo-data", { method: "POST" })
      .then(() => window.location.reload())
      .catch((e) => {
        setError(e instanceof Error ? e.message : "failed");
        setDemoBusy(false);
      });
  };

  const steps: { title: string; done: boolean }[] = [
    { title: t("onbStep0"), done: bizDone },
    { title: t("onbStep1"), done: counts.branches > 0 },
    { title: t("onbStep2"), done: counts.customers > 0 || skippedCustomer },
    { title: t("onbStep3"), done: counts.items > 0 },
    { title: t("onbStep4"), done: false }, // resolved by issuing an invoice
  ];
  const current = steps.findIndex((s) => !s.done);

  return (
    <div className="card">
      <div className="card-head">
        <h3>{t("onbTitle")}</h3>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            hide();
          }}
        >
          {t("onbHide")}
        </a>
      </div>
      <p className="muted" style={{ margin: "0 0 4px" }}>
        {t("onbIntro")}
      </p>
      {error && <div className="err">{error}</div>}

      {steps.map((step, idx) => {
        const isCurrent = idx === current;
        return (
          <div
            key={step.title}
            className={`onb-step ${step.done ? "done" : isCurrent ? "current" : "future"}`}
          >
            <span
              className={`onb-badge ${step.done ? "done" : isCurrent ? "current" : ""}`}
            >
              {step.done ? "✓" : idx + 1}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="onb-step-title">
                {step.title}
                {step.done && (
                  <span className="pill paid" style={{ marginLeft: 8 }}>
                    {t("onbDone")}
                  </span>
                )}
              </div>

              {isCurrent && idx === 0 && (
                <>
                  <p className="muted" style={{ margin: "2px 0 0" }}>
                    {t("onbStep0Hint")}
                  </p>
                  <div className="onb-biz-chips">
                    {BUSINESS_TYPES.map((b) => (
                      <button
                        key={b.key}
                        type="button"
                        className="onb-biz-chip"
                        disabled={busy}
                        title={b.blurb}
                        onClick={() => chooseBizType(b.key)}
                      >
                        <span className="onb-biz-emoji">{b.emoji}</span>
                        {b.label}
                      </button>
                    ))}
                  </div>
                  <p style={{ margin: "8px 0 0" }}>
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        markBizDone();
                      }}
                    >
                      {t("onbSkip")}
                    </a>
                  </p>
                </>
              )}

              {isCurrent && idx === 1 && (
                <>
                  <p className="muted" style={{ margin: "2px 0 0" }}>
                    {t("onbStep1Hint")}
                  </p>
                  <div className="row" style={{ alignItems: "flex-end" }}>
                    <div>
                      <label>{t("onbBranchName")}</label>
                      <input
                        value={branchName}
                        placeholder="Head Office"
                        onChange={(e) => setBranchName(e.target.value)}
                      />
                    </div>
                    <div style={{ flex: 0 }}>
                      <button
                        disabled={busy || !branchName.trim()}
                        onClick={createBranch}
                      >
                        {t("onbCreateBranch")}
                      </button>
                    </div>
                  </div>
                </>
              )}

              {isCurrent && idx === 2 && (
                <>
                  <p className="muted" style={{ margin: "2px 0 0" }}>
                    {t("onbStep2Hint")}
                  </p>
                  <div className="row" style={{ alignItems: "flex-end" }}>
                    <div>
                      <label>{t("onbCustomerName")}</label>
                      <input
                        value={custName}
                        onChange={(e) => setCustName(e.target.value)}
                      />
                    </div>
                    <div>
                      <label>{t("onbPhone")}</label>
                      <input
                        value={custPhone}
                        placeholder="+2547…"
                        onChange={(e) => setCustPhone(e.target.value)}
                      />
                    </div>
                    <div style={{ flex: 0 }}>
                      <button
                        disabled={busy || !custName.trim()}
                        onClick={createCustomer}
                      >
                        {t("onbAddCustomer")}
                      </button>
                    </div>
                  </div>
                  <p style={{ margin: "8px 0 0" }}>
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        setSkippedCustomer(true);
                      }}
                    >
                      {t("onbSkip")}
                    </a>
                  </p>
                </>
              )}

              {isCurrent && idx === 3 && (
                <>
                  <p className="muted" style={{ margin: "2px 0 0" }}>
                    {t("onbStep3Hint")}
                  </p>
                  <div className="row" style={{ alignItems: "flex-end" }}>
                    <div>
                      <label>{t("onbItemName")}</label>
                      <input
                        value={itemName}
                        onChange={(e) => setItemName(e.target.value)}
                      />
                    </div>
                    <div>
                      <label>{t("onbItemPrice")}</label>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={itemPriceKes}
                        onChange={(e) => setItemPriceKes(e.target.value)}
                      />
                    </div>
                    <div style={{ flex: 0 }}>
                      <button
                        disabled={busy || !itemName.trim() || !itemPriceKes}
                        onClick={createItem}
                      >
                        {t("onbAddItem")}
                      </button>
                    </div>
                  </div>
                </>
              )}

              {isCurrent && idx === 4 && (
                <>
                  <p className="muted" style={{ margin: "2px 0 0" }}>
                    {t("onbStep4Hint")}
                  </p>
                  {demoBusy ? (
                    <div style={{ marginTop: 10 }}>
                      <p className="muted" style={{ margin: "0 0 8px" }}>
                        {t("onbDemoLoading")}
                      </p>
                      <span className="skel" style={{ height: 10 }} />
                    </div>
                  ) : (
                    <div className="onb-paths">
                      <Link href="/invoices/new" className="onb-path">
                        <span className="onb-path-icon">🧾</span>
                        {t("onbPathInvoice")}
                      </Link>
                      <Link href="/pos" className="onb-path">
                        <span className="onb-path-icon">🛒</span>
                        {t("onbPathPos")}
                      </Link>
                      <button
                        type="button"
                        className="onb-path"
                        disabled={demoBusy}
                        onClick={loadDemo}
                      >
                        <span className="onb-path-icon">✨</span>
                        {t("onbPathDemo")}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
