"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, fmtKes, getTenantToken } from "@/lib/api";

interface Report {
  period: string;
  groupBy: string;
  rows: Record<string, string | number>[];
  totals: { net: string; vat: string; gross: string; invoices: number };
}

export default function ReportsPage() {
  const router = useRouter();
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [groupBy, setGroupBy] = useState<"day" | "customer" | "item">("day");
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async (p: string, g: string): Promise<void> => {
    setError("");
    try {
      setReport(
        await api<Report>(`/tenants/current/reports/sales?period=${p}&groupBy=${g}`),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }, []);

  useEffect(() => {
    if (!getTenantToken()) {
      router.replace("/");
      return;
    }
    void load(period, groupBy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <p><Link href="/dashboard">← Dashboard</Link></p>
      <h1>Sales report</h1>
      <div className="card">
        <div className="row">
          <div>
            <label>Period</label>
            <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
          </div>
          <div>
            <label>Group by</label>
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as typeof groupBy)}>
              <option value="day">Day</option>
              <option value="customer">Customer</option>
              <option value="item">Item</option>
            </select>
          </div>
        </div>
        <button onClick={() => void load(period, groupBy)}>Run report</button>
        {error && <div className="err">{error}</div>}
      </div>

      {report && (
        <>
          <div className="row">
            <div className="card"><span className="muted">Net sales</span><div className="stat">{fmtKes(report.totals.net)}</div></div>
            <div className="card"><span className="muted">VAT</span><div className="stat">{fmtKes(report.totals.vat)}</div></div>
            <div className="card"><span className="muted">Invoices</span><div className="stat">{report.totals.invoices}</div></div>
          </div>
          <div className="card">
            {report.rows.length === 0 ? (
              <p className="muted">No sales in this period.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>{groupBy === "day" ? "Date" : groupBy === "customer" ? "Customer" : "Item"}</th>
                    {groupBy === "item" ? <th>Qty</th> : <th>Invoices</th>}
                    <th>Net</th>
                    <th>VAT</th>
                    {groupBy === "customer" && <th>Outstanding</th>}
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((r, i) => (
                    <tr key={i}>
                      <td>{String(r.label)}</td>
                      <td>{groupBy === "item" ? Number(r.quantity) : Number(r.invoices)}</td>
                      <td>{fmtKes(r.net_cents as string)}</td>
                      <td>{fmtKes(r.vat_cents as string)}</td>
                      {groupBy === "customer" && <td>{fmtKes(r.outstanding_cents as string)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </>
  );
}
