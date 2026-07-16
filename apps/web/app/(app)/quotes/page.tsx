"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  api,
  fmtKes,
  getApiBaseSync,
  getTenantToken,
} from "@/lib/api";
import { DataTable } from "@/components/DataTable";
import { SearchSelect } from "@/components/SearchSelect";

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
interface EditLine {
  description: string;
  quantity: string;
  priceKes: string;
  vatRate: string;
}
interface QuoteDetail {
  id: string;
  quote_no: string;
  status: string;
  customer_id: string;
  valid_until: string | null;
  lines: Array<{
    description: string;
    quantity: string;
    unit_price_cents: string;
    vat_rate: string;
  }>;
}

const EDITABLE = ["draft", "sent", "accepted", "expired"];

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

  // Edit modal state
  const [editing, setEditing] = useState<QuoteDetail | null>(null);
  const [editCustomer, setEditCustomer] = useState("");
  const [editValidUntil, setEditValidUntil] = useState("");
  const [editLines, setEditLines] = useState<EditLine[]>([]);

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
      router.replace("/login");
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
      router.push(`/invoices/view?id=${r.invoiceId}`);
    });

  const download = (q: Quote): void => {
    void fetch(`${getApiBaseSync()}/tenants/current/quotes/${q.id}/pdf`, {
      headers: { Authorization: `Bearer ${getTenantToken()}` },
    })
      .then((r) => {
        if (!r.ok) throw new Error("Could not generate PDF");
        return r.blob();
      })
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `quote-Q-${q.quote_no}.pdf`;
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "download failed"));
  };

  const del = (q: Quote) =>
    act(async () => {
      if (
        typeof window !== "undefined" &&
        !window.confirm(`Delete quote Q-${q.quote_no}? This cannot be undone.`)
      ) {
        return;
      }
      await api(`/tenants/current/quotes/${q.id}`, { method: "DELETE" });
    });

  const openEdit = async (id: string): Promise<void> => {
    setError("");
    try {
      const d = await api<QuoteDetail>(`/tenants/current/quotes/${id}`);
      setEditing(d);
      setEditCustomer(d.customer_id);
      setEditValidUntil(d.valid_until ? d.valid_until.slice(0, 10) : "");
      setEditLines(
        d.lines.map((l) => ({
          description: l.description,
          quantity: String(Number(l.quantity)),
          priceKes: (Number(l.unit_price_cents) / 100).toString(),
          vatRate: l.vat_rate,
        })),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not open quote");
    }
  };

  const saveEdit = act(async () => {
    if (!editing) return;
    const lines = editLines
      .filter((l) => l.description.trim())
      .map((l) => ({
        description: l.description.trim(),
        quantity: Number(l.quantity) || 0,
        unitPriceCents: Math.round(Number(l.priceKes) * 100),
        vatRate: l.vatRate,
      }));
    if (!lines.length) throw new Error("Add at least one line");
    await api(`/tenants/current/quotes/${editing.id}`, {
      method: "PATCH",
      body: {
        customerId: editCustomer || undefined,
        validUntil: editValidUntil || null,
        lines,
      },
    });
    setEditing(null);
  });

  const setLine = (i: number, patch: Partial<EditLine>): void =>
    setEditLines((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));

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
              <SearchSelect
                options={customers.map((c) => ({ id: c.id, label: c.name }))}
                value={customerId}
                onChange={setCustomerId}
                placeholder="Search customers…"
              />
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
        <DataTable
          rows={quotes}
          csvName="quotes"
          searchKeys={["quote_no", "customer_name"]}
          pageSizeDefault={25}
          empty={
            <p className="muted">No quotes yet — most deals start here.</p>
          }
          columns={[
            {
              key: "quote_no",
              label: "No.",
              value: (q) => q.quote_no,
              render: (q) => <>Q-{q.quote_no}</>,
            },
            { key: "customer_name", label: "Customer" },
            {
              key: "total_cents",
              label: "Total",
              num: true,
              value: (q) => Number(q.total_cents),
              render: (q) => fmtKes(q.total_cents),
            },
            {
              key: "status",
              label: "Status",
              render: (q) => (
                <span
                  className={`pill ${q.status === "converted" ? "paid" : ""}`}
                >
                  {q.status}
                </span>
              ),
            },
            {
              key: "actions",
              label: "",
              value: () => "",
              render: (q) => (
                <div className="quote-actions">
                  <button className="btn-sm" disabled={busy} onClick={() => download(q)}>
                    Download
                  </button>
                  {EDITABLE.includes(q.status) && (
                    <button className="btn-sm" disabled={busy} onClick={() => void openEdit(q.id)}>
                      Edit
                    </button>
                  )}
                  {["draft", "sent", "accepted"].includes(q.status) && (
                    <button className="btn-sm" disabled={busy} onClick={() => void convert(q.id)()}>
                      Convert
                    </button>
                  )}
                  {!q.invoice_id && q.status !== "converted" && (
                    <button className="btn-sm danger" disabled={busy} onClick={() => void del(q)()}>
                      Delete
                    </button>
                  )}
                  {q.invoice_id && (
                    <Link href={`/invoices/view?id=${q.invoice_id}`}>invoice →</Link>
                  )}
                </div>
              ),
            },
          ]}
        />
      </div>

      {editing && (
        <div className="modal-overlay" onClick={() => setEditing(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-top">
              <h2 style={{ margin: 0 }}>Edit quote Q-{editing.quote_no}</h2>
              <button className="btn-sm" onClick={() => setEditing(null)}>✕</button>
            </div>
            <div className="row">
              <div style={{ flex: 1 }}>
                <label>Customer</label>
                <SearchSelect
                  options={customers.map((c) => ({ id: c.id, label: c.name }))}
                  value={editCustomer}
                  onChange={setEditCustomer}
                  placeholder="Search customers…"
                />
              </div>
              <div>
                <label>Valid until</label>
                <input
                  type="date"
                  value={editValidUntil}
                  onChange={(e) => setEditValidUntil(e.target.value)}
                />
              </div>
            </div>

            <label style={{ marginTop: 12 }}>Line items</label>
            {editLines.map((l, i) => (
              <div className="row quote-edit-line" key={i}>
                <div style={{ flex: 3 }}>
                  <input
                    placeholder="Description"
                    value={l.description}
                    onChange={(e) => setLine(i, { description: e.target.value })}
                  />
                </div>
                <div style={{ width: 80 }}>
                  <input
                    type="number" min="0.001" step="any" placeholder="Qty"
                    value={l.quantity}
                    onChange={(e) => setLine(i, { quantity: e.target.value })}
                  />
                </div>
                <div style={{ width: 120 }}>
                  <input
                    type="number" min="0" step="0.01" placeholder="Price (KES)"
                    value={l.priceKes}
                    onChange={(e) => setLine(i, { priceKes: e.target.value })}
                  />
                </div>
                <div style={{ width: 110 }}>
                  <select value={l.vatRate} onChange={(e) => setLine(i, { vatRate: e.target.value })}>
                    <option value="0.16">VAT 16%</option>
                    <option value="0">Zero-rated</option>
                    <option value="exempt">Exempt</option>
                  </select>
                </div>
                <button
                  className="btn-sm danger"
                  disabled={editLines.length <= 1}
                  onClick={() => setEditLines((prev) => prev.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              className="btn-sm"
              onClick={() =>
                setEditLines((prev) => [
                  ...prev,
                  { description: "", quantity: "1", priceKes: "", vatRate: "0.16" },
                ])
              }
            >
              + Add line
            </button>

            <div className="modal-actions">
              <button className="ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button disabled={busy} onClick={() => void saveEdit()}>
                Save changes
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
