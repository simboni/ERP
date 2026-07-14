"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, clearTokens, fmtKes, getTenantToken } from "@/lib/api";

interface TrialRow {
  code: string;
  name: string;
  type: string;
  balanceCents: number;
}
interface InvoiceRow {
  id: string;
  invoice_no: string | null;
  status: string;
  total_cents: string;
  customer_name: string;
  fiscal_status: string | null;
  control_number: string | null;
}
interface Tenant {
  name: string;
}

export default function Dashboard() {
  const router = useRouter();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [tb, setTb] = useState<TrialRow[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async (): Promise<void> => {
    try {
      const [t, balances, inv] = await Promise.all([
        api<Tenant>("/tenants/current"),
        api<TrialRow[]>("/tenants/current/accounts/trial-balance"),
        api<InvoiceRow[]>("/tenants/current/invoices"),
      ]);
      setTenant(t);
      setTb(balances);
      setInvoices(inv);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    if (!getTenantToken()) {
      router.replace("/");
      return;
    }
    void load();
  }, [load, router]);

  const bal = (code: string): number =>
    tb.find((a) => a.code === code)?.balanceCents ?? 0;
  const cash = bal("1000") + bal("1010") + bal("1020");
  const receivable = bal("1100");
  const vatDue = -bal("2200");

  return (
    <>
      <div className="row" style={{ alignItems: "baseline" }}>
        <h1>{tenant?.name ?? "…"}</h1>
        <span className="muted" style={{ textAlign: "right" }}>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              clearTokens();
              router.replace("/");
            }}
          >
            Sign out
          </a>
        </span>
      </div>
      {error && <div className="err">{error}</div>}

      <div className="row">
        <div className="card">
          <span className="muted">Cash &amp; M-Pesa</span>
          <div className="stat">{fmtKes(cash)}</div>
        </div>
        <div className="card">
          <span className="muted">Owed to you</span>
          <div className="stat">{fmtKes(receivable)}</div>
        </div>
        <div className="card">
          <span className="muted">VAT owed to KRA</span>
          <div className="stat">{fmtKes(vatDue)}</div>
        </div>
      </div>

      <h2>
        Invoices{" "}
        <Link href="/invoices/new" style={{ fontSize: "0.9rem" }}>
          + New invoice
        </Link>
      </h2>
      <div className="card">
        {invoices.length === 0 ? (
          <p className="muted">
            No invoices yet. Create your first eTIMS invoice — it takes a
            minute.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>No.</th>
                <th>Customer</th>
                <th>Total</th>
                <th>Status</th>
                <th>eTIMS</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id}>
                  <td>{i.invoice_no ?? "draft"}</td>
                  <td>{i.customer_name}</td>
                  <td>{fmtKes(i.total_cents)}</td>
                  <td>
                    <span className={`pill ${i.status}`}>{i.status}</span>
                  </td>
                  <td>
                    {i.fiscal_status ? (
                      <span className={`pill ${i.fiscal_status}`}>
                        {i.fiscal_status === "signed"
                          ? (i.control_number ?? "signed")
                          : i.fiscal_status}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
