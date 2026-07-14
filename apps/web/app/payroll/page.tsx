"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, API_BASE, fmtKes, getTenantToken } from "@/lib/api";

interface Employee {
  id: string;
  full_name: string;
  gross_cents: string;
  status: string;
}
interface Run {
  id: string;
  period: string;
  status: string;
  employee_count: number;
  gross_cents: string;
  paye_cents: string;
  net_cents: string;
}
interface RunDetail extends Run {
  nssf_emp_cents: string;
  nssf_er_cents: string;
  shif_cents: string;
  ahl_emp_cents: string;
  ahl_er_cents: string;
  nita_cents: string;
  items: {
    id: string;
    full_name: string;
    gross_cents: string;
    paye_cents: string;
    nssf_emp_cents: string;
    shif_cents: string;
    ahl_emp_cents: string;
    net_cents: string;
  }[];
}

export default function PayrollPage() {
  const router = useRouter();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [name, setName] = useState("");
  const [grossKes, setGrossKes] = useState("");
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (): Promise<void> => {
    const [emps, rns] = await Promise.all([
      api<Employee[]>("/tenants/current/employees"),
      api<Run[]>("/tenants/current/payroll/runs"),
    ]);
    setEmployees(emps);
    setRuns(rns);
  }, []);

  useEffect(() => {
    if (!getTenantToken()) {
      router.replace("/");
      return;
    }
    load().catch((e) => setError(e instanceof Error ? e.message : "load failed"));
  }, [load, router]);

  const wrap =
    (fn: () => Promise<void>) => async (): Promise<void> => {
      setBusy(true);
      setError("");
      try {
        await fn();
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "failed");
      } finally {
        setBusy(false);
      }
    };

  const addEmployee = wrap(async () => {
    await api("/tenants/current/employees", {
      method: "POST",
      body: {
        fullName: name,
        grossCents: Math.round(Number(grossKes) * 100),
      },
    });
    setName("");
    setGrossKes("");
  });

  const openRun = async (id: string): Promise<void> => {
    const d = await api<RunDetail>(`/tenants/current/payroll/runs/${id}`);
    setDetail(d);
  };

  const draftRun = wrap(async () => {
    const r = await api<{ runId: string }>("/tenants/current/payroll/runs", {
      method: "POST",
      body: { period },
    });
    await openRun(r.runId);
  });

  const commitRun = (id: string) =>
    wrap(async () => {
      await api(`/tenants/current/payroll/runs/${id}/commit`, { method: "POST" });
      await openRun(id);
    });

  return (
    <>
      <p>
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1>Payroll</h1>
      {error && <div className="err">{error}</div>}

      <h2>Employees</h2>
      <div className="card">
        {employees.length > 0 && (
          <table>
            <thead>
              <tr><th>Name</th><th>Gross salary</th><th>Status</th></tr>
            </thead>
            <tbody>
              {employees.map((e) => (
                <tr key={e.id}>
                  <td>{e.full_name}</td>
                  <td>{fmtKes(e.gross_cents)}</td>
                  <td><span className="pill">{e.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="row">
          <div>
            <label>Full name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label>Gross salary (KES/month)</label>
            <input
              type="number"
              min="1"
              value={grossKes}
              onChange={(e) => setGrossKes(e.target.value)}
            />
          </div>
        </div>
        <button disabled={busy || !name || !grossKes} onClick={() => void addEmployee()}>
          Add employee
        </button>
      </div>

      <h2>Runs</h2>
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
        </div>
        <button disabled={busy || employees.length === 0} onClick={() => void draftRun()}>
          Compute payroll (draft)
        </button>
        {runs.length > 0 && (
          <table style={{ marginTop: 16 }}>
            <thead>
              <tr>
                <th>Period</th><th>Status</th><th>Staff</th><th>Gross</th>
                <th>PAYE</th><th>Net pay</th><th></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{r.period}</td>
                  <td><span className={`pill ${r.status === "committed" ? "paid" : ""}`}>{r.status}</span></td>
                  <td>{r.employee_count}</td>
                  <td>{fmtKes(r.gross_cents)}</td>
                  <td>{fmtKes(r.paye_cents)}</td>
                  <td>{fmtKes(r.net_cents)}</td>
                  <td><a href="#" onClick={(e) => { e.preventDefault(); void openRun(r.id); }}>view</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {detail && (
        <>
          <h2>Run {detail.period} — {detail.status}</h2>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Employee</th><th>Gross</th><th>PAYE</th><th>NSSF</th>
                  <th>SHIF</th><th>Housing</th><th>Net</th><th></th>
                </tr>
              </thead>
              <tbody>
                {detail.items.map((i) => (
                  <tr key={i.id}>
                    <td>{i.full_name}</td>
                    <td>{fmtKes(i.gross_cents)}</td>
                    <td>{fmtKes(i.paye_cents)}</td>
                    <td>{fmtKes(i.nssf_emp_cents)}</td>
                    <td>{fmtKes(i.shif_cents)}</td>
                    <td>{fmtKes(i.ahl_emp_cents)}</td>
                    <td><strong>{fmtKes(i.net_cents)}</strong></td>
                    <td>
                      {detail.status === "committed" && (
                        <a href="#" onClick={(e) => { e.preventDefault();
                          void fetch(`${API_BASE}/tenants/current/payroll/runs/${detail.id}/items/${i.id}/payslip.pdf`,
                            { headers: { Authorization: `Bearer ${getTenantToken()}` } })
                            .then((r) => r.blob())
                            .then((b) => window.open(URL.createObjectURL(b), "_blank"));
                        }}>payslip</a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted">
              Employer additionally pays: NSSF {fmtKes(detail.nssf_er_cents)} ·
              Housing {fmtKes(detail.ahl_er_cents)} · NITA {fmtKes(detail.nita_cents)}
            </p>
            {detail.status === "committed" && (
              <button className="secondary" onClick={() => {
                void fetch(`${API_BASE}/tenants/current/payroll/runs/${detail.id}/p10.csv`,
                  { headers: { Authorization: `Bearer ${getTenantToken()}` } })
                  .then((r) => r.blob())
                  .then((b) => {
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(b);
                    a.download = `p10-${detail.period}.csv`;
                    a.click();
                  });
              }}>
                Download P10 (iTax CSV)
              </button>
            )}
            {detail.status === "draft" && (
              <button disabled={busy} onClick={() => void commitRun(detail.id)()}>
                Commit run (posts to ledger)
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}
