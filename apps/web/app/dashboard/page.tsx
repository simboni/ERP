"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, clearTokens, fmtKes, getTenantToken } from "@/lib/api";
import { LangToggle, useI18n } from "@/lib/i18n";

interface TrialRow {
  code: string;
  name: string;
  type: string;
  balanceCents: number;
}
interface InvoiceRow {
  id: string;
  invoice_no: string | null;
  status: string;
  total_cents: string;
  customer_name: string;
  fiscal_status: string | null;
  control_number: string | null;
}
interface Tenant {
  name: string;
}
interface Deadline {
  key: string;
  label: string;
  dueDate: string;
  daysRemaining: number;
  overdue: boolean;
}

export default function Dashboard() {
  const router = useRouter();
  const { t } = useI18n();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [tb, setTb] = useState<TrialRow[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [deadlines, setDeadlines] = useState<Deadline[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async (): Promise<void> => {
    try {
      const [t, balances, inv, dl] = await Promise.all([
        api<Tenant>("/tenants/current"),
        api<TrialRow[]>("/tenants/current/accounts/trial-balance"),
        api<InvoiceRow[]>("/tenants/current/invoices"),
        api<Deadline[]>("/tenants/current/compliance/deadlines"),
      ]);
      setTenant(t);
      setTb(balances);
      setInvoices(inv);
      setDeadlines(dl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    if (!getTenantToken()) {
      router.replace("/");
      return;
    }
    void load();
  }, [load, router]);

  const bal = (code: string): number =>
    tb.find((a) => a.code === code)?.balanceCents ?? 0;
  const cash = bal("1000") + bal("1010") + bal("1020");
  const receivable = bal("1100");
  const vatDue = -bal("2200");

  return (
    <>
      <div className="row" style={{ alignItems: "baseline" }}>
        <h1>{tenant?.name ?? "…"}</h1>
        <span className="muted" style={{ textAlign: "right" }}>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              clearTokens();
              router.replace("/");
            }}
          >
            {t("signOut")}
          </a>
        </span>
      </div>
      {error && <div className="err">{error}</div>}

      <div className="row">
        <div className="card">
          <span className="muted">{t("cash")}</span>
          <div className="stat">{fmtKes(cash)}</div>
        </div>
        <div className="card">
          <span className="muted">{t("owed")}</span>
          <div className="stat">{fmtKes(receivable)}</div>
        </div>
        <div className="card">
          <span className="muted">{t("vatDue")}</span>
          <div className="stat">{fmtKes(vatDue)}</div>
        </div>
      </div>

      <p>
        <Link href="/payments">{t("payments")}</Link> ·{" "}
        <Link href="/payroll">{t("payroll")}</Link> ·{" "}
        <Link href="/purchases">{t("purchases")}</Link> ·{" "}
        <Link href="/vat">{t("vat")}</Link> ·{" "}
        <Link href="/quotes">Quotes</Link> ·{" "}
        <Link href="/inventory">Inventory</Link> ·{" "}
        <Link href="/reports">Reports</Link> ·{" "}
        <Link href="/settings">Settings</Link> · <LangToggle />
      </p>

      {deadlines.length > 0 && (
        <div className="card">
          <span className="muted">{t("deadlines")}</span>
          {deadlines.slice(0, 3).map((d) => (
            <div key={d.key}>
              {d.label} — <strong>{d.dueDate}</strong>{" "}
              <span className={d.daysRemaining <= 5 ? "err" : "muted"}>
                ({d.overdue ? t("overdue") : `${d.daysRemaining} ${t("days")}`})
              </span>
            </div>
          ))}
        </div>
      )}

      <h2>
        {t("invoices")}{" "}
        <Link href="/invoices/new" style={{ fontSize: "0.9rem" }}>
          {t("newInvoice")}
        </Link>
      </h2>
      <div className="card">
        {invoices.length === 0 ? (
          <p className="muted">
            {t("noInvoices")}
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>No.</th>
                <th>{t("customer")}</th>
                <th>{t("total")}</th>
                <th>{t("status")}</th>
                <th>eTIMS</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id}>
                  <td><Link href={`/invoices/${i.id}`}>{i.invoice_no ?? "draft"}</Link></td>
                  <td>{i.customer_name}</td>
                  <td>{fmtKes(i.total_cents)}</td>
                  <td>
                    <span className={`pill ${i.status}`}>{i.status}</span>
                  </td>
                  <td>
                    {i.fiscal_status ? (
                      <span className={`pill ${i.fiscal_status}`}>
                        {i.fiscal_status === "signed"
                          ? (i.control_number ?? "signed")
                          : i.fiscal_status}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
