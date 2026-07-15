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
  created_at?: string;
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
}

type Tab = "overview" | "leave" | "departments" | "announcements";
const d10 = (s: string): string => s?.slice(0, 10) ?? "";

export default function HrPage() {
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [requests, setRequests] = useState<LeaveRow[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  // forms
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

  const fail = (e: unknown): void =>
    setError(e instanceof Error ? e.message : "failed");

  const loadOverview = useCallback(() => {
    api<Overview>("/tenants/current/hr/overview")
      .then(setOverview)
      .catch(fail);
  }, []);
  const loadLeave = useCallback(() => {
    Promise.all([
      api<Policy[]>("/tenants/current/hr/leave/policies"),
      api<LeaveRow[]>("/tenants/current/hr/leave/requests"),
      api<Employee[]>("/tenants/current/employees"),
    ])
      .then(([p, r, e]) => {
        setPolicies(p);
        setRequests(r);
        setEmployees(e);
      })
      .catch(fail);
  }, []);
  const loadDepartments = useCallback(() => {
    api<Department[]>("/tenants/current/hr/departments")
      .then(setDepartments)
      .catch(fail);
  }, []);
  const loadAnnouncements = useCallback(() => {
    api<Announcement[]>("/tenants/current/hr/announcements")
      .then(setAnnouncements)
      .catch(fail);
  }, []);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  const switchTab = (next: Tab): void => {
    setTab(next);
    setError("");
    setMsg("");
    if (next === "overview") loadOverview();
    if (next === "leave") loadLeave();
    if (next === "departments") loadDepartments();
    if (next === "announcements") loadAnnouncements();
  };

  const decide = async (id: string, approve: boolean): Promise<void> => {
    setError("");
    try {
      await api(`/tenants/current/hr/leave/requests/${id}/decide`, {
        method: "POST",
        body: { approve },
      });
      setMsg(approve ? "Approved." : "Rejected.");
      loadLeave();
      loadOverview();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <>
      <h1>HR</h1>
      <div className="tabs">
        {(
          [
            ["overview", "Overview"],
            ["leave", "Leave"],
            ["departments", "Departments"],
            ["announcements", "Announcements"],
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
      {msg && <p className="muted">{msg}</p>}

      {tab === "overview" && overview && (
        <>
          <div className="row">
            <div className="card">
              <div className="card-head">
                <h3>Headcount by department</h3>
              </div>
              {overview.headcount.length === 0 ? (
                <div className="empty">
                  <span className="empty-icon">👥</span>
                  <p>No employees yet — add them under Payroll.</p>
                </div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Department</th>
                      <th className="num">Employees</th>
                      <th className="num">Monthly gross</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.headcount.map((h) => (
                      <tr key={h.department}>
                        <td>{h.department}</td>
                        <td className="num">{h.employees}</td>
                        <td className="num">{fmtKes0(h.gross_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="card">
              <div className="card-head">
                <h3>Who is out today</h3>
              </div>
              {overview.onLeaveToday.length === 0 ? (
                <div className="empty">
                  <span className="empty-icon">🌞</span>
                  <p>Everyone is in.</p>
                </div>
              ) : (
                overview.onLeaveToday.map((l) => (
                  <div key={l.id} className="bar-row">
                    <span style={{ flex: 1 }}>{l.full_name}</span>
                    <span className="pill sent">{l.policy}</span>
                    <span className="muted">
                      until {d10(l.end_date)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>Pending leave requests</h3>
            </div>
            {overview.pendingRequests.length === 0 ? (
              <p className="muted">No pending requests.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Policy</th>
                    <th>Dates</th>
                    <th className="num">Days</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {overview.pendingRequests.map((r) => (
                    <tr key={r.id}>
                      <td>{r.full_name}</td>
                      <td>{r.policy}</td>
                      <td className="muted">
                        {d10(r.start_date)} → {d10(r.end_date)}
                      </td>
                      <td className="num">{Number(r.days)}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <button
                          type="button"
                          style={{ marginTop: 0, padding: "4px 12px" }}
                          onClick={() => void decide(r.id, true)}
                        >
                          Approve
                        </button>{" "}
                        <button
                          type="button"
                          className="secondary"
                          style={{ marginTop: 0, padding: "4px 12px" }}
                          onClick={() => void decide(r.id, false)}
                        >
                          Reject
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {overview.announcements.length > 0 && (
            <div className="card">
              <div className="card-head">
                <h3>Latest announcements</h3>
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    switchTab("announcements");
                  }}
                >
                  All →
                </a>
              </div>
              {overview.announcements.map((a) => (
                <div key={a.id} style={{ padding: "6px 0" }}>
                  <strong>{a.title}</strong>{" "}
                  <span className="muted">· {d10(a.created_at)}</span>
                  {a.body && <p className="muted" style={{ margin: "2px 0 0" }}>{a.body}</p>}
                </div>
              ))}
            </div>
          )}
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
                {employees.map((e) => (
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
                onClick={() => {
                  setError("");
                  api("/tenants/current/hr/leave/requests", {
                    method: "POST",
                    body: {
                      employeeId: reqEmp,
                      policyId: reqPol,
                      startDate: reqStart,
                      endDate: reqEnd,
                      reason: reqReason,
                    },
                  })
                    .then(() => {
                      setMsg("Leave request submitted.");
                      loadLeave();
                    })
                    .catch(fail);
                }}
              >
                Submit request
              </button>
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
                onClick={() => {
                  setError("");
                  api("/tenants/current/hr/leave/policies", {
                    method: "POST",
                    body: { name: polName, daysPerYear: Number(polDays) },
                  })
                    .then(() => {
                      setPolName("");
                      loadLeave();
                    })
                    .catch(fail);
                }}
              >
                Add policy
              </button>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>All requests</h3>
            </div>
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
                      <td className="muted">
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
        </>
      )}

      {tab === "departments" && (
        <div className="card">
          <div className="card-head">
            <h3>Departments</h3>
          </div>
          {departments.length === 0 ? (
            <p className="muted">No departments yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="num">Employees</th>
                </tr>
              </thead>
              <tbody>
                {departments.map((dpt) => (
                  <tr key={dpt.id}>
                    <td>{dpt.name}</td>
                    <td className="num">{dpt.employees}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <label>New department</label>
          <input
            value={deptName}
            onChange={(e) => setDeptName(e.target.value)}
            placeholder="e.g. Sales"
          />
          <button
            onClick={() => {
              setError("");
              api("/tenants/current/hr/departments", {
                method: "POST",
                body: { name: deptName },
              })
                .then(() => {
                  setDeptName("");
                  loadDepartments();
                })
                .catch(fail);
            }}
          >
            Add department
          </button>
          <p className="muted">
            Assign employees to departments from the Payroll page (each
            employee row) — headcount updates here.
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
              onClick={() => {
                setError("");
                api("/tenants/current/hr/announcements", {
                  method: "POST",
                  body: { title: annTitle, body: annBody },
                })
                  .then(() => {
                    setAnnTitle("");
                    setAnnBody("");
                    loadAnnouncements();
                  })
                  .catch(fail);
              }}
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
