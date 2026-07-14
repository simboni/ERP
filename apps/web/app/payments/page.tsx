"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, fmtKes, getTenantToken } from "@/lib/api";

interface Payment {
  id: string;
  rail: string;
  state: string;
  amount_cents: string;
  msisdn: string | null;
  account_ref: string | null;
  receipt_number: string | null;
  invoice_id: string | null;
  confirmed_at: string | null;
}
interface Unmatched {
  id: string;
  amount_cents: string;
  msisdn: string | null;
  account_ref: string | null;
  receipt_number: string | null;
}
interface Invoice {
  id: string;
  invoice_no: string | null;
  status: string;
  total_cents: string;
  customer_name: string;
}

export default function PaymentsPage() {
  const router = useRouter();
  const [payments, setPayments] = useState<Payment[]>([]);
  const [unmatched, setUnmatched] = useState<Unmatched[]>([]);
  const [openInvoices, setOpenInvoices] = useState<Invoice[]>([]);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const [p, u, inv] = await Promise.all([
      api<Payment[]>("/tenants/current/payments"),
      api<Unmatched[]>("/tenants/current/payments/unmatched"),
      api<Invoice[]>("/tenants/current/invoices"),
    ]);
    setPayments(p);
    setUnmatched(u);
    setOpenInvoices(inv.filter((i) => i.status === "issued"));
  }, []);

  useEffect(() => {
    if (!getTenantToken()) {
      router.replace("/");
      return;
    }
    load().catch((e) => setError(e instanceof Error ? e.message : "load failed"));
  }, [load, router]);

  const match = async (paymentId: string): Promise<void> => {
    const invoiceId = pick[paymentId];
    if (!invoiceId) return;
    setBusy(true);
    setError("");
    try {
      await api(`/tenants/current/payments/${paymentId}/match`, {
        method: "POST",
        body: { invoiceId },
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "match failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p>
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1>Payments</h1>
      {error && <div className="err">{error}</div>}

      {unmatched.length > 0 && (
        <>
          <h2>Needs matching ({unmatched.length})</h2>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Receipt</th><th>From</th><th>Ref</th><th>Amount</th><th>Match to</th><th></th>
                </tr>
              </thead>
              <tbody>
                {unmatched.map((u) => (
                  <tr key={u.id}>
                    <td>{u.receipt_number}</td>
                    <td>{u.msisdn}</td>
                    <td>{u.account_ref || <span className="muted">none</span>}</td>
                    <td>{fmtKes(u.amount_cents)}</td>
                    <td>
                      <select
                        value={pick[u.id] ?? ""}
                        onChange={(e) => setPick((s) => ({ ...s, [u.id]: e.target.value }))}
                      >
                        <option value="">Choose invoice…</option>
                        {openInvoices.map((i) => (
                          <option key={i.id} value={i.id}>
                            #{i.invoice_no} {i.customer_name} — {fmtKes(i.total_cents)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <button disabled={busy || !pick[u.id]} onClick={() => void match(u.id)}>
                        Match
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2>All payments</h2>
      <div className="card">
        {payments.length === 0 ? (
          <p className="muted">
            No payments yet. Register your paybill shortcode and M-Pesa
            payments will reconcile themselves to open invoices.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Receipt</th><th>Rail</th><th>Amount</th><th>Ref</th>
                <th>State</th><th>Matched</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td>{p.receipt_number ?? <span className="muted">—</span>}</td>
                  <td>{p.rail.replace("mpesa_", "M-Pesa ")}</td>
                  <td>{fmtKes(p.amount_cents)}</td>
                  <td>{p.account_ref}</td>
                  <td><span className={`pill ${p.state === "confirmed" ? "paid" : ""}`}>{p.state}</span></td>
                  <td>{p.invoice_id ? "✓" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
