"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, fmtKes, getTenantToken } from "@/lib/api";
import { DataTable } from "@/components/DataTable";

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
            <DataTable
              rows={unmatched}
              csvName="unmatched-payments"
              searchKeys={["receipt_number", "msisdn", "account_ref"]}
              pageSizeDefault={10}
              columns={[
                { key: "receipt_number", label: "Receipt" },
                { key: "msisdn", label: "From" },
                {
                  key: "account_ref",
                  label: "Ref",
                  render: (u) =>
                    u.account_ref || <span className="muted">none</span>,
                },
                {
                  key: "amount_cents",
                  label: "Amount",
                  num: true,
                  value: (u) => Number(u.amount_cents),
                  render: (u) => fmtKes(u.amount_cents),
                },
                {
                  key: "actions",
                  label: "Match to",
                  value: () => "",
                  render: (u) => (
                    <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                      <select
                        value={pick[u.id] ?? ""}
                        onChange={(e) =>
                          setPick((s) => ({ ...s, [u.id]: e.target.value }))
                        }
                      >
                        <option value="">Choose invoice…</option>
                        {openInvoices.map((i) => (
                          <option key={i.id} value={i.id}>
                            #{i.invoice_no} {i.customer_name} —{" "}
                            {fmtKes(i.total_cents)}
                          </option>
                        ))}
                      </select>
                      <button
                        disabled={busy || !pick[u.id]}
                        onClick={() => void match(u.id)}
                      >
                        Match
                      </button>
                    </span>
                  ),
                },
              ]}
            />
          </div>
        </>
      )}

      <h2>All payments</h2>
      <div className="card">
        <DataTable
          rows={payments}
          csvName="payments"
          searchKeys={["receipt_number", "rail", "account_ref"]}
          pageSizeDefault={25}
          empty={
            <p className="muted">
              No payments yet. Register your paybill shortcode and M-Pesa
              payments will reconcile themselves to open invoices.
            </p>
          }
          columns={[
            {
              key: "receipt_number",
              label: "Receipt",
              value: (p) => p.receipt_number ?? "",
              render: (p) =>
                p.receipt_number ?? <span className="muted">—</span>,
            },
            {
              key: "rail",
              label: "Rail",
              value: (p) => p.rail.replace("mpesa_", "M-Pesa "),
            },
            {
              key: "amount_cents",
              label: "Amount",
              num: true,
              value: (p) => Number(p.amount_cents),
              render: (p) => fmtKes(p.amount_cents),
            },
            { key: "account_ref", label: "Ref" },
            {
              key: "state",
              label: "State",
              render: (p) => (
                <span
                  className={`pill ${p.state === "confirmed" ? "paid" : ""}`}
                >
                  {p.state}
                </span>
              ),
            },
            {
              key: "invoice_id",
              label: "Matched",
              value: (p) => (p.invoice_id ? "✓" : ""),
            },
          ]}
        />
      </div>
    </>
  );
}
