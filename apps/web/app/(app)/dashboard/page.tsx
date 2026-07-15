"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, fmtKes, fmtKes0, getTenantToken } from "@/lib/api";
import { BarChart } from "@/components/BarChart";
import { Icons } from "@/components/AppShell";
import { Onboarding } from "@/components/Onboarding";
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

const AGING: { key: string; label: string; color: string }[] = [
  { key: "current", label: "Current", color: "var(--ok)" },
  { key: "d1_30", label: "1–30 days", color: "var(--info)" },
  { key: "d31_60", label: "31–60", color: "var(--warn)" },
  { key: "d61_90", label: "61–90", color: "#c2334d" },
  { key: "d90_plus", label: "90+", color: "var(--danger)" },
];

const AVATAR_COLORS = ["#2b62c4", "#6d3fc0", "#0b6b38", "#c2334d", "#8a5a00"];

const monthName = (ym: string): string =>
  new Date(`${ym}-15`).toLocaleString("en", { month: "short" });

export default function Dashboard() {
  const router = useRouter();
  const { t } = useI18n();
  const [tb, setTb] = useState<TrialRow[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [deadlines, setDeadlines] = useState<Deadline[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

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
    } finally {
      setLoading(false);
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
  const months = summary?.months ?? [];
  const thisMonth = months[months.length - 1];
  const prevMonth = months[months.length - 2];
  const revNow = Number(thisMonth?.revenue_cents ?? 0);
  const revPrev = Number(prevMonth?.revenue_cents ?? 0);
  const revDelta =
    revPrev > 0 ? Math.round(((revNow - revPrev) / revPrev) * 100) : null;
  const chartData = months.map((m) => ({
    label: monthName(m.month),
    a: Number(m.revenue_cents),
    b: Number(m.expense_cents),
  }));
  const aging = summary?.arAging ?? {};
  const agingTotal = Object.values(aging).reduce((s, v) => s + v, 0);

  const tiles = [
    { cls: "tile-4", icon: Icons.payment, value: fmtKes0(cash), label: t("cash") },
    { cls: "tile-3", icon: Icons.invoice, value: fmtKes0(receivable), label: t("owed") },
    {
      cls: "tile-2",
      icon: Icons.chart,
      value: fmtKes0(revNow),
      label: `Revenue · ${thisMonth ? monthName(thisMonth.month) : "…"}`,
      delta: revDelta,
    },
    { cls: "tile-1", icon: Icons.shield, value: fmtKes0(vatDue), label: t("vatDue") },
  ];

  return (
    <>
      <h1>{t("navDashboard")}</h1>
      {error && <div className="err">{error}</div>}

      {/* First-run wizard: only a brand-new workspace (no invoices) sees it. */}
      {!loading && !error && <Onboarding invoiceCount={invoices.length} />}

      {loading ? (
        <div className="tiles">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="tile" style={{ background: "var(--card)" }}>
              <span className="skel" style={{ width: "60%", height: 24 }} />
              <span className="skel" style={{ width: "40%", marginTop: 10 }} />
            </div>
          ))}
        </div>
      ) : (
        <div className="tiles">
          {tiles.map((tile) => (
            <div key={tile.label} className={`tile ${tile.cls}`}>
              <div className="tile-value">{tile.value}</div>
              <div className="tile-label">
                {tile.label}
                {tile.delta !== null && tile.delta !== undefined && (
                  <span className={`stat-delta ${tile.delta >= 0 ? "up" : "down"}`}>
                    {tile.delta >= 0 ? "▲" : "▼"} {Math.abs(tile.delta)}%
                  </span>
                )}
              </div>
              <span className="tile-icon">{tile.icon}</span>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>Revenue vs expenses</h3>
          <a href="/reports">Reports →</a>
        </div>
        {chartData.length > 0 ? (
          <BarChart
            data={chartData}
            seriesA="Revenue"
            seriesB="Expenses"
            format={(v) => fmtKes(v)}
          />
        ) : (
          <span className="skel" style={{ height: 180 }} />
        )}
      </div>

      <div className="row">
        <div className="card">
          <div className="card-head">
            <h3>Receivables aging</h3>
            <a href="/invoices">{t("invoices")} →</a>
          </div>
          {agingTotal === 0 ? (
            <div className="empty">
              <span className="empty-icon">🎉</span>
              <p>Nothing outstanding.</p>
            </div>
          ) : (
            AGING.map(({ key, label, color }) => {
              const v = aging[key] ?? 0;
              return (
                <div key={key} className="bar-row">
                  <span className="bar-label">{label}</span>
                  <span className="bar-track">
                    <span
                      className="bar-fill"
                      style={{
                        width: `${Math.max(v > 0 ? 3 : 0, (v / agingTotal) * 100)}%`,
                        background: color,
                      }}
                    />
                  </span>
                  <span className="bar-amt">
                    {v > 0 ? fmtKes(v) : <span className="muted">—</span>}
                  </span>
                </div>
              );
            })
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h3>Overdue invoices</h3>
          </div>
          {(summary?.overdueInvoices ?? []).length === 0 ? (
            <div className="empty">
              <span className="empty-icon">✅</span>
              <p>None overdue.</p>
            </div>
          ) : (
            summary!.overdueInvoices.map((o, i) => (
              <div
                key={o.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "8px 0",
                  borderBottom:
                    i === summary!.overdueInvoices.length - 1
                      ? "none"
                      : "1px solid var(--line-soft)",
                }}
              >
                <span
                  className="dot-avatar"
                  style={{ background: AVATAR_COLORS[i % AVATAR_COLORS.length] }}
                >
                  {o.customer_name
                    .split(/\s+/)
                    .slice(0, 2)
                    .map((w) => w[0])
                    .join("")
                    .toUpperCase()}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <Link href={`/invoices/view?id=${o.id}`}>
                    #{o.invoice_no ?? "draft"}
                  </Link>
                  <br />
                  <span
                    className="muted"
                    style={{
                      display: "block",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {o.customer_name}
                  </span>
                </span>
                <span style={{ textAlign: "right" }}>
                  <span className="kes" style={{ fontWeight: 650 }}>
                    {fmtKes(o.outstanding_cents)}
                  </span>
                  <br />
                  <span className="pill overdue">{o.days_overdue}d late</span>
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {(summary?.outOfStock ?? []).length > 0 && (
        <div className="card">
          <div className="card-head">
            <h3>Out of stock</h3>
            <a href="/inventory">{t("navInventory")} →</a>
          </div>
          <table>
            <tbody>
              {summary!.outOfStock.map((s) => (
                <tr key={s.id}>
                  <td>
                    {s.name} <span className="muted">({s.sku})</span>
                  </td>
                  <td className="num">{Number(s.qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {deadlines.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h3>{t("deadlines")}</h3>
            <a href="/vat">{t("vat")} →</a>
          </div>
          {deadlines.slice(0, 3).map((d) => (
            <div key={d.key} className="bar-row">
              <span style={{ flex: 1 }}>{d.label}</span>
              <strong className="kes">{d.dueDate}</strong>
              <span
                className={`pill ${d.overdue ? "overdue" : d.daysRemaining <= 5 ? "pending" : "sent"}`}
              >
                {d.overdue ? t("overdue") : `${d.daysRemaining} ${t("days")}`}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>Recent {t("invoices").toLowerCase()}</h3>
          <Link href="/invoices">View all →</Link>
        </div>
        {invoices.length === 0 ? (
          <div className="empty">
            <span className="empty-icon">🧾</span>
            <p>{t("noInvoices")}</p>
            <Link href="/invoices/new">
              <button type="button">{t("newInvoice")}</button>
            </Link>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>No.</th>
                <th>{t("customer")}</th>
                <th className="num">{t("total")}</th>
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
                  <td className="num">{fmtKes(i.total_cents)}</td>
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
