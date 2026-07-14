"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, fmtKes, getTenantToken } from "@/lib/api";

interface Quote {
  id: string;
  quote_no: string;
  status: string;
  total_cents: string;
  valid_until: string | null;
  invoice_id: string | null;
  customer_name: string;
}
interface Branch { id: string }
interface Customer { id: string; name: string }

export default function QuotesPage() {
  const router = useRouter();
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [newCustomer, setNewCustomer] = useState("");
  const [desc, setDesc] = useState("");
  const [qty, setQty] = useState("1");
  const [priceKes, setPriceKes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (): Promise<void> => {
    const [q, c, b] = await Promise.all([
      api<Quote[]>("/tenants/current/quotes"),
      api<Customer[]>("/tenants/current/customers"),
      api<Branch[]>("/tenants/current/branches"),
    ]);
    setQuotes(q);
    setCustomers(c);
    setBranches(b);
    if (c[0] && !customerId) setCustomerId(c[0].id);
  }, [customerId]);

  useEffect(() => {
    if (!getTenantToken()) {
      router.replace("/");
      return;
    }
    load().catch((e) => setError(e instanceof Error ? e.message : "load failed"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = (fn: () => Promise<void>) => async (): Promise<void> => {
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

  const createQuote = act(async () => {
    let customer = customerId;
    if (!customer) {
      if (!newCustomer.trim()) throw new Error("Add a customer name");
      const c = await api<Customer>("/tenants/current/customers", {
        method: "POST",
        body: { name: newCustomer.trim() },
      });
      customer = c.id;
    }
    let branch = branches[0]?.id;
    if (!branch) {
      const b = await api<Branch>("/tenants/current/branches", {
        method: "POST",
        body: { code: "HQ", name: "Main" },
      });
      branch = b.id;
    }
    await api("/tenants/current/quotes", {
      method: "POST",
      body: {
        branchId: branch,
        customerId: customer,
        lines: [
          {
            description: desc,
            quantity: Number(qty),
            unitPriceCents: Math.round(Number(priceKes) * 100),
            vatRate: "0.16",
          },
        ],
      },
    });
    setDesc("");
    setPriceKes("");
  });

  const convert = (id: string) =>
    act(async () => {
      const r = await api<{ invoiceId: string }>(
        `/tenants/current/quotes/${id}/convert`,
        { method: "POST" },
      );
      router.push(`/invoices/${r.invoiceId}`);
    });

  return (
    <>
      <p><Link href="/dashboard">← Dashboard</Link></p>
      <h1>Quotations</h1>
      {error && <div className="err">{error}</div>}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>New quote</h2>
        <div className="row">
          <div>
            <label>Customer</label>
            {customers.length ? (
              <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            ) : (
              <input placeholder="Customer name" value={newCustomer} onChange={(e) => setNewCustomer(e.target.value)} />
            )}
          </div>
          <div style={{ flex: 2 }}>
            <label>Description</label>
            <input value={desc} onChange={(e) => setDesc(e.target.value)} />
          </div>
          <div>
            <label>Qty</label>
            <input type="number" min="0.001" step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
          </div>
          <div>
            <label>Unit price (KES)</label>
            <input type="number" min="0" step="0.01" value={priceKes} onChange={(e) => setPriceKes(e.target.value)} />
          </div>
        </div>
        <button disabled={busy || !desc || !priceKes} onClick={() => void createQuote()}>
          Create quote
        </button>
      </div>

      <div className="card">
        {quotes.length === 0 ? (
          <p className="muted">No quotes yet — most deals start here.</p>
        ) : (
          <table>
            <thead>
              <tr><th>No.</th><th>Customer</th><th>Total</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {quotes.map((q) => (
                <tr key={q.id}>
                  <td>Q-{q.quote_no}</td>
                  <td>{q.customer_name}</td>
                  <td>{fmtKes(q.total_cents)}</td>
                  <td><span className={`pill ${q.status === "converted" ? "paid" : ""}`}>{q.status}</span></td>
                  <td>
                    {["draft", "sent", "accepted"].includes(q.status) && (
                      <button disabled={busy} onClick={() => void convert(q.id)()}>
                        Convert to invoice
                      </button>
                    )}
                    {q.invoice_id && (
                      <Link href={`/invoices/${q.invoice_id}`}>invoice →</Link>
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
