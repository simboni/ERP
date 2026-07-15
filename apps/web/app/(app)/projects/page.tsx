"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, fmtKes0 } from "@/lib/api";
import { DataTable } from "@/components/DataTable";

interface ProjectRow {
  id: string;
  name: string;
  status: "active" | "completed" | "archived";
  customer_id: string | null;
  customer_name: string | null;
  budget_cents: string | null;
  hourly_rate_cents: string | null;
  hours: string;
  unbilled_cents: string;
  expense_cents: string;
  entry_count: number;
}
interface TimeRow {
  id: string;
  entry_date: string;
  hours: string;
  note: string;
  billable: boolean;
  billed_invoice_id: string | null;
  employee_name: string | null;
  invoice_no: number | null;
  invoice_status: string | null;
}
interface ExpenseRow {
  id: string;
  expense_date: string;
  description: string;
  amount_cents: string;
  billable: boolean;
  billed_invoice_id: string | null;
  invoice_no: number | null;
  invoice_status: string | null;
}
interface Detail {
  project: {
    id: string;
    name: string;
    status: string;
    customer_id: string | null;
    customer_name: string | null;
    budget_cents: string | null;
    hourly_rate_cents: string | null;
  };
  time: TimeRow[];
  expenses: ExpenseRow[];
}
interface Profit {
  budgetCents: number | null;
  hourlyRateCents: number;
  hours: number;
  billedCents: number;
  unbilledCents: number;
  laborCostCents: number;
  expenseCents: number;
  costCents: number;
  marginCents: number;
  marginPct: number;
  budgetUsedPct: number | null;
}
interface Customer {
  id: string;
  name: string;
}
interface Employee {
  id: string;
  full_name: string;
}
interface Branch {
  id: string;
  name: string;
}

type Tab = "projects" | "time" | "expenses";
const STATUSES: ProjectRow["status"][] = ["active", "completed", "archived"];
const d10 = (s: string | null): string => s?.slice(0, 10) ?? "";
const today = (): string => new Date().toISOString().slice(0, 10);

function BilledPill({
  row,
}: {
  row: { billable: boolean; billed_invoice_id: string | null; invoice_no: number | null; invoice_status: string | null };
}) {
  if (!row.billable) return <span className="muted">non-billable</span>;
  if (!row.billed_invoice_id) return <span className="pill pending">unbilled</span>;
  return (
    <Link href={`/invoices/view?id=${row.billed_invoice_id}`}>
      <span className={`pill ${row.invoice_status === "paid" ? "paid" : "issued"}`}>
        {row.invoice_no ? `INV ${row.invoice_no}` : "draft"}
      </span>
    </Link>
  );
}

export default function ProjectsPage() {
  const [tab, setTab] = useState<Tab>("projects");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selId, setSelId] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [profit, setProfit] = useState<Profit | null>(null);
  const [billing, setBilling] = useState(false);
  const [billedInvoiceId, setBilledInvoiceId] = useState("");
  // new project form
  const [pName, setPName] = useState("");
  const [pCustomer, setPCustomer] = useState("");
  const [pBudget, setPBudget] = useState("");
  const [pRate, setPRate] = useState("");
  // log time form
  const [tDate, setTDate] = useState(today());
  const [tHours, setTHours] = useState("");
  const [tNote, setTNote] = useState("");
  const [tEmployee, setTEmployee] = useState("");
  const [tBillable, setTBillable] = useState(true);
  // expense form
  const [eDate, setEDate] = useState(today());
  const [eDesc, setEDesc] = useState("");
  const [eAmount, setEAmount] = useState("");
  const [eBillable, setEBillable] = useState(true);

  const fail = (e: unknown): void =>
    setError(e instanceof Error ? e.message : "failed");

  const load = useCallback(() => {
    Promise.all([
      api<ProjectRow[]>("/tenants/current/projects"),
      api<Customer[]>("/tenants/current/customers"),
      api<Employee[]>("/tenants/current/hr/employees").catch(() => []),
    ])
      .then(([p, c, e]) => {
        setProjects(p);
        setCustomers(c);
        setEmployees(e as Employee[]);
      })
      .catch(fail);
  }, []);

  const loadDetail = useCallback((id: string) => {
    if (!id) {
      setDetail(null);
      setProfit(null);
      return;
    }
    Promise.all([
      api<Detail>(`/tenants/current/projects/${id}`),
      api<Profit>(`/tenants/current/projects/${id}/profitability`).catch(
        () => null,
      ),
    ])
      .then(([d, pr]) => {
        setDetail(d);
        setProfit(pr);
      })
      .catch(fail);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, note?: string) => {
    setError("");
    setMsg("");
    try {
      await fn();
      if (note) setMsg(note);
      load();
      if (selId) loadDetail(selId);
    } catch (e) {
      fail(e);
    }
  };

  const select = (id: string, nextTab?: Tab): void => {
    setSelId(id);
    setBilledInvoiceId("");
    setError("");
    setMsg("");
    loadDetail(id);
    if (nextTab) setTab(nextTab);
  };

  const billUnbilled = async (): Promise<void> => {
    setError("");
    setMsg("");
    setBilling(true);
    try {
      const branches = await api<Branch[]>("/tenants/current/branches");
      if (!branches[0]) throw new Error("Create a branch first (Invoices → New)");
      const r = await api<{ invoiceId: string; timeEntries: number; expenses: number }>(
        `/tenants/current/projects/${selId}/bill`,
        { method: "POST", body: { branchId: branches[0].id } },
      );
      setBilledInvoiceId(r.invoiceId);
      setMsg(
        `Draft invoice created — ${r.timeEntries} time ${
          r.timeEntries === 1 ? "entry" : "entries"
        } and ${r.expenses} expense${r.expenses === 1 ? "" : "s"} billed.`,
      );
      load();
      loadDetail(selId);
    } catch (e) {
      fail(e);
    } finally {
      setBilling(false);
    }
  };

  const rate = detail ? Number(detail.project.hourly_rate_cents ?? 0) : 0;
  const projectPicker = (
    <div>
      <label>Project</label>
      <select value={selId} onChange={(e) => select(e.target.value)}>
        <option value="">Select…</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );

  const tiles =
    profit === null
      ? []
      : [
          { cls: "tile-4", value: fmtKes0(profit.billedCents), label: "Billed" },
          { cls: "tile-3", value: fmtKes0(profit.unbilledCents), label: "Unbilled" },
          { cls: "tile-2", value: fmtKes0(profit.costCents), label: "Cost" },
          {
            cls: "tile-1",
            value: fmtKes0(profit.marginCents),
            label: `Margin · ${profit.marginPct}%`,
          },
        ];

  return (
    <>
      <h1>Projects</h1>
      <div className="tabs">
        {(
          [
            ["projects", "Projects"],
            ["time", "Time"],
            ["expenses", "Expenses"],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={tab === key ? "tab active" : "tab"}
            onClick={() => {
              setTab(key);
              setError("");
              setMsg("");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <div className="err">{error}</div>}
      {msg && (
        <p className="muted">
          {msg}{" "}
          {billedInvoiceId && (
            <Link href={`/invoices/view?id=${billedInvoiceId}`}>
              View draft invoice →
            </Link>
          )}
        </p>
      )}

      {tab === "projects" && (
        <>
          <div className="card">
            <div className="card-head">
              <h3>New project</h3>
            </div>
            <div className="row">
              <div>
                <label>Name</label>
                <input
                  value={pName}
                  onChange={(e) => setPName(e.target.value)}
                  placeholder="e.g. Office fit-out — Nakuru"
                />
              </div>
              <div>
                <label>Customer (needed for billing)</label>
                <select
                  value={pCustomer}
                  onChange={(e) => setPCustomer(e.target.value)}
                >
                  <option value="">None (internal)</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Budget (KES, optional)</label>
                <input
                  type="number"
                  value={pBudget}
                  onChange={(e) => setPBudget(e.target.value)}
                />
              </div>
              <div>
                <label>Hourly rate (KES/h)</label>
                <input
                  type="number"
                  value={pRate}
                  onChange={(e) => setPRate(e.target.value)}
                />
              </div>
            </div>
            <button
              onClick={() =>
                void act(
                  () =>
                    api("/tenants/current/projects", {
                      method: "POST",
                      body: {
                        name: pName,
                        customerId: pCustomer || null,
                        budgetCents: pBudget
                          ? Math.round(Number(pBudget) * 100)
                          : null,
                        hourlyRateCents: pRate
                          ? Math.round(Number(pRate) * 100)
                          : null,
                      },
                    }),
                  "Project created.",
                )
              }
            >
              Add project
            </button>
          </div>

          <div className="card">
            <DataTable
              rows={projects}
              csvName="projects"
              searchKeys={["name", "customer"]}
              pageSizeDefault={10}
              empty={
                <div className="empty">
                  <span className="empty-icon">📁</span>
                  <p>No projects yet — create your first one above.</p>
                </div>
              }
              columns={[
                {
                  key: "name",
                  label: "Name",
                  render: (p) => (
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        select(p.id);
                      }}
                    >
                      {p.name}
                    </a>
                  ),
                },
                {
                  key: "customer",
                  label: "Customer",
                  value: (p) => p.customer_name ?? "",
                  render: (p) => (
                    <span className="muted">{p.customer_name ?? "—"}</span>
                  ),
                },
                {
                  key: "status",
                  label: "Status",
                  render: (p) => (
                    <span
                      className={`pill ${
                        p.status === "active"
                          ? "issued"
                          : p.status === "completed"
                            ? "paid"
                            : "pending"
                      }`}
                    >
                      {p.status}
                    </span>
                  ),
                },
                {
                  key: "hours",
                  label: "Hours",
                  num: true,
                  value: (p) => Number(p.hours),
                },
                {
                  key: "unbilled_cents",
                  label: "Unbilled",
                  num: true,
                  value: (p) => Number(p.unbilled_cents),
                  render: (p) => fmtKes0(p.unbilled_cents),
                },
                {
                  key: "expense_cents",
                  label: "Expenses",
                  num: true,
                  value: (p) => Number(p.expense_cents),
                  render: (p) => fmtKes0(p.expense_cents),
                },
                {
                  key: "budget_cents",
                  label: "Budget",
                  num: true,
                  value: (p) => (p.budget_cents ? Number(p.budget_cents) : null),
                  render: (p) =>
                    p.budget_cents ? fmtKes0(p.budget_cents) : "—",
                },
                {
                  key: "actions",
                  label: "",
                  value: () => "",
                  render: (p) => (
                    <span style={{ whiteSpace: "nowrap", display: "inline-flex", gap: 6 }}>
                      <select
                        value={p.status}
                        onChange={(e) =>
                          void act(() =>
                            api(`/tenants/current/projects/${p.id}`, {
                              method: "PATCH",
                              body: { status: e.target.value },
                            }),
                          )
                        }
                        style={{ width: "auto", padding: "4px 8px" }}
                      >
                        {STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                      {p.entry_count === 0 && (
                        <button
                          type="button"
                          className="secondary"
                          style={{ marginTop: 0, padding: "4px 12px" }}
                          onClick={() =>
                            void act(
                              () =>
                                api(`/tenants/current/projects/${p.id}`, {
                                  method: "DELETE",
                                }),
                              "Project deleted.",
                            )
                          }
                        >
                          Delete
                        </button>
                      )}
                    </span>
                  ),
                },
              ]}
            />
          </div>

          {detail && profit && (
            <div className="card">
              <div className="card-head">
                <h3>
                  {detail.project.name}
                  {detail.project.customer_name && (
                    <span className="muted"> · {detail.project.customer_name}</span>
                  )}
                </h3>
                {Number(profit.unbilledCents) > 0 &&
                  detail.project.customer_id && (
                    <button
                      type="button"
                      disabled={billing}
                      onClick={() => void billUnbilled()}
                      style={{ marginTop: 0 }}
                    >
                      {billing ? "Billing…" : "Bill unbilled work"}
                    </button>
                  )}
              </div>
              <div className="tiles">
                {tiles.map((tile) => (
                  <div key={tile.label} className={`tile ${tile.cls}`}>
                    <div className="tile-value">{tile.value}</div>
                    <div className="tile-label">{tile.label}</div>
                  </div>
                ))}
              </div>
              <p className="muted">
                {profit.hours}h logged · labour {fmtKes0(profit.laborCostCents)} ·
                expenses {fmtKes0(profit.expenseCents)} · rate{" "}
                {fmtKes0(profit.hourlyRateCents)}/h
              </p>
              {profit.budgetCents !== null && profit.budgetUsedPct !== null && (
                <div className="bar-row">
                  <span className="bar-label">Budget</span>
                  <span className="bar-track">
                    <span
                      className="bar-fill"
                      style={{
                        width: `${Math.min(100, profit.budgetUsedPct)}%`,
                        background:
                          profit.budgetUsedPct > 100
                            ? "var(--danger, #b3261e)"
                            : "var(--ok, #0b6b38)",
                      }}
                    />
                  </span>
                  <span className="bar-amt">
                    {fmtKes0(profit.costCents)}{" "}
                    <span className="muted">
                      / {fmtKes0(profit.budgetCents)} ({profit.budgetUsedPct}%)
                    </span>
                  </span>
                </div>
              )}
              <div className="row">
                <div>
                  <h4>Time</h4>
                  <DataTable
                    rows={detail.time}
                    pageSizeDefault={10}
                    empty={<p className="muted">No time logged yet.</p>}
                    columns={[
                      {
                        key: "entry_date",
                        label: "Date",
                        value: (r) => d10(r.entry_date),
                      },
                      { key: "note", label: "Note", value: (r) => r.note || "—" },
                      {
                        key: "hours",
                        label: "Hours",
                        num: true,
                        value: (r) => Number(r.hours),
                      },
                      {
                        key: "billed",
                        label: "Billed",
                        value: (r) => (r.billed_invoice_id ? "yes" : "no"),
                        render: (r) => <BilledPill row={r} />,
                      },
                    ]}
                  />
                </div>
                <div>
                  <h4>Expenses</h4>
                  <DataTable
                    rows={detail.expenses}
                    pageSizeDefault={10}
                    empty={<p className="muted">No expenses yet.</p>}
                    columns={[
                      {
                        key: "expense_date",
                        label: "Date",
                        value: (r) => d10(r.expense_date),
                      },
                      { key: "description", label: "Description" },
                      {
                        key: "amount_cents",
                        label: "Amount",
                        num: true,
                        value: (r) => Number(r.amount_cents),
                        render: (r) => fmtKes0(r.amount_cents),
                      },
                      {
                        key: "billed",
                        label: "Billed",
                        value: (r) => (r.billed_invoice_id ? "yes" : "no"),
                        render: (r) => <BilledPill row={r} />,
                      },
                    ]}
                  />
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {tab === "time" && (
        <>
          <div className="card">
            <div className="card-head">
              <h3>Log time</h3>
            </div>
            <div className="row">
              {projectPicker}
              <div>
                <label>Date</label>
                <input
                  type="date"
                  value={tDate}
                  onChange={(e) => setTDate(e.target.value)}
                />
              </div>
              <div>
                <label>Hours</label>
                <input
                  type="number"
                  step="0.25"
                  value={tHours}
                  onChange={(e) => setTHours(e.target.value)}
                />
              </div>
              <div>
                <label>Employee (optional)</label>
                <select
                  value={tEmployee}
                  onChange={(e) => setTEmployee(e.target.value)}
                >
                  <option value="">—</option>
                  {employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.full_name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <label>Note</label>
            <input
              value={tNote}
              onChange={(e) => setTNote(e.target.value)}
              placeholder="e.g. Site survey"
            />
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={tBillable}
                onChange={(e) => setTBillable(e.target.checked)}
                style={{ width: "auto" }}
              />
              Billable
            </label>
            <button
              disabled={!selId}
              onClick={() =>
                void act(
                  () =>
                    api(`/tenants/current/projects/${selId}/time`, {
                      method: "POST",
                      body: {
                        entryDate: tDate,
                        hours: Number(tHours),
                        note: tNote,
                        billable: tBillable,
                        employeeId: tEmployee || null,
                      },
                    }),
                  "Time logged.",
                )
              }
            >
              Log time
            </button>
            {!selId && (
              <p className="muted">Pick a project to log time against.</p>
            )}
          </div>

          {detail && (
            <div className="card">
              <DataTable
                rows={detail.time}
                csvName="project-time"
                searchKeys={["note", "employee"]}
                pageSizeDefault={10}
                empty={<p className="muted">No time logged on this project yet.</p>}
                columns={[
                  {
                    key: "entry_date",
                    label: "Date",
                    value: (r) => d10(r.entry_date),
                  },
                  {
                    key: "employee",
                    label: "Employee",
                    value: (r) => r.employee_name ?? "",
                    render: (r) => (
                      <span className="muted">{r.employee_name ?? "—"}</span>
                    ),
                  },
                  { key: "note", label: "Note", value: (r) => r.note || "—" },
                  {
                    key: "hours",
                    label: "Hours",
                    num: true,
                    value: (r) => Number(r.hours),
                  },
                  {
                    key: "amount",
                    label: "Amount",
                    num: true,
                    value: (r) => Math.round(Number(r.hours) * rate),
                    render: (r) => fmtKes0(Math.round(Number(r.hours) * rate)),
                  },
                  {
                    key: "billed",
                    label: "Billed",
                    value: (r) => (r.billed_invoice_id ? "yes" : "no"),
                    render: (r) => <BilledPill row={r} />,
                  },
                  {
                    key: "actions",
                    label: "",
                    value: () => "",
                    render: (r) =>
                      r.billed_invoice_id ? null : (
                        <button
                          type="button"
                          className="secondary"
                          style={{ marginTop: 0, padding: "4px 12px" }}
                          onClick={() =>
                            void act(
                              () =>
                                api(
                                  `/tenants/current/projects/${selId}/time/${r.id}`,
                                  { method: "DELETE" },
                                ),
                              "Time entry deleted.",
                            )
                          }
                        >
                          Delete
                        </button>
                      ),
                  },
                ]}
              />
            </div>
          )}
        </>
      )}

      {tab === "expenses" && (
        <>
          <div className="card">
            <div className="card-head">
              <h3>Record project expense</h3>
            </div>
            <div className="row">
              {projectPicker}
              <div>
                <label>Date</label>
                <input
                  type="date"
                  value={eDate}
                  onChange={(e) => setEDate(e.target.value)}
                />
              </div>
              <div>
                <label>Description</label>
                <input
                  value={eDesc}
                  onChange={(e) => setEDesc(e.target.value)}
                  placeholder="e.g. Site transport"
                />
              </div>
              <div>
                <label>Amount (KES)</label>
                <input
                  type="number"
                  value={eAmount}
                  onChange={(e) => setEAmount(e.target.value)}
                />
              </div>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={eBillable}
                onChange={(e) => setEBillable(e.target.checked)}
                style={{ width: "auto" }}
              />
              Billable to customer
            </label>
            <button
              disabled={!selId}
              onClick={() =>
                void act(
                  () =>
                    api(`/tenants/current/projects/${selId}/expenses`, {
                      method: "POST",
                      body: {
                        expenseDate: eDate,
                        description: eDesc,
                        amountCents: Math.round(Number(eAmount) * 100),
                        billable: eBillable,
                      },
                    }),
                  "Expense recorded.",
                )
              }
            >
              Record expense
            </button>
            {!selId && (
              <p className="muted">Pick a project to record expenses against.</p>
            )}
          </div>

          {detail && (
            <div className="card">
              <DataTable
                rows={detail.expenses}
                csvName="project-expenses"
                searchKeys={["description"]}
                pageSizeDefault={10}
                empty={<p className="muted">No expenses on this project yet.</p>}
                columns={[
                  {
                    key: "expense_date",
                    label: "Date",
                    value: (r) => d10(r.expense_date),
                  },
                  { key: "description", label: "Description" },
                  {
                    key: "amount_cents",
                    label: "Amount",
                    num: true,
                    value: (r) => Number(r.amount_cents),
                    render: (r) => fmtKes0(r.amount_cents),
                  },
                  {
                    key: "billed",
                    label: "Billed",
                    value: (r) => (r.billed_invoice_id ? "yes" : "no"),
                    render: (r) => <BilledPill row={r} />,
                  },
                  {
                    key: "actions",
                    label: "",
                    value: () => "",
                    render: (r) =>
                      r.billed_invoice_id ? null : (
                        <button
                          type="button"
                          className="secondary"
                          style={{ marginTop: 0, padding: "4px 12px" }}
                          onClick={() =>
                            void act(
                              () =>
                                api(
                                  `/tenants/current/projects/${selId}/expenses/${r.id}`,
                                  { method: "DELETE" },
                                ),
                              "Expense deleted.",
                            )
                          }
                        >
                          Delete
                        </button>
                      ),
                  },
                ]}
              />
            </div>
          )}
        </>
      )}
    </>
  );
}
