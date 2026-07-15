"use client";

import { useCallback, useEffect, useState } from "react";
import { api, fmtKes0 } from "@/lib/api";

interface HeadcountRow {
  department: string;
  employees: number;
  gross_cents: string;
}
interface LeaveRow {
  id: string;
  full_name: string;
  policy: string;
  start_date: string;
  end_date: string;
  days?: string;
  reason?: string;
  status?: string;
}
interface Announcement {
  id: string;
  title: string;
  body: string;
  created_at: string;
}
interface Overview {
  headcount: HeadcountRow[];
  onLeaveToday: LeaveRow[];
  pendingRequests: LeaveRow[];
  announcements: Announcement[];
}
interface Department {
  id: string;
  name: string;
  employees: number;
}
interface Policy {
  id: string;
  name: string;
  days_per_year: string;
}
interface Employee {
  id: string;
  full_name: string;
  gross_cents: string;
  status: string;
  designation: string | null;
  hired_on: string | null;
  msisdn: string | null;
  department_id: string | null;
  department: string | null;
}

type Tab = "overview" | "employees" | "leave" | "departments" | "announcements";
const d10 = (s: string | null | undefined): string => s?.slice(0, 10) ?? "";
const AVATAR_COLORS = ["#2b62c4", "#6d3fc0", "#0b6b38", "#c2334d", "#8a5a00"];
const initials = (name: string): string =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase();

export default function HrPage() {
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [requests, setRequests] = useState<LeaveRow[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  // forms
  const [empName, setEmpName] = useState("");
  const [empGross, setEmpGross] = useState("");
  const [empPhone, setEmpPhone] = useState("");
  const [empDept, setEmpDept] = useState("");
  const [empTitle, setEmpTitle] = useState("");
  const [deptName, setDeptName] = useState("");
  const [polName, setPolName] = useState("");
  const [polDays, setPolDays] = useState("21");
  const [reqEmp, setReqEmp] = useState("");
  const [reqPol, setReqPol] = useState("");
  const [reqStart, setReqStart] = useState("");
  const [reqEnd, setReqEnd] = useState("");
  const [reqReason, setReqReason] = useState("");
  const [annTitle, setAnnTitle] = useState("");
  const [annBody, setAnnBody] = useState("");
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);

  const fail = (e: unknown): void =>
    setError(e instanceof Error ? e.message : "failed");

  const loadAll = useCallback(() => {
    Promise.all([
      api<Overview>("/tenants/current/hr/overview"),
      api<Employee[]>("/tenants/current/hr/employees"),
      api<Department[]>("/tenants/current/hr/departments"),
      api<Policy[]>("/tenants/current/hr/leave/policies"),
      api<LeaveRow[]>("/tenants/current/hr/leave/requests"),
      api<Announcement[]>("/tenants/current/hr/announcements"),
    ])
      .then(([o, e, d, p, r, a]) => {
        setOverview(o);
        setEmployees(e);
        setDepartments(d);
        setPolicies(p);
        setRequests(r);
        setAnnouncements(a);
      })
      .catch(fail);
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const act = async (fn: () => Promise<unknown>, note?: string) => {
    setError("");
    setMsg("");
    try {
      await fn();
      if (note) setMsg(note);
      loadAll();
    } catch (e) {
      fail(e);
    }
  };

  const activeEmployees = employees.filter((e) => e.status === "active");
  const tiles = [
    {
      cls: "tile-3",
      value: String(activeEmployees.length),
      label: "People",
    },
    {
      cls: "tile-2",
      value: String(departments.length),
      label: "Departments",
    },
    {
      cls: "tile-4",
      value: String(overview?.onLeaveToday.length ?? 0),
      label: "On leave today",
    },
    {
      cls: "tile-1",
      value: String(overview?.pendingRequests.length ?? 0),
      label: "Pending requests",
    },
  ];

  return (
    <>
      <h1>HR</h1>
      <div className="tabs">
        {(
          [
            ["overview", "Overview"],
            ["employees", "Employees"],
            ["leave", "Leave"],
            ["departments", "Departments"],
            ["announcements", "Announcements"],
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
      {msg && <p className="muted">{msg}</p>}

      {tab === "overview" && (
        <>
          <div className="tiles">
            {tiles.map((t) => (
              <div key={t.label} className={`tile ${t.cls}`}>
                <div className="tile-value">{t.value}</div>
                <div className="tile-label">{t.label}</div>
              </div>
            ))}
          </div>

          <div className="row">
            <div className="card">
              <div className="card-head">
                <h3>Headcount by department</h3>
              </div>
              {(overview?.headcount ?? []).length === 0 ? (
                <div className="empty">
                  <span className="empty-icon">👥</span>
                  <p>No employees yet.</p>
                </div>
              ) : (
                overview!.headcount.map((h, i) => {
                  const max = Math.max(
                    ...overview!.headcount.map((x) => x.employees),
                  );
                  return (
                    <div key={h.department} className="bar-row">
                      <span className="bar-label" style={{ width: 110 }}>
                        {h.department}
                      </span>
                      <span className="bar-track">
                        <span
                          className="bar-fill"
                          style={{
                            width: `${(h.employees / max) * 100}%`,
                            background:
                              AVATAR_COLORS[i % AVATAR_COLORS.length],
                          }}
                        />
                      </span>
                      <span className="bar-amt" style={{ minWidth: 30 }}>
                        {h.employees}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
            <div className="card">
              <div className="card-head">
                <h3>Who is out today</h3>
              </div>
              {(overview?.onLeaveToday ?? []).length === 0 ? (
                <div className="empty">
                  <span className="empty-icon">🌞</span>
                  <p>Everyone is in.</p>
                </div>
              ) : (
                overview!.onLeaveToday.map((l, i) => (
                  <div
                    key={l.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "8px 0",
                    }}
                  >
                    <span
                      className="dot-avatar"
                      style={{
                        background: AVATAR_COLORS[i % AVATAR_COLORS.length],
                      }}
                    >
                      {initials(l.full_name)}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      {l.full_name}
                      <br />
                      <span className="muted">until {d10(l.end_date)}</span>
                    </span>
                    <span className="pill sent">{l.policy}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>Pending leave requests</h3>
            </div>
            {(overview?.pendingRequests ?? []).length === 0 ? (
              <p className="muted">No pending requests.</p>
            ) : (
              overview!.pendingRequests.map((r, i) => (
                <div
                  key={r.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "9px 0",
                    borderBottom: "1px solid var(--line-soft)",
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    className="dot-avatar"
                    style={{
                      background: AVATAR_COLORS[i % AVATAR_COLORS.length],
                    }}
                  >
                    {initials(r.full_name)}
                  </span>
                  <span style={{ flex: 1, minWidth: 140 }}>
                    {r.full_name}
                    <br />
                    <span className="muted">
                      {r.policy} · {d10(r.start_date)} → {d10(r.end_date)} (
                      {Number(r.days)}d)
                    </span>
                  </span>
                  <span style={{ whiteSpace: "nowrap" }}>
                    <button
                      type="button"
                      style={{ marginTop: 0, padding: "5px 14px" }}
                      onClick={() =>
                        void act(
                          () =>
                            api(
                              `/tenants/current/hr/leave/requests/${r.id}/decide`,
                              { method: "POST", body: { approve: true } },
                            ),
                          "Approved.",
                        )
                      }
                    >
                      Approve
                    </button>{" "}
                    <button
                      type="button"
                      className="secondary"
                      style={{ marginTop: 0, padding: "5px 14px" }}
                      onClick={() =>
                        void act(
                          () =>
                            api(
                              `/tenants/current/hr/leave/requests/${r.id}/decide`,
                              { method: "POST", body: { approve: false } },
                            ),
                          "Rejected.",
                        )
                      }
                    >
                      Reject
                    </button>
                  </span>
                </div>
              ))
            )}
          </div>

          {(overview?.announcements ?? []).length > 0 && (
            <div className="card">
              <div className="card-head">
                <h3>Latest announcements</h3>
              </div>
              {overview!.announcements.map((a) => (
                <div key={a.id} style={{ padding: "6px 0" }}>
                  <strong>{a.title}</strong>{" "}
                  <span className="muted">· {d10(a.created_at)}</span>
                  {a.body && (
                    <p className="muted" style={{ margin: "2px 0 0" }}>
                      {a.body}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === "employees" && (
        <>
          <div className="card">
            <div className="card-head">
              <h3>Onboard an employee</h3>
            </div>
            <div className="row">
              <div>
                <label>Full name</label>
                <input
                  value={empName}
                  onChange={(e) => setEmpName(e.target.value)}
                />
              </div>
              <div>
                <label>Gross salary (KES/month)</label>
                <input
                  type="number"
                  value={empGross}
                  onChange={(e) => setEmpGross(e.target.value)}
                />
              </div>
              <div>
                <label>Phone (M-Pesa)</label>
                <input
                  value={empPhone}
                  onChange={(e) => setEmpPhone(e.target.value)}
                  placeholder="+2547…"
                />
              </div>
            </div>
            <div className="row">
              <div>
                <label>Department</label>
                <select
                  value={empDept}
                  onChange={(e) => setEmpDept(e.target.value)}
                >
                  <option value="">— none yet —</option>
                  {departments.map((dpt) => (
                    <option key={dpt.id} value={dpt.id}>
                      {dpt.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Designation</label>
                <input
                  value={empTitle}
                  onChange={(e) => setEmpTitle(e.target.value)}
                  placeholder="e.g. Sales Officer"
                />
              </div>
            </div>
            <button
              onClick={() =>
                void act(async () => {
                  const created = await api<{ id: string }>(
                    "/tenants/current/employees",
                    {
                      method: "POST",
                      body: {
                        fullName: empName,
                        grossCents: Math.round(Number(empGross || 0) * 100),
                        msisdn: empPhone || undefined,
                      },
                    },
                  );
                  if (empDept || empTitle) {
                    await api(`/tenants/current/hr/employees/${created.id}`, {
                      method: "PATCH",
                      body: {
                        departmentId: empDept || undefined,
                        designation: empTitle || undefined,
                      },
                    });
                  }
                  setEmpName("");
                  setEmpGross("");
                  setEmpPhone("");
                  setEmpTitle("");
                }, "Employee onboarded — they appear in payroll runs automatically.")
              }
            >
              Onboard
            </button>
            <p className="muted">
              Statutory deductions (PAYE, NSSF, SHIF, Housing Levy) are
              computed automatically from the gross salary on every payroll
              run.
            </p>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>Team ({activeEmployees.length})</h3>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Department</th>
                    <th>Designation</th>
                    <th className="num">Gross</th>
                    <th>Hired</th>
                  </tr>
                </thead>
                <tbody>
                  {activeEmployees.map((e, i) => (
                    <tr key={e.id}>
                      <td>
                        <span
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                          }}
                        >
                          <span
                            className="dot-avatar"
                            style={{
                              width: 30,
                              height: 30,
                              fontSize: "0.72rem",
                              background:
                                AVATAR_COLORS[i % AVATAR_COLORS.length],
                            }}
                          >
                            {initials(e.full_name)}
                          </span>
                          {e.full_name}
                        </span>
                      </td>
                      <td>
                        <select
                          value={e.department_id ?? ""}
                          style={{ maxWidth: 160, padding: "5px 8px" }}
                          onChange={(ev) =>
                            void act(() =>
                              api(`/tenants/current/hr/employees/${e.id}`, {
                                method: "PATCH",
                                body: { departmentId: ev.target.value || null },
                              }),
                            )
                          }
                        >
                          <option value="">Unassigned</option>
                          {departments.map((dpt) => (
                            <option key={dpt.id} value={dpt.id}>
                              {dpt.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="muted">{e.designation ?? "—"}</td>
                      <td className="num">{fmtKes0(e.gross_cents)}</td>
                      <td className="muted">{d10(e.hired_on) || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {tab === "leave" && (
        <>
          <div className="row">
            <div className="card">
              <div className="card-head">
                <h3>Request leave</h3>
              </div>
              <label>Employee</label>
              <select value={reqEmp} onChange={(e) => setReqEmp(e.target.value)}>
                <option value="">Select…</option>
                {activeEmployees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.full_name}
                  </option>
                ))}
              </select>
              <label>Policy</label>
              <select value={reqPol} onChange={(e) => setReqPol(e.target.value)}>
                <option value="">Select…</option>
                {policies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({Number(p.days_per_year)} days/yr)
                  </option>
                ))}
              </select>
              <div className="row">
                <div>
                  <label>From</label>
                  <input
                    type="date"
                    value={reqStart}
                    onChange={(e) => setReqStart(e.target.value)}
                  />
                </div>
                <div>
                  <label>To</label>
                  <input
                    type="date"
                    value={reqEnd}
                    onChange={(e) => setReqEnd(e.target.value)}
                  />
                </div>
              </div>
              <label>Reason</label>
              <input
                value={reqReason}
                onChange={(e) => setReqReason(e.target.value)}
                placeholder="Optional"
              />
              <button
                onClick={() =>
                  void act(
                    () =>
                      api("/tenants/current/hr/leave/requests", {
                        method: "POST",
                        body: {
                          employeeId: reqEmp,
                          policyId: reqPol,
                          startDate: reqStart,
                          endDate: reqEnd,
                          reason: reqReason,
                        },
                      }),
                    "Request submitted — approve it on the Overview tab.",
                  )
                }
              >
                Submit request
              </button>
              <p className="muted">
                Only working days (Mon–Fri) count against the balance;
                weekends in the range are free.
              </p>
            </div>
            <div className="card">
              <div className="card-head">
                <h3>Leave policies</h3>
              </div>
              {policies.map((p) => (
                <div key={p.id} className="bar-row">
                  <span style={{ flex: 1 }}>{p.name}</span>
                  <span className="pill sent">
                    {Number(p.days_per_year)} days/yr
                  </span>
                </div>
              ))}
              <label>New policy</label>
              <input
                value={polName}
                onChange={(e) => setPolName(e.target.value)}
                placeholder="e.g. Annual leave"
              />
              <label>Days per year</label>
              <input
                type="number"
                value={polDays}
                onChange={(e) => setPolDays(e.target.value)}
              />
              <button
                className="secondary"
                onClick={() =>
                  void act(() =>
                    api("/tenants/current/hr/leave/policies", {
                      method: "POST",
                      body: { name: polName, daysPerYear: Number(polDays) },
                    }).then(() => setPolName("")),
                  )
                }
              >
                Add policy
              </button>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>All requests</h3>
            </div>
            <div className="table-wrap">
              {requests.length === 0 ? (
                <p className="muted">No leave requests yet.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th>Policy</th>
                      <th>Dates</th>
                      <th className="num">Days</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {requests.map((r) => (
                      <tr key={r.id}>
                        <td>{r.full_name}</td>
                        <td>{r.policy}</td>
                        <td className="muted" style={{ whiteSpace: "nowrap" }}>
                          {d10(r.start_date)} → {d10(r.end_date)}
                        </td>
                        <td className="num">{Number(r.days)}</td>
                        <td>
                          <span className={`pill ${r.status}`}>{r.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}

      {tab === "departments" && (
        <div className="card">
          <div className="card-head">
            <h3>Departments</h3>
          </div>
          {departments.length === 0 ? (
            <div className="empty">
              <span className="empty-icon">🏢</span>
              <p>No departments yet — create the first one below.</p>
            </div>
          ) : (
            departments.map((dpt, i) => (
              <div key={dpt.id} className="bar-row">
                <span
                  className="dot-avatar"
                  style={{
                    width: 30,
                    height: 30,
                    fontSize: "0.72rem",
                    background: AVATAR_COLORS[i % AVATAR_COLORS.length],
                  }}
                >
                  {initials(dpt.name)}
                </span>
                <span style={{ flex: 1 }}>{dpt.name}</span>
                <span className="pill sent">{dpt.employees} people</span>
              </div>
            ))
          )}
          <label>New department</label>
          <input
            value={deptName}
            onChange={(e) => setDeptName(e.target.value)}
            placeholder="e.g. Sales"
          />
          <button
            onClick={() =>
              void act(() =>
                api("/tenants/current/hr/departments", {
                  method: "POST",
                  body: { name: deptName },
                }).then(() => setDeptName("")),
              )
            }
          >
            Add department
          </button>
          <p className="muted">
            Assign people on the Employees tab — each row has a department
            selector.
          </p>
        </div>
      )}

      {tab === "announcements" && (
        <>
          <div className="card">
            <div className="card-head">
              <h3>New announcement</h3>
            </div>
            <label>Title</label>
            <input
              value={annTitle}
              onChange={(e) => setAnnTitle(e.target.value)}
            />
            <label>Message</label>
            <textarea
              rows={3}
              value={annBody}
              onChange={(e) => setAnnBody(e.target.value)}
            />
            <button
              onClick={() =>
                void act(() =>
                  api("/tenants/current/hr/announcements", {
                    method: "POST",
                    body: { title: annTitle, body: annBody },
                  }).then(() => {
                    setAnnTitle("");
                    setAnnBody("");
                  }),
                )
              }
            >
              Publish
            </button>
          </div>
          <div className="card">
            {announcements.length === 0 ? (
              <p className="muted">No announcements yet.</p>
            ) : (
              announcements.map((a) => (
                <div
                  key={a.id}
                  style={{
                    padding: "10px 0",
                    borderBottom: "1px solid var(--line-soft)",
                  }}
                >
                  <strong>{a.title}</strong>{" "}
                  <span className="muted">· {d10(a.created_at)}</span>
                  {a.body && (
                    <p className="muted" style={{ margin: "4px 0 0" }}>
                      {a.body}
                    </p>
                  )}
                </div>
              ))
            )}
          </div>
        </>
      )}
    </>
  );
}
