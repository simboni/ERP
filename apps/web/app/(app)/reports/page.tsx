"use client";

import { useCallback, useEffect, useState } from "react";
import { api, fmtKes } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { SearchSelect, type SelectOption } from "@/components/SearchSelect";

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

interface Buckets {
  d0_30: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
  total: number;
}
interface AgedRow extends Record<string, string | number> {
  d0_30: string;
  d31_60: string;
  d61_90: string;
  d90_plus: string;
  total: string;
}
interface Aged {
  rows: (AgedRow & { customer_name?: string; supplier_name?: string })[];
  totals: Buckets;
}
interface StatementLine {
  d: string;
  kind: string;
  ref: string;
  description: string;
  charge_cents: number;
  payment_cents: number;
  balance_cents: number;
}
interface CustomerStatement {
  customerName: string;
  from: string;
  to: string;
  openingBalanceCents: number;
  rows: StatementLine[];
  totalChargedCents: number;
  totalPaidCents: number;
  closingBalanceCents: number;
}
interface InvValRow {
  item_id: string;
  sku: string;
  name: string;
  unit: string;
  cost_cents: number;
  on_hand: number;
  value_cents: number;
  reorder_level: number;
  low_stock: boolean;
}
interface InvVal {
  rows: InvValRow[];
  totals: { items: number; value_cents: number; low_stock: number };
}
interface ExpenseRow {
  code: string;
  name: string;
  amount_cents: string;
  entries: number;
}
interface ExpenseReport {
  from: string;
  to: string;
  rows: ExpenseRow[];
  totalCents: number;
}
interface RailRow {
  rail_group: string;
  count: number;
  total_cents: string;
}
interface PaymentsReceived {
  from: string;
  to: string;
  rows: RailRow[];
  totals: { count: number; total_cents: number };
}
interface VatRow {
  period: string;
  output_vat_cents: string;
  input_vat_cents: string;
  net_cents: string;
}
interface VatSummary {
  from: string;
  to: string;
  rows: VatRow[];
  totals: { output_vat_cents: number; input_vat_cents: number; net_cents: number };
}

type Tab =
  | "pnl"
  | "balance"
  | "trial"
  | "expenses"
  | "vat"
  | "sales"
  | "aged_recv"
  | "aged_pay"
  | "statement"
  | "payments"
  | "inventory";
type Group = "financial" | "operational";

const GROUP_OF: Record<Tab, Group> = {
  pnl: "financial",
  balance: "financial",
  trial: "financial",
  expenses: "financial",
  vat: "financial",
  sales: "operational",
  aged_recv: "operational",
  aged_pay: "operational",
  statement: "operational",
  payments: "operational",
  inventory: "operational",
};

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
const monthsAgoDate = (n: number): string => {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
};
const monthsAgoPeriod = (n: number): string => {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 7);
};
const railLabel = (rail: string, tr: (k: string) => string): string =>
  rail === "cash"
    ? tr("rptCash")
    : rail === "bank"
      ? tr("rptBank")
      : tr("rptMpesa");

export default function ReportsPage() {
  const { t } = useI18n();
  const tr = t as (k: string) => string;
  const [group, setGroup] = useState<Group>("financial");
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
  // Aged receivables / payables
  const [agedRecv, setAgedRecv] = useState<Aged | null>(null);
  const [agedPay, setAgedPay] = useState<Aged | null>(null);
  // Customer statement
  const [customers, setCustomers] = useState<SelectOption[]>([]);
  const [stmtCustomer, setStmtCustomer] = useState("");
  const [stmtFrom, setStmtFrom] = useState(monthsAgoDate(6));
  const [stmtTo, setStmtTo] = useState(today());
  const [statement, setStatement] = useState<CustomerStatement | null>(null);
  // Inventory valuation
  const [invVal, setInvVal] = useState<InvVal | null>(null);
  // Expense report
  const [expFrom, setExpFrom] = useState(monthStart());
  const [expTo, setExpTo] = useState(today());
  const [expenses, setExpenses] = useState<ExpenseReport | null>(null);
  // Payments received
  const [payFrom, setPayFrom] = useState(monthStart());
  const [payTo, setPayTo] = useState(today());
  const [payments, setPayments] = useState<PaymentsReceived | null>(null);
  // VAT summary
  const [vatFrom, setVatFrom] = useState(monthsAgoPeriod(5));
  const [vatTo, setVatTo] = useState(new Date().toISOString().slice(0, 7));
  const [vat, setVat] = useState<VatSummary | null>(null);

  const guard = async (fn: () => Promise<void>): Promise<void> => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  };

  const loadPnl = useCallback(async (f: string, tt: string) => {
    await guard(async () =>
      setPnl(await api<Pnl>(`/tenants/current/reports/pnl?from=${f}&to=${tt}`)),
    );
  }, []);
  const loadBs = useCallback(async (d: string) => {
    await guard(async () =>
      setBs(await api<BalanceSheet>(`/tenants/current/reports/balance-sheet?asOf=${d}`)),
    );
  }, []);
  const loadTrial = useCallback(async () => {
    await guard(async () =>
      setTrial(await api<TrialRow[]>("/tenants/current/accounts/trial-balance")),
    );
  }, []);
  const loadSales = useCallback(async (p: string, g: string) => {
    await guard(async () =>
      setSales(
        await api<SalesReport>(
          `/tenants/current/reports/sales?period=${p}&groupBy=${g}`,
        ),
      ),
    );
  }, []);
  const loadAgedRecv = useCallback(async () => {
    await guard(async () =>
      setAgedRecv(await api<Aged>("/tenants/current/reports/aged-receivables")),
    );
  }, []);
  const loadAgedPay = useCallback(async () => {
    await guard(async () =>
      setAgedPay(await api<Aged>("/tenants/current/reports/aged-payables")),
    );
  }, []);
  const loadCustomers = useCallback(async () => {
    await guard(async () => {
      const list = await api<{ id: string; name: string; phone?: string }[]>(
        "/tenants/current/customers",
      );
      setCustomers(
        list.map((c) => ({ id: c.id, label: c.name, sub: c.phone ?? undefined })),
      );
    });
  }, []);
  const loadStatement = useCallback(
    async (cid: string, f: string, tt: string) => {
      if (!cid) return;
      await guard(async () =>
        setStatement(
          await api<CustomerStatement>(
            `/tenants/current/reports/customer-statement?customerId=${cid}&from=${f}&to=${tt}`,
          ),
        ),
      );
    },
    [],
  );
  const loadInvVal = useCallback(async () => {
    await guard(async () =>
      setInvVal(await api<InvVal>("/tenants/current/reports/inventory-valuation")),
    );
  }, []);
  const loadExpenses = useCallback(async (f: string, tt: string) => {
    await guard(async () =>
      setExpenses(
        await api<ExpenseReport>(
          `/tenants/current/reports/expenses?from=${f}&to=${tt}`,
        ),
      ),
    );
  }, []);
  const loadPayments = useCallback(async (f: string, tt: string) => {
    await guard(async () =>
      setPayments(
        await api<PaymentsReceived>(
          `/tenants/current/reports/payments-received?from=${f}&to=${tt}`,
        ),
      ),
    );
  }, []);
  const loadVat = useCallback(async (f: string, tt: string) => {
    await guard(async () =>
      setVat(
        await api<VatSummary>(
          `/tenants/current/reports/vat-summary?from=${f}&to=${tt}`,
        ),
      ),
    );
  }, []);

  const openDrill = async (account: TrialRow): Promise<void> => {
    await guard(async () => {
      const rows = await api<LedgerRow[]>(
        `/tenants/current/reports/ledger?code=${account.code}&from=2000-01-01&to=${today()}`,
      );
      setDrill({ account, rows });
    });
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
    if (next === "aged_recv" && !agedRecv) void loadAgedRecv();
    if (next === "aged_pay" && !agedPay) void loadAgedPay();
    if (next === "statement" && customers.length === 0) void loadCustomers();
    if (next === "inventory" && !invVal) void loadInvVal();
    if (next === "expenses" && !expenses) void loadExpenses(expFrom, expTo);
    if (next === "payments" && !payments) void loadPayments(payFrom, payTo);
    if (next === "vat" && !vat) void loadVat(vatFrom, vatTo);
  };

  const switchGroup = (g: Group): void => {
    setGroup(g);
    const first: Tab = g === "financial" ? "pnl" : "sales";
    if (GROUP_OF[tab] !== g) switchTab(first);
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
              <strong>{tr("rptTotal")}</strong>
            </td>
            <td style={{ textAlign: "right" }}>
              <strong>{fmtKes(totalCents)}</strong>
            </td>
          </tr>
        </tbody>
      </table>
    </>
  );

  const TABS: Record<Group, [Tab, string][]> = {
    financial: [
      ["pnl", tr("rptPnl")],
      ["balance", tr("rptBalance")],
      ["trial", tr("rptTrial")],
      ["expenses", tr("rptExpensesTab")],
      ["vat", tr("rptVat")],
    ],
    operational: [
      ["sales", tr("rptSales")],
      ["aged_recv", tr("rptAgedRecv")],
      ["aged_pay", tr("rptAgedPay")],
      ["statement", tr("rptStatement")],
      ["payments", tr("rptPayments")],
      ["inventory", tr("rptInventory")],
    ],
  };

  const agedTable = (data: Aged, nameKey: "customer_name" | "supplier_name") => (
    <div className="card">
      {data.rows.length === 0 ? (
        <p className="muted">{tr("rptNoData")}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>
                {nameKey === "customer_name" ? tr("rptCustomer") : tr("rptSupplier")}
              </th>
              <th style={{ textAlign: "right" }}>{tr("rptCurrent")}</th>
              <th style={{ textAlign: "right" }}>{tr("rptB3160")}</th>
              <th style={{ textAlign: "right" }}>{tr("rptB6190")}</th>
              <th style={{ textAlign: "right" }}>{tr("rptB90")}</th>
              <th style={{ textAlign: "right" }}>{tr("rptTotal")}</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r, i) => (
              <tr key={i}>
                <td>{String(r[nameKey])}</td>
                <td style={{ textAlign: "right" }}>{fmtKes(r.d0_30)}</td>
                <td style={{ textAlign: "right" }}>{fmtKes(r.d31_60)}</td>
                <td style={{ textAlign: "right" }}>{fmtKes(r.d61_90)}</td>
                <td style={{ textAlign: "right" }}>{fmtKes(r.d90_plus)}</td>
                <td style={{ textAlign: "right" }}>
                  <strong>{fmtKes(r.total)}</strong>
                </td>
              </tr>
            ))}
            <tr>
              <td>
                <strong>{tr("rptTotal")}</strong>
              </td>
              <td style={{ textAlign: "right" }}>
                <strong>{fmtKes(data.totals.d0_30)}</strong>
              </td>
              <td style={{ textAlign: "right" }}>
                <strong>{fmtKes(data.totals.d31_60)}</strong>
              </td>
              <td style={{ textAlign: "right" }}>
                <strong>{fmtKes(data.totals.d61_90)}</strong>
              </td>
              <td style={{ textAlign: "right" }}>
                <strong>{fmtKes(data.totals.d90_plus)}</strong>
              </td>
              <td style={{ textAlign: "right" }}>
                <strong>{fmtKes(data.totals.total)}</strong>
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );

  const agedCsv = (data: Aged, nameKey: "customer_name" | "supplier_name") =>
    downloadCsv(`${nameKey === "customer_name" ? "aged-receivables" : "aged-payables"}-${today()}.csv`, [
      [
        nameKey === "customer_name" ? "Customer" : "Supplier",
        "0-30 KES",
        "31-60 KES",
        "61-90 KES",
        "90+ KES",
        "Total KES",
      ],
      ...data.rows.map((r) => [
        String(r[nameKey]),
        Number(r.d0_30) / 100,
        Number(r.d31_60) / 100,
        Number(r.d61_90) / 100,
        Number(r.d90_plus) / 100,
        Number(r.total) / 100,
      ]),
      [
        "Total",
        data.totals.d0_30 / 100,
        data.totals.d31_60 / 100,
        data.totals.d61_90 / 100,
        data.totals.d90_plus / 100,
        data.totals.total / 100,
      ],
    ]);

  return (
    <>
      <h1>Reports</h1>
      <div className="tabs" style={{ marginBottom: 8 }}>
        {(
          [
            ["financial", tr("rptFinancial")],
            ["operational", tr("rptOperational")],
          ] as [Group, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={group === key ? "tab active" : "tab"}
            onClick={() => switchGroup(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="tabs">
        {TABS[group].map(([key, label]) => (
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
            <button onClick={() => void loadBs(asOf)}>Run</button>{" "}
            {bs && (
              <button
                className="secondary"
                onClick={() =>
                  downloadCsv(`balance-sheet-${bs.asOf}.csv`, [
                    ["Section", "Account", "Amount KES"],
                    ...bs.assets.map((r) => [
                      "Assets",
                      `${r.code} ${r.name}`,
                      Number(r.amount_cents) / 100,
                    ]),
                    ["Assets", "Total assets", bs.totalAssetsCents / 100],
                    ...bs.liabilities.map((r) => [
                      "Liabilities",
                      `${r.code} ${r.name}`,
                      Number(r.amount_cents) / 100,
                    ]),
                    [
                      "Liabilities",
                      "Total liabilities",
                      bs.totalLiabilitiesCents / 100,
                    ],
                    ...bs.equity.map((r) => [
                      "Equity",
                      `${r.code} ${r.name}`,
                      Number(r.amount_cents) / 100,
                    ]),
                    [
                      "Equity",
                      "Retained earnings",
                      bs.retainedEarningsCents / 100,
                    ],
                    ["Equity", "Total equity", bs.totalEquityCents / 100],
                  ])
                }
              >
                Export CSV
              </button>
            )}
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
            {trial.length > 0 && (
              <button
                className="secondary"
                style={{ marginTop: 0 }}
                onClick={() =>
                  downloadCsv(`trial-balance-${today()}.csv`, [
                    ["Code", "Account", "Type", "Balance KES"],
                    ...trial.map((r) => [
                      r.code,
                      r.name,
                      r.type,
                      r.balanceCents / 100,
                    ]),
                  ])
                }
              >
                Export CSV
              </button>
            )}
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
            </button>{" "}
            {sales && sales.rows.length > 0 && (
              <button
                className="secondary"
                onClick={() =>
                  downloadCsv(`sales-${sales.period}-${sales.groupBy}.csv`, [
                    [
                      sales.groupBy === "day"
                        ? "Date"
                        : sales.groupBy === "customer"
                          ? "Customer"
                          : "Item",
                      sales.groupBy === "item" ? "Qty" : "Invoices",
                      "Net KES",
                      "VAT KES",
                      ...(sales.groupBy === "customer"
                        ? ["Outstanding KES"]
                        : []),
                    ],
                    ...sales.rows.map((r) => [
                      String(r.label),
                      sales.groupBy === "item"
                        ? Number(r.quantity)
                        : Number(r.invoices),
                      Number(r.net_cents) / 100,
                      Number(r.vat_cents) / 100,
                      ...(sales.groupBy === "customer"
                        ? [Number(r.outstanding_cents) / 100]
                        : []),
                    ]),
                    [
                      "Total",
                      sales.totals.invoices,
                      Number(sales.totals.net) / 100,
                      Number(sales.totals.vat) / 100,
                      ...(sales.groupBy === "customer" ? [""] : []),
                    ],
                  ])
                }
              >
                Export CSV
              </button>
            )}
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

      {tab === "aged_recv" && (
        <>
          <div className="card">
            <p className="muted" style={{ marginTop: 0 }}>
              {tr("rptAgedRecv")} — {today()}
            </p>
            <button onClick={() => void loadAgedRecv()}>{tr("rptRun")}</button>{" "}
            {agedRecv && agedRecv.rows.length > 0 && (
              <button
                className="secondary"
                onClick={() => agedCsv(agedRecv, "customer_name")}
              >
                {tr("rptExport")}
              </button>
            )}
          </div>
          {agedRecv && (
            <>
              <div className="tiles">
                {(
                  [
                    ["rptCurrent", agedRecv.totals.d0_30, "tile-1"],
                    ["rptB3160", agedRecv.totals.d31_60, "tile-2"],
                    ["rptB6190", agedRecv.totals.d61_90, "tile-3"],
                    ["rptB90", agedRecv.totals.d90_plus, "tile-4"],
                  ] as [string, number, string][]
                ).map(([k, v, cls]) => (
                  <div className={`tile ${cls}`} key={k}>
                    <div className="tile-value">{fmtKes(v)}</div>
                    <div className="tile-label">{tr(k)}</div>
                  </div>
                ))}
              </div>
              {agedTable(agedRecv, "customer_name")}
            </>
          )}
        </>
      )}

      {tab === "aged_pay" && (
        <>
          <div className="card">
            <p className="muted" style={{ marginTop: 0 }}>
              {tr("rptAgedPay")} — {today()}
            </p>
            <button onClick={() => void loadAgedPay()}>{tr("rptRun")}</button>{" "}
            {agedPay && agedPay.rows.length > 0 && (
              <button
                className="secondary"
                onClick={() => agedCsv(agedPay, "supplier_name")}
              >
                {tr("rptExport")}
              </button>
            )}
          </div>
          {agedPay && (
            <>
              <div className="tiles">
                {(
                  [
                    ["rptCurrent", agedPay.totals.d0_30, "tile-1"],
                    ["rptB3160", agedPay.totals.d31_60, "tile-2"],
                    ["rptB6190", agedPay.totals.d61_90, "tile-3"],
                    ["rptB90", agedPay.totals.d90_plus, "tile-4"],
                  ] as [string, number, string][]
                ).map(([k, v, cls]) => (
                  <div className={`tile ${cls}`} key={k}>
                    <div className="tile-value">{fmtKes(v)}</div>
                    <div className="tile-label">{tr(k)}</div>
                  </div>
                ))}
              </div>
              {agedTable(agedPay, "supplier_name")}
            </>
          )}
        </>
      )}

      {tab === "statement" && (
        <>
          <div className="card">
            <div className="row">
              <div style={{ minWidth: 220 }}>
                <label>{tr("rptCustomer")}</label>
                <SearchSelect
                  options={customers}
                  value={stmtCustomer}
                  onChange={(id) => {
                    setStmtCustomer(id);
                    void loadStatement(id, stmtFrom, stmtTo);
                  }}
                  placeholder={tr("rptChooseCustomer")}
                />
              </div>
              <div>
                <label>{tr("rptFrom")}</label>
                <input
                  type="date"
                  value={stmtFrom}
                  onChange={(e) => setStmtFrom(e.target.value)}
                />
              </div>
              <div>
                <label>{tr("rptTo")}</label>
                <input
                  type="date"
                  value={stmtTo}
                  onChange={(e) => setStmtTo(e.target.value)}
                />
              </div>
            </div>
            <button
              onClick={() => void loadStatement(stmtCustomer, stmtFrom, stmtTo)}
              disabled={!stmtCustomer}
            >
              {tr("rptRun")}
            </button>{" "}
            {statement && (
              <button
                className="secondary"
                onClick={() =>
                  downloadCsv(
                    `statement-${statement.customerName}-${statement.from}-${statement.to}.csv`,
                    [
                      ["Date", "Reference", "Description", "Charge KES", "Payment KES", "Balance KES"],
                      ["", "", "Opening balance", "", "", statement.openingBalanceCents / 100],
                      ...statement.rows.map((r) => [
                        r.d,
                        r.ref,
                        r.description,
                        r.charge_cents ? r.charge_cents / 100 : "",
                        r.payment_cents ? r.payment_cents / 100 : "",
                        r.balance_cents / 100,
                      ]),
                      ["", "", "Closing balance", statement.totalChargedCents / 100, statement.totalPaidCents / 100, statement.closingBalanceCents / 100],
                    ],
                  )
                }
              >
                {tr("rptExport")}
              </button>
            )}
          </div>
          {statement && (
            <div className="card">
              <table>
                <thead>
                  <tr>
                    <th>{tr("rptDate")}</th>
                    <th>{tr("rptRef")}</th>
                    <th>{tr("rptCharge")}</th>
                    <th>{tr("rptPayment")}</th>
                    <th style={{ textAlign: "right" }}>{tr("rptBalance2")}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td colSpan={4}>
                      <span className="muted">{tr("rptOpening")}</span>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {fmtKes(statement.openingBalanceCents)}
                    </td>
                  </tr>
                  {statement.rows.map((r, i) => (
                    <tr key={i}>
                      <td>{r.d}</td>
                      <td>
                        {r.ref}{" "}
                        <span className="muted">{r.description}</span>
                      </td>
                      <td>{r.charge_cents ? fmtKes(r.charge_cents) : ""}</td>
                      <td>{r.payment_cents ? fmtKes(r.payment_cents) : ""}</td>
                      <td style={{ textAlign: "right" }}>
                        {fmtKes(r.balance_cents)}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={4}>
                      <strong>{tr("rptClosing")}</strong>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <strong>{fmtKes(statement.closingBalanceCents)}</strong>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === "payments" && (
        <>
          <div className="card">
            <div className="row">
              <div>
                <label>{tr("rptFrom")}</label>
                <input
                  type="date"
                  value={payFrom}
                  onChange={(e) => setPayFrom(e.target.value)}
                />
              </div>
              <div>
                <label>{tr("rptTo")}</label>
                <input
                  type="date"
                  value={payTo}
                  onChange={(e) => setPayTo(e.target.value)}
                />
              </div>
            </div>
            <button onClick={() => void loadPayments(payFrom, payTo)}>
              {tr("rptRun")}
            </button>{" "}
            {payments && payments.rows.length > 0 && (
              <button
                className="secondary"
                onClick={() =>
                  downloadCsv(`payments-${payments.from}-${payments.to}.csv`, [
                    ["Channel", "Count", "Total KES"],
                    ...payments.rows.map((r) => [
                      railLabel(r.rail_group, tr),
                      Number(r.count),
                      Number(r.total_cents) / 100,
                    ]),
                    ["Total", payments.totals.count, payments.totals.total_cents / 100],
                  ])
                }
              >
                {tr("rptExport")}
              </button>
            )}
          </div>
          {payments && (
            <>
              <div className="row">
                <div className="card">
                  <span className="muted">{tr("rptTotal")}</span>
                  <div className="stat">{fmtKes(payments.totals.total_cents)}</div>
                </div>
                <div className="card">
                  <span className="muted">{tr("rptCount")}</span>
                  <div className="stat">{payments.totals.count}</div>
                </div>
              </div>
              <div className="card">
                {payments.rows.length === 0 ? (
                  <p className="muted">{tr("rptNoData")}</p>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>{tr("rptChannel")}</th>
                        <th style={{ textAlign: "right" }}>{tr("rptCount")}</th>
                        <th style={{ textAlign: "right" }}>{tr("rptTotal")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payments.rows.map((r, i) => (
                        <tr key={i}>
                          <td>{railLabel(r.rail_group, tr)}</td>
                          <td style={{ textAlign: "right" }}>{Number(r.count)}</td>
                          <td style={{ textAlign: "right" }}>
                            {fmtKes(r.total_cents)}
                          </td>
                        </tr>
                      ))}
                      <tr>
                        <td>
                          <strong>{tr("rptTotal")}</strong>
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <strong>{payments.totals.count}</strong>
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <strong>{fmtKes(payments.totals.total_cents)}</strong>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </>
      )}

      {tab === "inventory" && (
        <>
          <div className="card">
            <p className="muted" style={{ marginTop: 0 }}>
              {tr("rptInventory")} — {today()}
            </p>
            <button onClick={() => void loadInvVal()}>{tr("rptRun")}</button>{" "}
            {invVal && invVal.rows.length > 0 && (
              <button
                className="secondary"
                onClick={() =>
                  downloadCsv(`inventory-valuation-${today()}.csv`, [
                    ["SKU", "Item", "Unit", "On hand", "Unit cost KES", "Stock value KES", "Low stock"],
                    ...invVal.rows.map((r) => [
                      r.sku,
                      r.name,
                      r.unit,
                      r.on_hand,
                      r.cost_cents / 100,
                      r.value_cents / 100,
                      r.low_stock ? "yes" : "",
                    ]),
                    ["", "", "", "", "Total", invVal.totals.value_cents / 100, ""],
                  ])
                }
              >
                {tr("rptExport")}
              </button>
            )}
          </div>
          {invVal && (
            <>
              <div className="row">
                <div className="card">
                  <span className="muted">{tr("rptStockValue")}</span>
                  <div className="stat">{fmtKes(invVal.totals.value_cents)}</div>
                </div>
                <div className="card">
                  <span className="muted">{tr("rptItems")}</span>
                  <div className="stat">{invVal.totals.items}</div>
                </div>
                <div className="card">
                  <span className="muted">{tr("rptLow")}</span>
                  <div className="stat">{invVal.totals.low_stock}</div>
                </div>
              </div>
              <div className="card">
                {invVal.rows.length === 0 ? (
                  <p className="muted">{tr("rptNoData")}</p>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>SKU</th>
                        <th>{tr("rptItems")}</th>
                        <th style={{ textAlign: "right" }}>{tr("rptOnHand")}</th>
                        <th style={{ textAlign: "right" }}>{tr("rptUnitCost")}</th>
                        <th style={{ textAlign: "right" }}>{tr("rptStockValue")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invVal.rows.map((r) => (
                        <tr key={r.item_id}>
                          <td>{r.sku}</td>
                          <td>
                            {r.name}
                            {r.low_stock && (
                              <>
                                {" "}
                                <span className="err">● {tr("rptLow")}</span>
                              </>
                            )}
                          </td>
                          <td style={{ textAlign: "right" }}>
                            {r.on_hand} {r.unit}
                          </td>
                          <td style={{ textAlign: "right" }}>
                            {fmtKes(r.cost_cents)}
                          </td>
                          <td style={{ textAlign: "right" }}>
                            {fmtKes(r.value_cents)}
                          </td>
                        </tr>
                      ))}
                      <tr>
                        <td colSpan={4}>
                          <strong>{tr("rptTotal")}</strong>
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <strong>{fmtKes(invVal.totals.value_cents)}</strong>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </>
      )}

      {tab === "expenses" && (
        <>
          <div className="card">
            <div className="row">
              <div>
                <label>{tr("rptFrom")}</label>
                <input
                  type="date"
                  value={expFrom}
                  onChange={(e) => setExpFrom(e.target.value)}
                />
              </div>
              <div>
                <label>{tr("rptTo")}</label>
                <input
                  type="date"
                  value={expTo}
                  onChange={(e) => setExpTo(e.target.value)}
                />
              </div>
            </div>
            <button onClick={() => void loadExpenses(expFrom, expTo)}>
              {tr("rptRun")}
            </button>{" "}
            {expenses && expenses.rows.length > 0 && (
              <button
                className="secondary"
                onClick={() =>
                  downloadCsv(`expenses-${expenses.from}-${expenses.to}.csv`, [
                    ["Code", "Account", "Entries", "Amount KES"],
                    ...expenses.rows.map((r) => [
                      r.code,
                      r.name,
                      Number(r.entries),
                      Number(r.amount_cents) / 100,
                    ]),
                    ["", "Total", "", expenses.totalCents / 100],
                  ])
                }
              >
                {tr("rptExport")}
              </button>
            )}
          </div>
          {expenses && (
            <div className="card">
              {expenses.rows.length === 0 ? (
                <p className="muted">{tr("rptNoData")}</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>{tr("rptAccount")}</th>
                      <th style={{ textAlign: "right" }}>{tr("rptCount")}</th>
                      <th style={{ textAlign: "right" }}>{tr("rptTotal")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {expenses.rows.map((r) => (
                      <tr key={r.code}>
                        <td>
                          <span className="muted">{r.code}</span> {r.name}
                        </td>
                        <td style={{ textAlign: "right" }}>{Number(r.entries)}</td>
                        <td style={{ textAlign: "right" }}>
                          {fmtKes(r.amount_cents)}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td>
                        <strong>{tr("rptTotal")}</strong>
                      </td>
                      <td />
                      <td style={{ textAlign: "right" }}>
                        <strong>{fmtKes(expenses.totalCents)}</strong>
                      </td>
                    </tr>
                  </tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}

      {tab === "vat" && (
        <>
          <div className="card">
            <div className="row">
              <div>
                <label>{tr("rptFrom")}</label>
                <input
                  type="month"
                  value={vatFrom}
                  onChange={(e) => setVatFrom(e.target.value)}
                />
              </div>
              <div>
                <label>{tr("rptTo")}</label>
                <input
                  type="month"
                  value={vatTo}
                  onChange={(e) => setVatTo(e.target.value)}
                />
              </div>
            </div>
            <button onClick={() => void loadVat(vatFrom, vatTo)}>
              {tr("rptRun")}
            </button>{" "}
            {vat && vat.rows.length > 0 && (
              <button
                className="secondary"
                onClick={() =>
                  downloadCsv(`vat-summary-${vat.from}-${vat.to}.csv`, [
                    ["Period", "Output VAT KES", "Input VAT KES", "Net payable KES"],
                    ...vat.rows.map((r) => [
                      r.period,
                      Number(r.output_vat_cents) / 100,
                      Number(r.input_vat_cents) / 100,
                      Number(r.net_cents) / 100,
                    ]),
                    [
                      "Total",
                      vat.totals.output_vat_cents / 100,
                      vat.totals.input_vat_cents / 100,
                      vat.totals.net_cents / 100,
                    ],
                  ])
                }
              >
                {tr("rptExport")}
              </button>
            )}
          </div>
          {vat && (
            <>
              <div className="row">
                <div className="card">
                  <span className="muted">{tr("rptOutputVat")}</span>
                  <div className="stat">{fmtKes(vat.totals.output_vat_cents)}</div>
                </div>
                <div className="card">
                  <span className="muted">{tr("rptInputVat")}</span>
                  <div className="stat">{fmtKes(vat.totals.input_vat_cents)}</div>
                </div>
                <div className="card">
                  <span className="muted">{tr("rptNetPayable")}</span>
                  <div className="stat">
                    <span className={vat.totals.net_cents < 0 ? "err" : ""}>
                      {fmtKes(vat.totals.net_cents)}
                    </span>
                  </div>
                </div>
              </div>
              <div className="card">
                {vat.rows.length === 0 ? (
                  <p className="muted">{tr("rptNoData")}</p>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>{tr("rptPeriod")}</th>
                        <th style={{ textAlign: "right" }}>{tr("rptOutputVat")}</th>
                        <th style={{ textAlign: "right" }}>{tr("rptInputVat")}</th>
                        <th style={{ textAlign: "right" }}>{tr("rptNetPayable")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vat.rows.map((r) => (
                        <tr key={r.period}>
                          <td>{r.period}</td>
                          <td style={{ textAlign: "right" }}>
                            {fmtKes(r.output_vat_cents)}
                          </td>
                          <td style={{ textAlign: "right" }}>
                            {fmtKes(r.input_vat_cents)}
                          </td>
                          <td style={{ textAlign: "right" }}>
                            <span className={Number(r.net_cents) < 0 ? "err" : ""}>
                              {fmtKes(r.net_cents)}
                            </span>
                          </td>
                        </tr>
                      ))}
                      <tr>
                        <td>
                          <strong>{tr("rptTotal")}</strong>
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <strong>{fmtKes(vat.totals.output_vat_cents)}</strong>
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <strong>{fmtKes(vat.totals.input_vat_cents)}</strong>
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <strong>{fmtKes(vat.totals.net_cents)}</strong>
                        </td>
                      </tr>
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
