"use client";

import { useCallback, useEffect, useState } from "react";
import { api, fmtKes } from "@/lib/api";
import { Column, DataTable } from "@/components/DataTable";

type Tab = "budgets" | "assets" | "recurring";

interface BudgetRow {
  id: string;
  account_code: string;
  account_name: string | null;
  fiscal_year: number;
  month: number;
  amount_cents: string;
}
interface BvaRow {
  code: string;
  name: string;
  type: "income" | "expense";
  budget_cents: string;
  actual_cents: string;
  variance_cents: string;
}
interface BvaReport {
  year: number;
  rows: BvaRow[];
  totals: {
    budgetIncomeCents: number;
    actualIncomeCents: number;
    budgetExpenseCents: number;
    actualExpenseCents: number;
  };
}
interface AccountRow {
  code: string;
  name: string;
  type: string;
}
interface AssetRow {
  id: string;
  name: string;
  cost_cents: string;
  salvage_cents: string;
  acquired_date: string;
  useful_life_months: number;
  disposed: boolean;
  accumulated_cents: string;
  nbv_cents: string;
}
interface TemplateRow {
  id: string;
  customer_name: string;
  branch_name: string;
  cadence: string;
  next_run_date: string;
  active: boolean;
  subtotal_cents: string;
}
interface Customer {
  id: string;
  name: string;
}
interface Branch {
  id: string;
  name: string;
}
interface LineDraft {
  description: string;
  quantity: string;
  unitPriceKes: string;
  vatRate: "0.16" | "0" | "exempt";
}

const MONTHS = [
  "Annual",
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const isoDay = (v: string): string => String(v ?? "").slice(0, 10);
const thisYear = new Date().getFullYear();
const thisMonth = new Date().toISOString().slice(0, 7);

export default function FinancePage() {
  const [tab, setTab] = useState<Tab>("budgets");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Budgets
  const [year, setYear] = useState(String(thisYear));
  const [report, setReport] = useState<BvaReport | null>(null);
  const [budgets, setBudgets] = useState<BudgetRow[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [bAccount, setBAccount] = useState("");
  const [bMonth, setBMonth] = useState("0");
  const [bAmount, setBAmount] = useState("");

  // Fixed assets
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [depPeriod, setDepPeriod] = useState(thisMonth);
  const [depResult, setDepResult] = useState("");
  const [aName, setAName] = useState("");
  const [aCost, setACost] = useState("");
  const [aSalvage, setASalvage] = useState("");
  const [aAcquired, setAAcquired] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [aLife, setALife] = useState("36");

  // Recurring templates
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [rCustomer, setRCustomer] = useState("");
  const [rBranch, setRBranch] = useState("");
  const [rNextRun, setRNextRun] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [rLines, setRLines] = useState<LineDraft[]>([
    { description: "", quantity: "1", unitPriceKes: "", vatRate: "0.16" },
  ]);

  const fail = (e: unknown): void =>
    setError(e instanceof Error ? e.message : "Request failed");

  const loadBudgets = useCallback(async (y: string) => {
    setError("");
    try {
      const [rep, rows, tb] = await Promise.all([
        api<BvaReport>(`/tenants/current/budget-vs-actual?year=${y}`),
        api<BudgetRow[]>(`/tenants/current/budgets?year=${y}`),
        api<AccountRow[]>("/tenants/current/accounts/trial-balance"),
      ]);
      setReport(rep);
      setBudgets(rows);
      setAccounts(
        tb.filter((a) => a.type === "income" || a.type === "expense"),
      );
    } catch (e) {
      fail(e);
    }
  }, []);

  const loadAssets = useCallback(async () => {
    setError("");
    try {
      setAssets(await api<AssetRow[]>("/tenants/current/fixed-assets"));
    } catch (e) {
      fail(e);
    }
  }, []);

  const loadRecurring = useCallback(async () => {
    setError("");
    try {
      const [tpl, cust, br] = await Promise.all([
        api<TemplateRow[]>("/tenants/current/recurring"),
        api<Customer[]>("/tenants/current/customers"),
        api<Branch[]>("/tenants/current/branches"),
      ]);
      setTemplates(tpl);
      setCustomers(cust);
      setBranches(br);
    } catch (e) {
      fail(e);
    }
  }, []);

  useEffect(() => {
    void loadBudgets(year);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchTab = (next: Tab): void => {
    setTab(next);
    setError("");
    setNotice("");
    if (next === "budgets" && !report) void loadBudgets(year);
    if (next === "assets" && assets.length === 0) void loadAssets();
    if (next === "recurring" && templates.length === 0) void loadRecurring();
  };

  // ---- Budgets actions ----------------------------------------------------

  const saveBudget = async (): Promise<void> => {
    setError("");
    const amountKes = Number(bAmount);
    if (!bAccount || !(amountKes >= 0)) {
      setError("Pick an account and enter a non-negative amount.");
      return;
    }
    try {
      await api("/tenants/current/budgets", {
        method: "POST",
        body: {
          entries: [
            {
              accountCode: bAccount,
              fiscalYear: Number(year),
              month: Number(bMonth),
              amountCents: Math.round(amountKes * 100),
            },
          ],
        },
      });
      setBAmount("");
      setNotice("Budget saved.");
      await loadBudgets(year);
    } catch (e) {
      fail(e);
    }
  };

  const deleteBudget = async (id: string): Promise<void> => {
    setError("");
    try {
      await api(`/tenants/current/budgets/${id}`, { method: "DELETE" });
      await loadBudgets(year);
    } catch (e) {
      fail(e);
    }
  };

  // ---- Asset actions ------------------------------------------------------

  const runDepreciation = async (): Promise<void> => {
    setError("");
    setDepResult("");
    try {
      const r = await api<{
        posted: number;
        skipped: number;
        totalCents: number;
      }>("/tenants/current/fixed-assets/run-depreciation", {
        method: "POST",
        body: { period: depPeriod },
      });
      setDepResult(
        `Posted ${r.posted} entr${r.posted === 1 ? "y" : "ies"} — ${fmtKes(r.totalCents)}${r.skipped ? ` (${r.skipped} skipped)` : ""}`,
      );
      await loadAssets();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Run failed";
      setError(
        msg.includes("Unknown account code")
          ? `${msg} — re-seed default accounts in Settings.`
          : msg,
      );
    }
  };

  const createAsset = async (): Promise<void> => {
    setError("");
    const cost = Number(aCost);
    if (!aName.trim() || !(cost > 0)) {
      setError("Asset needs a name and a positive cost.");
      return;
    }
    try {
      await api("/tenants/current/fixed-assets", {
        method: "POST",
        body: {
          name: aName.trim(),
          costCents: Math.round(cost * 100),
          salvageCents: Math.round(Number(aSalvage || 0) * 100),
          acquiredDate: aAcquired,
          usefulLifeMonths: Number(aLife),
        },
      });
      setAName("");
      setACost("");
      setASalvage("");
      setNotice("Asset added.");
      await loadAssets();
    } catch (e) {
      fail(e);
    }
  };

  const disposeAsset = async (id: string): Promise<void> => {
    setError("");
    try {
      await api(`/tenants/current/fixed-assets/${id}`, {
        method: "PATCH",
        body: { disposed: true },
      });
      await loadAssets();
    } catch (e) {
      fail(e);
    }
  };

  // ---- Recurring actions --------------------------------------------------

  const runRecurring = async (): Promise<void> => {
    setError("");
    setNotice("");
    try {
      const r = await api<{ drafted: number }>(
        "/tenants/current/recurring/run",
        { method: "POST" },
      );
      setNotice(`${r.drafted} draft${r.drafted === 1 ? "" : "s"} created.`);
      await loadRecurring();
    } catch (e) {
      fail(e);
    }
  };

  const createTemplate = async (): Promise<void> => {
    setError("");
    const lines = rLines
      .filter((l) => l.description.trim())
      .map((l) => ({
        description: l.description.trim(),
        quantity: Number(l.quantity),
        unitPriceCents: Math.round(Number(l.unitPriceKes) * 100),
        vatRate: l.vatRate,
      }));
    if (!rCustomer || !rBranch || lines.length === 0) {
      setError("Pick a customer, a branch and add at least one line.");
      return;
    }
    try {
      await api("/tenants/current/recurring", {
        method: "POST",
        body: {
          customerId: rCustomer,
          branchId: rBranch,
          nextRunDate: rNextRun,
          lines,
        },
      });
      setRLines([
        { description: "", quantity: "1", unitPriceKes: "", vatRate: "0.16" },
      ]);
      setNotice("Template created.");
      await loadRecurring();
    } catch (e) {
      fail(e);
    }
  };

  const toggleTemplate = async (t: TemplateRow): Promise<void> => {
    setError("");
    try {
      await api(`/tenants/current/recurring/${t.id}`, {
        method: "PATCH",
        body: { active: !t.active },
      });
      await loadRecurring();
    } catch (e) {
      fail(e);
    }
  };

  const deleteTemplate = async (id: string): Promise<void> => {
    setError("");
    try {
      await api(`/tenants/current/recurring/${id}`, { method: "DELETE" });
      await loadRecurring();
    } catch (e) {
      fail(e);
    }
  };

  // ---- Columns ------------------------------------------------------------

  const budgetCols: Column<BudgetRow>[] = [
    { key: "account_code", label: "Code" },
    {
      key: "account_name",
      label: "Account",
      render: (r) => r.account_name ?? "—",
    },
    {
      key: "month",
      label: "Period",
      value: (r) => r.month,
      render: (r) => (r.month === 0 ? "Annual" : MONTHS[r.month]),
    },
    {
      key: "amount_cents",
      label: "Budget",
      num: true,
      value: (r) => Number(r.amount_cents),
      render: (r) => fmtKes(r.amount_cents),
    },
    {
      key: "actions",
      label: "",
      render: (r) => (
        <button
          type="button"
          className="secondary dt-btn"
          onClick={() => void deleteBudget(r.id)}
        >
          Delete
        </button>
      ),
    },
  ];

  const assetCols: Column<AssetRow>[] = [
    { key: "name", label: "Name" },
    {
      key: "acquired_date",
      label: "Acquired",
      value: (r) => isoDay(r.acquired_date),
    },
    {
      key: "cost_cents",
      label: "Cost",
      num: true,
      value: (r) => Number(r.cost_cents),
      render: (r) => fmtKes(r.cost_cents),
    },
    {
      key: "useful_life_months",
      label: "Life (mo)",
      num: true,
      value: (r) => r.useful_life_months,
    },
    {
      key: "accumulated_cents",
      label: "Accumulated",
      num: true,
      value: (r) => Number(r.accumulated_cents),
      render: (r) => fmtKes(r.accumulated_cents),
    },
    {
      key: "nbv_cents",
      label: "NBV",
      num: true,
      value: (r) => Number(r.nbv_cents),
      render: (r) => fmtKes(r.nbv_cents),
    },
    {
      key: "disposed",
      label: "Status",
      value: (r) => (r.disposed ? "disposed" : "active"),
      render: (r) => (
        <span className={`pill ${r.disposed ? "void" : "paid"}`}>
          {r.disposed ? "disposed" : "active"}
        </span>
      ),
    },
    {
      key: "actions",
      label: "",
      render: (r) =>
        r.disposed ? null : (
          <button
            type="button"
            className="secondary dt-btn"
            onClick={() => void disposeAsset(r.id)}
          >
            Dispose
          </button>
        ),
    },
  ];

  const templateCols: Column<TemplateRow>[] = [
    { key: "customer_name", label: "Customer" },
    { key: "branch_name", label: "Branch" },
    { key: "cadence", label: "Cadence" },
    {
      key: "next_run_date",
      label: "Next run",
      value: (r) => isoDay(r.next_run_date),
    },
    {
      key: "subtotal_cents",
      label: "Subtotal",
      num: true,
      value: (r) => Number(r.subtotal_cents),
      render: (r) => fmtKes(r.subtotal_cents),
    },
    {
      key: "active",
      label: "Status",
      value: (r) => (r.active ? "active" : "paused"),
      render: (r) => (
        <span className={`pill ${r.active ? "paid" : "pending"}`}>
          {r.active ? "active" : "paused"}
        </span>
      ),
    },
    {
      key: "actions",
      label: "",
      render: (r) => (
        <>
          <button
            type="button"
            className="secondary dt-btn"
            onClick={() => void toggleTemplate(r)}
          >
            {r.active ? "Pause" : "Resume"}
          </button>{" "}
          <button
            type="button"
            className="secondary dt-btn"
            onClick={() => void deleteTemplate(r.id)}
          >
            Delete
          </button>
        </>
      ),
    },
  ];

  const favourable = (r: BvaRow): boolean =>
    r.type === "income"
      ? Number(r.actual_cents) >= Number(r.budget_cents)
      : Number(r.actual_cents) <= Number(r.budget_cents);

  return (
    <>
      <h1>Finance</h1>
      <div className="tabs">
        {(
          [
            ["budgets", "Budgets"],
            ["assets", "Fixed assets"],
            ["recurring", "Recurring invoices"],
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
      {notice && <p className="muted">{notice}</p>}

      {tab === "budgets" && (
        <>
          <div className="card">
            <div className="row">
              <div>
                <label>Fiscal year</label>
                <input
                  type="number"
                  min={2000}
                  max={2100}
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                  style={{ maxWidth: 140 }}
                />
              </div>
              <div>
                <label>&nbsp;</label>
                <button type="button" onClick={() => void loadBudgets(year)}>
                  Run
                </button>
              </div>
            </div>
          </div>

          {report && (
            <>
              <div className="row">
                <div className="card">
                  <span className="muted">Budgeted income</span>
                  <div className="stat">
                    {fmtKes(report.totals.budgetIncomeCents)}
                  </div>
                </div>
                <div className="card">
                  <span className="muted">Actual income</span>
                  <div className="stat">
                    {fmtKes(report.totals.actualIncomeCents)}
                  </div>
                </div>
                <div className="card">
                  <span className="muted">Budgeted expenses</span>
                  <div className="stat">
                    {fmtKes(report.totals.budgetExpenseCents)}
                  </div>
                </div>
                <div className="card">
                  <span className="muted">Actual expenses</span>
                  <div className="stat">
                    {fmtKes(report.totals.actualExpenseCents)}
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <h3>Budget vs actual — {report.year}</h3>
                </div>
                {report.rows.length === 0 ? (
                  <p className="muted">
                    No budgets or postings for this year yet.
                  </p>
                ) : (
                  report.rows.map((r) => {
                    const budget = Number(r.budget_cents);
                    const actual = Number(r.actual_cents);
                    const max = Math.max(budget, actual, 1);
                    return (
                      <div key={r.code} className="bar-row">
                        <span className="bar-label" style={{ width: 160 }}>
                          <span className="muted">{r.code}</span> {r.name}
                        </span>
                        <span className="bar-track">
                          <span
                            className="bar-fill"
                            style={{
                              width: `${Math.max(actual > 0 ? 3 : 0, (actual / max) * 100)}%`,
                              background: favourable(r)
                                ? "var(--ok, #16a34a)"
                                : "var(--warn, #d97706)",
                            }}
                          />
                        </span>
                        <span className="bar-amt">
                          {fmtKes(actual)}{" "}
                          <span className="muted">/ {fmtKes(budget)}</span>
                        </span>
                        <span
                          className={`pill ${favourable(r) ? "paid" : "overdue"}`}
                        >
                          {Number(r.variance_cents) >= 0 ? "+" : ""}
                          {fmtKes(r.variance_cents)}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </>
          )}

          <div className="card">
            <div className="card-head">
              <h3>Budget lines — {year}</h3>
            </div>
            <DataTable
              rows={budgets}
              columns={budgetCols}
              searchKeys={["account_code", "account_name"]}
              csvName="budgets"
              empty={
                <p className="muted">
                  No budget lines for {year} yet — set the first one below.
                </p>
              }
            />
          </div>

          <div className="card">
            <div className="card-head">
              <h3>Set budget</h3>
            </div>
            <div className="row">
              <div>
                <label>Account</label>
                <select
                  value={bAccount}
                  onChange={(e) => setBAccount(e.target.value)}
                >
                  <option value="">Select account…</option>
                  {accounts.map((a) => (
                    <option key={a.code} value={a.code}>
                      {a.code} {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Period</label>
                <select
                  value={bMonth}
                  onChange={(e) => setBMonth(e.target.value)}
                >
                  {MONTHS.map((m, i) => (
                    <option key={m} value={i}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Amount (KES)</label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={bAmount}
                  onChange={(e) => setBAmount(e.target.value)}
                />
              </div>
            </div>
            <button type="button" onClick={() => void saveBudget()}>
              Save budget
            </button>
          </div>
        </>
      )}

      {tab === "assets" && (
        <>
          <div className="card">
            <div className="row">
              <div>
                <label>Depreciation period</label>
                <input
                  type="month"
                  value={depPeriod}
                  onChange={(e) => setDepPeriod(e.target.value)}
                />
              </div>
              <div>
                <label>&nbsp;</label>
                <button type="button" onClick={() => void runDepreciation()}>
                  Run depreciation
                </button>
              </div>
            </div>
            {depResult && <p className="muted">{depResult}</p>}
          </div>

          <div className="card">
            <div className="card-head">
              <h3>Asset register</h3>
            </div>
            <DataTable
              rows={assets}
              columns={assetCols}
              searchKeys={["name"]}
              csvName="fixed-assets"
              empty={
                <p className="muted">
                  No fixed assets yet — add the first one below.
                </p>
              }
            />
          </div>

          <div className="card">
            <div className="card-head">
              <h3>New asset</h3>
            </div>
            <div className="row">
              <div>
                <label>Name</label>
                <input
                  value={aName}
                  onChange={(e) => setAName(e.target.value)}
                  placeholder="Delivery van"
                />
              </div>
              <div>
                <label>Cost (KES)</label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={aCost}
                  onChange={(e) => setACost(e.target.value)}
                />
              </div>
              <div>
                <label>Salvage (KES)</label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={aSalvage}
                  onChange={(e) => setASalvage(e.target.value)}
                />
              </div>
              <div>
                <label>Acquired</label>
                <input
                  type="date"
                  value={aAcquired}
                  onChange={(e) => setAAcquired(e.target.value)}
                />
              </div>
              <div>
                <label>Life (months)</label>
                <input
                  type="number"
                  min={1}
                  max={600}
                  value={aLife}
                  onChange={(e) => setALife(e.target.value)}
                />
              </div>
            </div>
            <button type="button" onClick={() => void createAsset()}>
              Add asset
            </button>
          </div>
        </>
      )}

      {tab === "recurring" && (
        <>
          <div className="card">
            <button type="button" onClick={() => void runRecurring()}>
              Run due now
            </button>
            <p className="muted" style={{ marginTop: 8 }}>
              Drafts one invoice per due template (next run on or before
              today) and advances the next run date one month. Drafts are
              issued manually from the Invoices page.
            </p>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>Templates</h3>
            </div>
            <DataTable
              rows={templates}
              columns={templateCols}
              searchKeys={["customer_name", "branch_name"]}
              csvName="recurring-invoices"
              empty={
                <p className="muted">
                  No recurring templates yet — create the first one below.
                </p>
              }
            />
          </div>

          <div className="card">
            <div className="card-head">
              <h3>New template</h3>
            </div>
            <div className="row">
              <div>
                <label>Customer</label>
                <select
                  value={rCustomer}
                  onChange={(e) => setRCustomer(e.target.value)}
                >
                  <option value="">Select customer…</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Branch</label>
                <select
                  value={rBranch}
                  onChange={(e) => setRBranch(e.target.value)}
                >
                  <option value="">Select branch…</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>First run</label>
                <input
                  type="date"
                  value={rNextRun}
                  onChange={(e) => setRNextRun(e.target.value)}
                />
              </div>
            </div>
            <label style={{ marginTop: 10 }}>Lines</label>
            {rLines.map((l, i) => (
              <div className="row" key={i}>
                <div style={{ flex: 2 }}>
                  <input
                    placeholder="Description"
                    value={l.description}
                    onChange={(e) =>
                      setRLines((ls) =>
                        ls.map((x, j) =>
                          j === i ? { ...x, description: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </div>
                <div>
                  <input
                    type="number"
                    min={0}
                    step="0.001"
                    placeholder="Qty"
                    value={l.quantity}
                    onChange={(e) =>
                      setRLines((ls) =>
                        ls.map((x, j) =>
                          j === i ? { ...x, quantity: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </div>
                <div>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="Unit price KES"
                    value={l.unitPriceKes}
                    onChange={(e) =>
                      setRLines((ls) =>
                        ls.map((x, j) =>
                          j === i
                            ? { ...x, unitPriceKes: e.target.value }
                            : x,
                        ),
                      )
                    }
                  />
                </div>
                <div>
                  <select
                    value={l.vatRate}
                    onChange={(e) =>
                      setRLines((ls) =>
                        ls.map((x, j) =>
                          j === i
                            ? {
                                ...x,
                                vatRate: e.target
                                  .value as LineDraft["vatRate"],
                              }
                            : x,
                        ),
                      )
                    }
                  >
                    <option value="0.16">VAT 16%</option>
                    <option value="0">Zero-rated</option>
                    <option value="exempt">Exempt</option>
                  </select>
                </div>
                <div>
                  <button
                    type="button"
                    className="secondary dt-btn"
                    disabled={rLines.length === 1}
                    onClick={() =>
                      setRLines((ls) => ls.filter((_, j) => j !== i))
                    }
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
            <button
              type="button"
              className="secondary"
              onClick={() =>
                setRLines((ls) => [
                  ...ls,
                  {
                    description: "",
                    quantity: "1",
                    unitPriceKes: "",
                    vatRate: "0.16",
                  },
                ])
              }
            >
              + Add line
            </button>{" "}
            <button type="button" onClick={() => void createTemplate()}>
              Create template
            </button>
          </div>
        </>
      )}
    </>
  );
}
