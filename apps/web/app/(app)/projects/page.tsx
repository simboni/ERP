"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, fmtKes0 } from "@/lib/api";
import { DataTable } from "@/components/DataTable";
import { SearchSelect } from "@/components/SearchSelect";
import { useI18n, type TKey } from "@/lib/i18n";

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
interface ProjectMeta {
  id: string;
  name: string;
  status: string;
  customer_id: string | null;
  customer_name: string | null;
  budget_cents: string | null;
  hourly_rate_cents: string | null;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  manager_employee_id: string | null;
  manager_name: string | null;
}
interface Detail {
  project: ProjectMeta;
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
type TaskStatus = "todo" | "in_progress" | "blocked" | "done";
type TaskPriority = "low" | "medium" | "high";
interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee_employee_id: string | null;
  assignee_name: string | null;
  due_date: string | null;
  estimate_hours: string | null;
  sort_order: number;
  completed_at: string | null;
}
interface MyTask extends Task {
  project_name: string;
}
interface Milestone {
  id: string;
  project_id: string;
  name: string;
  due_date: string | null;
  status: "open" | "reached";
  reached_at: string | null;
}
interface Summary {
  tasks: {
    total: number;
    todo: number;
    in_progress: number;
    blocked: number;
    done: number;
    pctComplete: number;
    estimateHours: number;
  };
  milestones: { total: number; reached: number; pct: number };
  hoursLogged: number;
  estimateHours: number;
  budgetCents: number | null;
  costCents: number;
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

type Tab = "projects" | "mytasks" | "time" | "expenses";
type SubTab = "overview" | "board" | "milestones" | "time" | "expenses";
const STATUSES: ProjectRow["status"][] = ["active", "completed", "archived"];
const d10 = (s: string | null): string => s?.slice(0, 10) ?? "";
const today = (): string => new Date().toISOString().slice(0, 10);

const BOARD: { key: TaskStatus; label: TKey }[] = [
  { key: "todo", label: "pjTodo" },
  { key: "in_progress", label: "pjInProgress" },
  { key: "blocked", label: "pjBlocked" },
  { key: "done", label: "pjDone" },
];
const PRIORITIES: { key: TaskPriority; label: TKey }[] = [
  { key: "high", label: "pjHigh" },
  { key: "medium", label: "pjMedium" },
  { key: "low", label: "pjLow" },
];
const statusPill = (s: TaskStatus): string =>
  s === "done" ? "paid" : s === "in_progress" ? "issued" : s === "blocked" ? "overdue" : "pending";
const priorityPill = (p: TaskPriority): string =>
  p === "high" ? "overdue" : p === "medium" ? "issued" : "pending";

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

const emptyTaskForm = {
  id: "",
  title: "",
  description: "",
  status: "todo" as TaskStatus,
  priority: "medium" as TaskPriority,
  assignee: "",
  dueDate: "",
  estimate: "",
};

export default function ProjectsPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("projects");
  const [subTab, setSubTab] = useState<SubTab>("overview");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selId, setSelId] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [profit, setProfit] = useState<Profit | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [billing, setBilling] = useState(false);
  const [billedInvoiceId, setBilledInvoiceId] = useState("");
  // my tasks
  const [myTasks, setMyTasks] = useState<MyTask[]>([]);
  const [myAssignee, setMyAssignee] = useState("");
  // new project form
  const [pName, setPName] = useState("");
  const [pCustomer, setPCustomer] = useState("");
  const [pBudget, setPBudget] = useState("");
  const [pRate, setPRate] = useState("");
  // task form (create/edit)
  const [tf, setTf] = useState({ ...emptyTaskForm });
  // milestone form
  const [mName, setMName] = useState("");
  const [mDue, setMDue] = useState("");
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

  const empOpts = employees.map((e) => ({ id: e.id, label: e.full_name }));
  const custOpts = customers.map((c) => ({ id: c.id, label: c.name }));

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
      setSummary(null);
      setTasks([]);
      setMilestones([]);
      return;
    }
    Promise.all([
      api<Detail>(`/tenants/current/projects/${id}`),
      api<Profit>(`/tenants/current/projects/${id}/profitability`).catch(() => null),
      api<Summary>(`/tenants/current/projects/${id}/summary`).catch(() => null),
      api<Task[]>(`/tenants/current/projects/${id}/tasks`).catch(() => []),
      api<Milestone[]>(`/tenants/current/projects/${id}/milestones`).catch(() => []),
    ])
      .then(([d, pr, s, tk, ms]) => {
        setDetail(d);
        setProfit(pr);
        setSummary(s);
        setTasks(tk);
        setMilestones(ms);
      })
      .catch(fail);
  }, []);

  const loadMyTasks = useCallback((assignee: string) => {
    const qs = assignee ? `?assignee=${assignee}` : "";
    api<MyTask[]>(`/tenants/current/projects/tasks/mine${qs}`)
      .then(setMyTasks)
      .catch(fail);
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (tab === "mytasks") loadMyTasks(myAssignee);
  }, [tab, myAssignee, loadMyTasks]);

  const act = async (fn: () => Promise<unknown>, note?: string) => {
    setError("");
    setMsg("");
    try {
      await fn();
      if (note) setMsg(note);
      load();
      if (selId) loadDetail(selId);
      if (tab === "mytasks") loadMyTasks(myAssignee);
    } catch (e) {
      fail(e);
    }
  };

  const select = (id: string, nextTab?: Tab): void => {
    setSelId(id);
    setBilledInvoiceId("");
    setError("");
    setMsg("");
    setSubTab("overview");
    setTf({ ...emptyTaskForm });
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

  // ---- task helpers --------------------------------------------------------
  const editTask = (task: Task): void => {
    setTf({
      id: task.id,
      title: task.title,
      description: task.description ?? "",
      status: task.status,
      priority: task.priority,
      assignee: task.assignee_employee_id ?? "",
      dueDate: d10(task.due_date),
      estimate: task.estimate_hours ? String(Number(task.estimate_hours)) : "",
    });
    setSubTab("board");
  };

  const saveTask = (): void => {
    const body = {
      title: tf.title,
      description: tf.description,
      status: tf.status,
      priority: tf.priority,
      assigneeEmployeeId: tf.assignee || null,
      dueDate: tf.dueDate || null,
      estimateHours: tf.estimate ? Number(tf.estimate) : null,
    };
    void act(() => {
      const url = tf.id
        ? `/tenants/current/projects/${selId}/tasks/${tf.id}`
        : `/tenants/current/projects/${selId}/tasks`;
      return api(url, { method: tf.id ? "PATCH" : "POST", body }).then(() =>
        setTf({ ...emptyTaskForm }),
      );
    }, tf.id ? t("pjTaskUpdated") : t("pjTaskAdded"));
  };

  const moveTask = (task: Task, status: TaskStatus): void =>
    void act(() =>
      api(`/tenants/current/projects/${selId}/tasks/${task.id}`, {
        method: "PATCH",
        body: { status },
      }),
    );

  const rate = detail ? Number(detail.project.hourly_rate_cents ?? 0) : 0;
  const projectPicker = (
    <div>
      <label>{t("pjProject")}</label>
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

  // ---- task card + form ----------------------------------------------------
  const TaskCard = ({ task }: { task: Task }) => (
    <div className="pipe-card">
      <strong>{task.title}</strong>
      <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
        <span className={`pill ${priorityPill(task.priority)}`}>
          {t(PRIORITIES.find((p) => p.key === task.priority)!.label)}
        </span>
        {task.due_date && <span className="muted">⏱ {d10(task.due_date)}</span>}
      </span>
      <span className="muted">
        {task.assignee_name ?? t("pjUnassigned")}
        {task.estimate_hours ? ` · ${Number(task.estimate_hours)}h` : ""}
      </span>
      <select
        value={task.status}
        onChange={(e) => moveTask(task, e.target.value as TaskStatus)}
      >
        {BOARD.map((s) => (
          <option key={s.key} value={s.key}>
            {t(s.label)}
          </option>
        ))}
      </select>
      <span style={{ display: "inline-flex", gap: 10 }}>
        <a href="#" onClick={(e) => { e.preventDefault(); editTask(task); }}>
          {t("pjEditTask")}
        </a>
        <a
          href="#"
          className="muted"
          onClick={(e) => {
            e.preventDefault();
            void act(
              () =>
                api(`/tenants/current/projects/${selId}/tasks/${task.id}`, {
                  method: "DELETE",
                }),
              t("pjTaskDeleted"),
            );
          }}
        >
          {t("pjDelete")}
        </a>
      </span>
    </div>
  );

  const taskForm = (
    <div className="card">
      <div className="card-head">
        <h3>{tf.id ? t("pjEditTask") : t("pjNewTask")}</h3>
        {tf.id && (
          <button
            type="button"
            className="secondary"
            style={{ marginTop: 0 }}
            onClick={() => setTf({ ...emptyTaskForm })}
          >
            {t("pjCancel")}
          </button>
        )}
      </div>
      <div className="row">
        <div style={{ flex: 2 }}>
          <label>{t("pjTitle")}</label>
          <input
            value={tf.title}
            onChange={(e) => setTf({ ...tf, title: e.target.value })}
            placeholder="e.g. Site survey"
          />
        </div>
        <div>
          <label>{t("pjAssignee")}</label>
          <SearchSelect
            options={empOpts}
            value={tf.assignee}
            onChange={(id) => setTf({ ...tf, assignee: id })}
            placeholder={t("pjUnassigned")}
          />
        </div>
        <div>
          <label>{t("pjPriority")}</label>
          <select
            value={tf.priority}
            onChange={(e) => setTf({ ...tf, priority: e.target.value as TaskPriority })}
          >
            {PRIORITIES.map((p) => (
              <option key={p.key} value={p.key}>
                {t(p.label)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>{t("pjDueDate")}</label>
          <input
            type="date"
            value={tf.dueDate}
            onChange={(e) => setTf({ ...tf, dueDate: e.target.value })}
          />
        </div>
        <div>
          <label>{t("pjEstimate")}</label>
          <input
            type="number"
            step="0.25"
            value={tf.estimate}
            onChange={(e) => setTf({ ...tf, estimate: e.target.value })}
          />
        </div>
        {tf.id && (
          <div>
            <label>{t("status")}</label>
            <select
              value={tf.status}
              onChange={(e) => setTf({ ...tf, status: e.target.value as TaskStatus })}
            >
              {BOARD.map((s) => (
                <option key={s.key} value={s.key}>
                  {t(s.label)}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <label>{t("pjDescription")}</label>
      <input
        value={tf.description}
        onChange={(e) => setTf({ ...tf, description: e.target.value })}
        placeholder="Optional details"
      />
      <button disabled={!tf.title.trim()} onClick={saveTask}>
        {tf.id ? t("pjSaveTask") : t("pjAddTask")}
      </button>
    </div>
  );

  return (
    <>
      <h1>Projects</h1>
      <div className="tabs">
        {(
          [
            ["projects", "Projects"],
            ["mytasks", t("pjMyTasks")],
            ["time", t("pjTime")],
            ["expenses", t("pjExpenses")],
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

      {tab === "projects" && !detail && (
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
                <SearchSelect
                  options={custOpts}
                  value={pCustomer}
                  onChange={setPCustomer}
                  placeholder="None (internal)"
                />
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
                        budgetCents: pBudget ? Math.round(Number(pBudget) * 100) : null,
                        hourlyRateCents: pRate ? Math.round(Number(pRate) * 100) : null,
                      },
                    }).then(() => {
                      setPName("");
                      setPCustomer("");
                      setPBudget("");
                      setPRate("");
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
                  render: (p) => <span className="muted">{p.customer_name ?? "—"}</span>,
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
                { key: "hours", label: "Hours", num: true, value: (p) => Number(p.hours) },
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
                  render: (p) => (p.budget_cents ? fmtKes0(p.budget_cents) : "—"),
                },
                {
                  key: "actions",
                  label: "",
                  value: () => "",
                  render: (p) => (
                    <span style={{ whiteSpace: "nowrap", display: "inline-flex", gap: 6 }}>
                      <button
                        type="button"
                        className="secondary"
                        style={{ marginTop: 0, padding: "4px 12px" }}
                        onClick={() => select(p.id)}
                      >
                        {t("pjOverview")}
                      </button>
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
                    </span>
                  ),
                },
              ]}
            />
          </div>
        </>
      )}

      {/* ---- Project detail workspace ---- */}
      {tab === "projects" && detail && (
        <>
          <div className="card">
            <div className="card-head">
              <h3>
                {detail.project.name}
                {detail.project.customer_name && (
                  <span className="muted"> · {detail.project.customer_name}</span>
                )}
              </h3>
              <button
                type="button"
                className="secondary"
                style={{ marginTop: 0 }}
                onClick={() => {
                  setSelId("");
                  setDetail(null);
                  setProfit(null);
                  setSummary(null);
                }}
              >
                {t("pjBackToList")}
              </button>
            </div>
            <p className="muted">
              {[
                detail.project.manager_name && `${t("pjManager")}: ${detail.project.manager_name}`,
                detail.project.start_date && `${t("pjStartDate")}: ${d10(detail.project.start_date)}`,
                detail.project.end_date && `${t("pjEndDate")}: ${d10(detail.project.end_date)}`,
                `${t("status")}: ${detail.project.status}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <div className="tabs">
              {(
                [
                  ["overview", t("pjOverview")],
                  ["board", t("pjBoard")],
                  ["milestones", t("pjMilestones")],
                  ["time", t("pjTime")],
                  ["expenses", t("pjExpenses")],
                ] as [SubTab, string][]
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={subTab === key ? "tab active" : "tab"}
                  onClick={() => setSubTab(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {subTab === "overview" && profit && (
            <div className="card">
              <div className="card-head">
                <h3>{t("pjOverview")}</h3>
                {Number(profit.unbilledCents) > 0 && detail.project.customer_id && (
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
              {summary && (
                <>
                  <div className="bar-row">
                    <span className="bar-label">{t("pjPctComplete")}</span>
                    <span className="bar-track">
                      <span
                        className="bar-fill"
                        style={{
                          width: `${summary.tasks.pctComplete}%`,
                          background: "var(--ok, #0b6b38)",
                        }}
                      />
                    </span>
                    <span className="bar-amt">
                      {summary.tasks.done}/{summary.tasks.total}{" "}
                      <span className="muted">({summary.tasks.pctComplete}%)</span>
                    </span>
                  </div>
                  <div className="bar-row">
                    <span className="bar-label">{t("pjMilestones")}</span>
                    <span className="bar-track">
                      <span
                        className="bar-fill"
                        style={{
                          width: `${summary.milestones.pct}%`,
                          background: "var(--info, #1c62c9)",
                        }}
                      />
                    </span>
                    <span className="bar-amt">
                      {summary.milestones.reached}/{summary.milestones.total}{" "}
                      <span className="muted">({summary.milestones.pct}%)</span>
                    </span>
                  </div>
                  <div className="bar-row">
                    <span className="bar-label">{t("pjHoursVsEstimate")}</span>
                    <span className="bar-track">
                      <span
                        className="bar-fill"
                        style={{
                          width: `${
                            summary.estimateHours > 0
                              ? Math.min(100, (summary.hoursLogged / summary.estimateHours) * 100)
                              : 0
                          }%`,
                          background:
                            summary.estimateHours > 0 && summary.hoursLogged > summary.estimateHours
                              ? "var(--danger, #b3261e)"
                              : "var(--ok, #0b6b38)",
                        }}
                      />
                    </span>
                    <span className="bar-amt">
                      {summary.hoursLogged}h{" "}
                      <span className="muted">
                        / {summary.estimateHours}h est
                      </span>
                    </span>
                  </div>
                </>
              )}
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
              <p className="muted">
                {profit.hours}h logged · labour {fmtKes0(profit.laborCostCents)} · expenses{" "}
                {fmtKes0(profit.expenseCents)} · rate {fmtKes0(profit.hourlyRateCents)}/h
              </p>
            </div>
          )}

          {subTab === "board" && (
            <>
              {taskForm}
              <div className="card">
                <div className="card-head">
                  <h3>{t("pjTasks")}</h3>
                </div>
                {tasks.length === 0 ? (
                  <p className="muted">{t("pjNoTasks")}</p>
                ) : (
                  <div
                    className="pipeline"
                    style={{ gridTemplateColumns: "repeat(4, minmax(160px, 1fr))" }}
                  >
                    {BOARD.map(({ key, label }) => {
                      const col = tasks.filter((tk) => tk.status === key);
                      return (
                        <div key={key} className="pipe-col">
                          <div className="pipe-head">
                            <span>{t(label)}</span>
                            <span className="muted">{col.length}</span>
                          </div>
                          {col.map((task) => (
                            <TaskCard key={task.id} task={task} />
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}

          {subTab === "milestones" && (
            <div className="card">
              <div className="card-head">
                <h3>{t("pjMilestones")}</h3>
              </div>
              <div className="row">
                <div style={{ flex: 2 }}>
                  <label>{t("pjMilestoneName")}</label>
                  <input
                    value={mName}
                    onChange={(e) => setMName(e.target.value)}
                    placeholder="e.g. Phase 1 sign-off"
                  />
                </div>
                <div>
                  <label>{t("pjDueDate")}</label>
                  <input
                    type="date"
                    value={mDue}
                    onChange={(e) => setMDue(e.target.value)}
                  />
                </div>
              </div>
              <button
                disabled={!mName.trim()}
                onClick={() =>
                  void act(
                    () =>
                      api(`/tenants/current/projects/${selId}/milestones`, {
                        method: "POST",
                        body: { name: mName, dueDate: mDue || null },
                      }).then(() => {
                        setMName("");
                        setMDue("");
                      }),
                    t("pjMilestoneAdded"),
                  )
                }
              >
                {t("pjAddMilestone")}
              </button>
              {milestones.length === 0 ? (
                <p className="muted">{t("pjNoMilestones")}</p>
              ) : (
                <DataTable
                  rows={milestones}
                  pageSizeDefault={10}
                  columns={[
                    { key: "name", label: t("pjMilestoneName") },
                    {
                      key: "due_date",
                      label: t("pjDueDate"),
                      value: (m) => d10(m.due_date),
                      render: (m) => (m.due_date ? d10(m.due_date) : "—"),
                    },
                    {
                      key: "status",
                      label: t("status"),
                      render: (m) => (
                        <span className={`pill ${m.status === "reached" ? "paid" : "pending"}`}>
                          {m.status === "reached" ? t("pjReached") : t("pjOpen")}
                        </span>
                      ),
                    },
                    {
                      key: "actions",
                      label: "",
                      value: () => "",
                      render: (m) => (
                        <span style={{ display: "inline-flex", gap: 6 }}>
                          <button
                            type="button"
                            className="secondary"
                            style={{ marginTop: 0, padding: "4px 12px" }}
                            onClick={() =>
                              void act(() =>
                                api(
                                  `/tenants/current/projects/${selId}/milestones/${m.id}`,
                                  {
                                    method: "PATCH",
                                    body: {
                                      status: m.status === "reached" ? "open" : "reached",
                                    },
                                  },
                                ),
                              )
                            }
                          >
                            {m.status === "reached" ? t("pjReopen") : t("pjMarkReached")}
                          </button>
                          <button
                            type="button"
                            className="secondary"
                            style={{ marginTop: 0, padding: "4px 12px" }}
                            onClick={() =>
                              void act(() =>
                                api(
                                  `/tenants/current/projects/${selId}/milestones/${m.id}`,
                                  { method: "DELETE" },
                                ),
                              )
                            }
                          >
                            {t("pjDelete")}
                          </button>
                        </span>
                      ),
                    },
                  ]}
                />
              )}
            </div>
          )}

          {subTab === "time" && (
            <div className="card">
              <h4>{t("pjTime")}</h4>
              <DataTable
                rows={detail.time}
                csvName="project-time"
                searchKeys={["note", "employee"]}
                pageSizeDefault={10}
                empty={<p className="muted">No time logged yet. Use the Time tab to log it.</p>}
                columns={[
                  { key: "entry_date", label: "Date", value: (r) => d10(r.entry_date) },
                  {
                    key: "employee",
                    label: "Employee",
                    value: (r) => r.employee_name ?? "",
                    render: (r) => <span className="muted">{r.employee_name ?? "—"}</span>,
                  },
                  { key: "note", label: "Note", value: (r) => r.note || "—" },
                  { key: "hours", label: "Hours", num: true, value: (r) => Number(r.hours) },
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
                ]}
              />
            </div>
          )}

          {subTab === "expenses" && (
            <div className="card">
              <h4>{t("pjExpenses")}</h4>
              <DataTable
                rows={detail.expenses}
                csvName="project-expenses"
                searchKeys={["description"]}
                pageSizeDefault={10}
                empty={<p className="muted">No expenses yet. Use the Expenses tab to record them.</p>}
                columns={[
                  { key: "expense_date", label: "Date", value: (r) => d10(r.expense_date) },
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
          )}
        </>
      )}

      {/* ---- My tasks ---- */}
      {tab === "mytasks" && (
        <div className="card">
          <div className="card-head">
            <h3>{t("pjMyTasks")}</h3>
            <div style={{ minWidth: 220 }}>
              <SearchSelect
                options={empOpts}
                value={myAssignee}
                onChange={setMyAssignee}
                placeholder={t("pjAllAssignees")}
              />
            </div>
          </div>
          {myAssignee && (
            <p className="muted">
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setMyAssignee("");
                }}
              >
                {t("pjAllAssignees")}
              </a>
            </p>
          )}
          {myTasks.length === 0 ? (
            <p className="muted">{t("pjNoMyTasks")}</p>
          ) : (
            BOARD.map(({ key, label }) => {
              const group = myTasks.filter((tk) => tk.status === key);
              if (group.length === 0) return null;
              return (
                <div key={key} style={{ marginTop: 14 }}>
                  <h4>
                    {t(label)}{" "}
                    <span className="muted" style={{ fontWeight: 500 }}>
                      · {group.length}
                    </span>
                  </h4>
                  <DataTable
                    rows={group}
                    searchKeys={["title", "project"]}
                    pageSizeDefault={10}
                    columns={[
                      {
                        key: "title",
                        label: t("pjTitle"),
                        render: (r) => (
                          <a
                            href="#"
                            onClick={(e) => {
                              e.preventDefault();
                              select(r.project_id, "projects");
                              setSubTab("board");
                            }}
                          >
                            {r.title}
                          </a>
                        ),
                      },
                      {
                        key: "project",
                        label: t("pjProject"),
                        value: (r) => r.project_name,
                        render: (r) => <span className="muted">{r.project_name}</span>,
                      },
                      {
                        key: "assignee",
                        label: t("pjAssignee"),
                        value: (r) => r.assignee_name ?? "",
                        render: (r) => (
                          <span className="muted">{r.assignee_name ?? t("pjUnassigned")}</span>
                        ),
                      },
                      {
                        key: "priority",
                        label: t("pjPriority"),
                        value: (r) => r.priority,
                        render: (r) => (
                          <span className={`pill ${priorityPill(r.priority)}`}>
                            {t(PRIORITIES.find((p) => p.key === r.priority)!.label)}
                          </span>
                        ),
                      },
                      {
                        key: "due_date",
                        label: t("pjDueDate"),
                        value: (r) => d10(r.due_date),
                        render: (r) => (r.due_date ? d10(r.due_date) : "—"),
                      },
                    ]}
                  />
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ---- Log time ---- */}
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
                <input type="date" value={tDate} onChange={(e) => setTDate(e.target.value)} />
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
                <SearchSelect
                  options={empOpts}
                  value={tEmployee}
                  onChange={setTEmployee}
                  placeholder="—"
                />
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
                    }).then(() => setTHours("")),
                  "Time logged.",
                )
              }
            >
              Log time
            </button>
            {!selId && <p className="muted">Pick a project to log time against.</p>}
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
                  { key: "entry_date", label: "Date", value: (r) => d10(r.entry_date) },
                  {
                    key: "employee",
                    label: "Employee",
                    value: (r) => r.employee_name ?? "",
                    render: (r) => <span className="muted">{r.employee_name ?? "—"}</span>,
                  },
                  { key: "note", label: "Note", value: (r) => r.note || "—" },
                  { key: "hours", label: "Hours", num: true, value: (r) => Number(r.hours) },
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
                                api(`/tenants/current/projects/${selId}/time/${r.id}`, {
                                  method: "DELETE",
                                }),
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

      {/* ---- Record expense ---- */}
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
                <input type="date" value={eDate} onChange={(e) => setEDate(e.target.value)} />
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
                    }).then(() => {
                      setEDesc("");
                      setEAmount("");
                    }),
                  "Expense recorded.",
                )
              }
            >
              Record expense
            </button>
            {!selId && <p className="muted">Pick a project to record expenses against.</p>}
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
                  { key: "expense_date", label: "Date", value: (r) => d10(r.expense_date) },
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
                                api(`/tenants/current/projects/${selId}/expenses/${r.id}`, {
                                  method: "DELETE",
                                }),
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
