"use client";

import { useCallback, useEffect, useState } from "react";
import { api, fmtKes } from "@/lib/api";

interface SalesReport {
  period: string;
  groupBy: string;
  rows: Record<string, string | number>[];
  totals: { net: string; vat: string; gross: string; invoices: number };
}
interface StatementRow {
  code: string;
  name: string;
  type: string;
  amount_cents: string;
}
interface Pnl {
  from: string;
  to: string;
  income: StatementRow[];
  expenses: StatementRow[];
  totalIncomeCents: number;
  totalExpensesCents: number;
  netProfitCents: number;
}
interface BalanceSheet {
  asOf: string;
  assets: StatementRow[];
  liabilities: StatementRow[];
  equity: StatementRow[];
  retainedEarningsCents: number;
  totalAssetsCents: number;
  totalLiabilitiesCents: number;
  totalEquityCents: number;
}
interface TrialRow {
  code: string;
  name: string;
  type: string;
  balanceCents: number;
}
interface LedgerRow {
  entry_no: string;
  entry_date: string;
  memo: string;
  source_type: string;
  debit_cents: string;
  credit_cents: string;
  running_cents: string;
}

type Tab = "pnl" | "balance" | "trial" | "sales";

function downloadCsv(filename: string, rows: (string | number)[][]): void {
  const csv = rows
    .map((r) =>
      r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","),
    )
    .join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const monthStart = (): string =>
  `${new Date().toISOString().slice(0, 7)}-01`;
const today = (): string => new Date().toISOString().slice(0, 10);

export default function ReportsPage() {
  const [tab, setTab] = useState<Tab>("pnl");
  const [error, setError] = useState("");

  // P&L
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [pnl, setPnl] = useState<Pnl | null>(null);
  // Balance sheet
  const [asOf, setAsOf] = useState(today());
  const [bs, setBs] = useState<BalanceSheet | null>(null);
  // Trial balance + drill-down
  const [trial, setTrial] = useState<TrialRow[]>([]);
  const [drill, setDrill] = useState<{
    account: TrialRow;
    rows: LedgerRow[];
  } | null>(null);
  // Sales
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [groupBy, setGroupBy] = useState<"day" | "customer" | "item">("day");
  const [sales, setSales] = useState<SalesReport | null>(null);

  const loadPnl = useCallback(async (f: string, t: string) => {
    setError("");
    try {
      setPnl(await api<Pnl>(`/tenants/current/reports/pnl?from=${f}&to=${t}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }, []);

  const loadBs = useCallback(async (d: string) => {
    setError("");
    try {
      setBs(
        await api<BalanceSheet>(
          `/tenants/current/reports/balance-sheet?asOf=${d}`,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }, []);

  const loadTrial = useCallback(async () => {
    setError("");
    try {
      setTrial(
        await api<TrialRow[]>("/tenants/current/accounts/trial-balance"),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }, []);

  const loadSales = useCallback(async (p: string, g: string) => {
    setError("");
    try {
      setSales(
        await api<SalesReport>(
          `/tenants/current/reports/sales?period=${p}&groupBy=${g}`,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }, []);

  const openDrill = async (account: TrialRow): Promise<void> => {
    try {
      const rows = await api<LedgerRow[]>(
        `/tenants/current/reports/ledger?code=${account.code}&from=2000-01-01&to=${today()}`,
      );
      setDrill({ account, rows });
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  };

  useEffect(() => {
    void loadPnl(from, to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchTab = (next: Tab): void => {
    setTab(next);
    setDrill(null);
    if (next === "pnl" && !pnl) void loadPnl(from, to);
    if (next === "balance" && !bs) void loadBs(asOf);
    if (next === "trial" && trial.length === 0) void loadTrial();
    if (next === "sales" && !sales) void loadSales(period, groupBy);
  };

  const stmtTable = (
    title: string,
    rows: StatementRow[],
    totalCents: number,
  ) => (
    <>
      <h2>{title}</h2>
      <table>
        <tbody>
          {rows.map((r) => (
            <tr key={r.code}>
              <td>
                <span className="muted">{r.code}</span> {r.name}
              </td>
              <td style={{ textAlign: "right" }}>{fmtKes(r.amount_cents)}</td>
            </tr>
          ))}
          <tr>
            <td>
              <strong>Total</strong>
            </td>
            <td style={{ textAlign: "right" }}>
              <strong>{fmtKes(totalCents)}</strong>
            </td>
          </tr>
        </tbody>
      </table>
    </>
  );

  return (
    <>
      <h1>Reports</h1>
      <div className="tabs">
        {(
          [
            ["pnl", "Profit & Loss"],
            ["balance", "Balance sheet"],
            ["trial", "Trial balance"],
            ["sales", "Sales"],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={tab === key ? "tab active" : "tab"}
            onClick={() => switchTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <div className="err">{error}</div>}

      {tab === "pnl" && (
        <>
          <div className="card">
            <div className="row">
              <div>
                <label>From</label>
                <input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </div>
              <div>
                <label>To</label>
                <input
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </div>
            </div>
            <button onClick={() => void loadPnl(from, to)}>Run</button>{" "}
            {pnl && (
              <button
                className="secondary"
                onClick={() =>
                  downloadCsv(`pnl-${pnl.from}-${pnl.to}.csv`, [
                    ["Account", "Amount KES"],
                    ...pnl.income.map((r) => [
                      `${r.code} ${r.name}`,
                      Number(r.amount_cents) / 100,
                    ]),
                    ["Total income", pnl.totalIncomeCents / 100],
                    ...pnl.expenses.map((r) => [
                      `${r.code} ${r.name}`,
                      Number(r.amount_cents) / 100,
                    ]),
                    ["Total expenses", pnl.totalExpensesCents / 100],
                    ["Net profit", pnl.netProfitCents / 100],
                  ])
                }
              >
                Export CSV
              </button>
            )}
          </div>
          {pnl && (
            <div className="card">
              {stmtTable("Income", pnl.income, pnl.totalIncomeCents)}
              {stmtTable("Expenses", pnl.expenses, pnl.totalExpensesCents)}
              <h2>
                Net profit:{" "}
                <span className={pnl.netProfitCents < 0 ? "err" : ""}>
                  {fmtKes(pnl.netProfitCents)}
                </span>
              </h2>
            </div>
          )}
        </>
      )}

      {tab === "balance" && (
        <>
          <div className="card">
            <label>As of</label>
            <input
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              style={{ maxWidth: 220 }}
            />
            <br />
            <button onClick={() => void loadBs(asOf)}>Run</button>
          </div>
          {bs && (
            <div className="card">
              {stmtTable("Assets", bs.assets, bs.totalAssetsCents)}
              {stmtTable(
                "Liabilities",
                bs.liabilities,
                bs.totalLiabilitiesCents,
              )}
              <h2>Equity</h2>
              <table>
                <tbody>
                  {bs.equity.map((r) => (
                    <tr key={r.code}>
                      <td>
                        <span className="muted">{r.code}</span> {r.name}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        {fmtKes(r.amount_cents)}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td>Retained earnings</td>
                    <td style={{ textAlign: "right" }}>
                      {fmtKes(bs.retainedEarningsCents)}
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <strong>Total equity</strong>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <strong>{fmtKes(bs.totalEquityCents)}</strong>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="muted">
                Assets {fmtKes(bs.totalAssetsCents)} = Liabilities{" "}
                {fmtKes(bs.totalLiabilitiesCents)} + Equity{" "}
                {fmtKes(bs.totalEquityCents)}
              </p>
            </div>
          )}
        </>
      )}

      {tab === "trial" &&
        (drill ? (
          <>
            <p>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setDrill(null);
                }}
              >
                ← Trial balance
              </a>
            </p>
            <h2>
              {drill.account.code} {drill.account.name} — ledger
            </h2>
            <div className="card">
              {drill.rows.length === 0 ? (
                <p className="muted">No entries.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>No.</th>
                      <th>Memo</th>
                      <th>Debit</th>
                      <th>Credit</th>
                      <th>Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drill.rows.map((r, i) => (
                      <tr key={i}>
                        <td>{r.entry_date?.slice(0, 10)}</td>
                        <td>{r.entry_no}</td>
                        <td>
                          {r.memo || (
                            <span className="muted">{r.source_type}</span>
                          )}
                        </td>
                        <td>
                          {Number(r.debit_cents) > 0
                            ? fmtKes(r.debit_cents)
                            : ""}
                        </td>
                        <td>
                          {Number(r.credit_cents) > 0
                            ? fmtKes(r.credit_cents)
                            : ""}
                        </td>
                        <td>{fmtKes(r.running_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        ) : (
          <div className="card">
            <p className="muted">
              Debit-positive balances. Click an account to see every journal
              entry behind it.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Account</th>
                  <th>Type</th>
                  <th style={{ textAlign: "right" }}>Balance</th>
                </tr>
              </thead>
              <tbody>
                {trial.map((r) => (
                  <tr key={r.code}>
                    <td>{r.code}</td>
                    <td>
                      <a
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          void openDrill(r);
                        }}
                      >
                        {r.name}
                      </a>
                    </td>
                    <td className="muted">{r.type}</td>
                    <td style={{ textAlign: "right" }}>
                      {fmtKes(r.balanceCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {tab === "sales" && (
        <>
          <div className="card">
            <div className="row">
              <div>
                <label>Period</label>
                <input
                  type="month"
                  value={period}
                  onChange={(e) => setPeriod(e.target.value)}
                />
              </div>
              <div>
                <label>Group by</label>
                <select
                  value={groupBy}
                  onChange={(e) =>
                    setGroupBy(e.target.value as typeof groupBy)
                  }
                >
                  <option value="day">Day</option>
                  <option value="customer">Customer</option>
                  <option value="item">Item</option>
                </select>
              </div>
            </div>
            <button onClick={() => void loadSales(period, groupBy)}>
              Run report
            </button>
          </div>
          {sales && (
            <>
              <div className="row">
                <div className="card">
                  <span className="muted">Net sales</span>
                  <div className="stat">{fmtKes(sales.totals.net)}</div>
                </div>
                <div className="card">
                  <span className="muted">VAT</span>
                  <div className="stat">{fmtKes(sales.totals.vat)}</div>
                </div>
                <div className="card">
                  <span className="muted">Invoices</span>
                  <div className="stat">{sales.totals.invoices}</div>
                </div>
              </div>
              <div className="card">
                {sales.rows.length === 0 ? (
                  <p className="muted">No sales in this period.</p>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>
                          {groupBy === "day"
                            ? "Date"
                            : groupBy === "customer"
                              ? "Customer"
                              : "Item"}
                        </th>
                        {groupBy === "item" ? <th>Qty</th> : <th>Invoices</th>}
                        <th>Net</th>
                        <th>VAT</th>
                        {groupBy === "customer" && <th>Outstanding</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {sales.rows.map((r, i) => (
                        <tr key={i}>
                          <td>{String(r.label)}</td>
                          <td>
                            {groupBy === "item"
                              ? Number(r.quantity)
                              : Number(r.invoices)}
                          </td>
                          <td>{fmtKes(r.net_cents as string)}</td>
                          <td>{fmtKes(r.vat_cents as string)}</td>
                          {groupBy === "customer" && (
                            <td>{fmtKes(r.outstanding_cents as string)}</td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
