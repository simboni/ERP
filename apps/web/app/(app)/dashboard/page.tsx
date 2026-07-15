"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, fmtKes, getTenantToken } from "@/lib/api";
import { BarChart } from "@/components/BarChart";
import { useI18n } from "@/lib/i18n";

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
interface Deadline {
  key: string;
  label: string;
  dueDate: string;
  daysRemaining: number;
  overdue: boolean;
}
interface MonthRow {
  month: string;
  revenue_cents: string;
  expense_cents: string;
}
interface OverdueRow {
  id: string;
  invoice_no: string | null;
  due_date: string;
  outstanding_cents: string;
  customer_name: string;
  days_overdue: number;
}
interface StockRow {
  id: string;
  sku: string;
  name: string;
  qty: string;
}
interface Summary {
  months: MonthRow[];
  arAging: Record<string, number>;
  overdueInvoices: OverdueRow[];
  outOfStock: StockRow[];
}

const AGING_LABELS: [string, string][] = [
  ["current", "Current"],
  ["d1_30", "1–30 days"],
  ["d31_60", "31–60"],
  ["d61_90", "61–90"],
  ["d90_plus", "90+"],
];

export default function Dashboard() {
  const router = useRouter();
  const { t } = useI18n();
  const [tb, setTb] = useState<TrialRow[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [deadlines, setDeadlines] = useState<Deadline[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async (): Promise<void> => {
    try {
      const [balances, inv, dl, sum] = await Promise.all([
        api<TrialRow[]>("/tenants/current/accounts/trial-balance"),
        api<InvoiceRow[]>("/tenants/current/invoices"),
        api<Deadline[]>("/tenants/current/compliance/deadlines"),
        api<Summary>("/tenants/current/dashboard"),
      ]);
      setTb(balances);
      setInvoices(inv);
      setDeadlines(dl);
      setSummary(sum);
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
  const thisMonth = summary?.months[summary.months.length - 1];
  const chartData = (summary?.months ?? []).map((m) => ({
    label: m.month.slice(2),
    a: Number(m.revenue_cents),
    b: Number(m.expense_cents),
  }));
  const agingTotal = Object.values(summary?.arAging ?? {}).reduce(
    (s, v) => s + v,
    0,
  );

  return (
    <>
      <h1>{t("navDashboard")}</h1>
      {error && <div className="err">{error}</div>}

      <div className="quick-actions">
        <Link href="/invoices/new">
          <button type="button">{t("newInvoice")}</button>
        </Link>
        <Link href="/quotes">
          <button type="button" className="secondary">
            {t("navQuotes")}
          </button>
        </Link>
        <Link href="/purchases">
          <button type="button" className="secondary">
            {t("purchases")}
          </button>
        </Link>
      </div>

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
          <span className="muted">Revenue ({thisMonth?.month ?? "…"})</span>
          <div className="stat">
            {thisMonth ? fmtKes(thisMonth.revenue_cents) : "…"}
          </div>
        </div>
        <div className="card">
          <span className="muted">{t("vatDue")}</span>
          <div className="stat">{fmtKes(vatDue)}</div>
        </div>
      </div>

      <div className="card">
        <span className="muted">Revenue vs expenses — last 6 months</span>
        {chartData.length > 0 ? (
          <BarChart
            data={chartData}
            seriesA="Revenue"
            seriesB="Expenses"
            format={(v) => fmtKes(v)}
          />
        ) : (
          <p className="muted">Loading…</p>
        )}
      </div>

      <div className="row">
        <div className="card">
          <span className="muted">Receivables aging</span>
          {agingTotal === 0 ? (
            <p className="muted">Nothing outstanding — great.</p>
          ) : (
            <table>
              <tbody>
                {AGING_LABELS.map(([key, label]) => {
                  const v = summary?.arAging[key] ?? 0;
                  return (
                    <tr key={key}>
                      <td>{label}</td>
                      <td style={{ textAlign: "right" }}>
                        {v > 0 ? fmtKes(v) : <span className="muted">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="card">
          <span className="muted">Overdue invoices</span>
          {(summary?.overdueInvoices ?? []).length === 0 ? (
            <p className="muted">None overdue.</p>
          ) : (
            <table>
              <tbody>
                {summary!.overdueInvoices.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link href={`/invoices/view?id=${o.id}`}>
                        {o.invoice_no ?? "draft"}
                      </Link>
                      <br />
                      <span className="muted">{o.customer_name}</span>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {fmtKes(o.outstanding_cents)}
                      <br />
                      <span className="err">{o.days_overdue}d late</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {(summary?.outOfStock ?? []).length > 0 && (
        <div className="card">
          <span className="muted">Out of stock</span>
          <table>
            <tbody>
              {summary!.outOfStock.map((s) => (
                <tr key={s.id}>
                  <td>
                    {s.name} <span className="muted">({s.sku})</span>
                  </td>
                  <td style={{ textAlign: "right" }}>{Number(s.qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
        Recent {t("invoices").toLowerCase()}{" "}
        <Link href="/invoices" style={{ fontSize: "0.9rem" }}>
          view all
        </Link>
      </h2>
      <div className="card">
        {invoices.length === 0 ? (
          <p className="muted">{t("noInvoices")}</p>
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
              {invoices.slice(0, 5).map((i) => (
                <tr key={i.id}>
                  <td>
                    <Link href={`/invoices/view?id=${i.id}`}>
                      {i.invoice_no ?? "draft"}
                    </Link>
                  </td>
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
