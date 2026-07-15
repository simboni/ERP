"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { api, getApiBase, fmtKes, getTenantToken } from "@/lib/api";
import { ConfirmButton } from "@/components/ConfirmButton";

interface InvoiceDetail {
  id: string;
  invoice_no: string | null;
  status: string;
  customer_name: string;
  subtotal_cents: string;
  vat_cents: string;
  total_cents: string;
  amount_paid_cents: string;
  issue_date: string | null;
  fiscal_status: string | null;
  control_number: string | null;
  qr_payload: string | null;
  lines: {
    description: string;
    quantity: string;
    unit_price_cents: string;
    vat_rate: string;
    line_total_cents: string;
  }[];
}

function InvoiceView() {
  const router = useRouter();
  const id = useSearchParams().get("id") ?? "";
  const [inv, setInv] = useState<InvoiceDetail | null>(null);
  const [msisdn, setMsisdn] = useState("");
  const [creditReason, setCreditReason] = useState("");
  const [editing, setEditing] = useState(false);
  const [editLines, setEditLines] = useState<
    { description: string; quantity: string; unitKes: string; vatRate: string }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async (): Promise<void> => {
    setInv(await api<InvoiceDetail>(`/tenants/current/invoices/${id}`));
  }, [id]);

  useEffect(() => {
    if (!getTenantToken()) {
      router.replace("/");
      return;
    }
    load().catch((e) => setError(e instanceof Error ? e.message : "load failed"));
  }, [load, router]);

  const act = (fn: () => Promise<string>) => async (): Promise<void> => {
    setBusy(true);
    setError("");
    setMsg("");
    try {
      setMsg(await fn());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  };

  const openPdf = async (): Promise<void> => {
    const res = await fetch(`${await getApiBase()}/tenants/current/invoices/${id}/pdf`, {
      headers: { Authorization: `Bearer ${getTenantToken()}` },
    });
    const blob = await res.blob();
    window.open(URL.createObjectURL(blob), "_blank");
  };

  const collect = act(async () => {
    if (!/^2547\d{8}$/.test(msisdn)) throw new Error("Phone must be 2547XXXXXXXX");
    const outstanding = Number(inv!.total_cents) - Number(inv!.amount_paid_cents);
    await api(`/tenants/current/payments/stk`, {
      method: "POST",
      body: {
        amountCents: outstanding,
        msisdn,
        accountRef: `INV-${inv!.invoice_no}`,
        invoiceId: inv!.id,
      },
    });
    return `M-Pesa request for ${fmtKes(outstanding)} sent to ${msisdn}. The customer confirms on their phone.`;
  });

  const creditNote = act(async () => {
    if (!creditReason.trim()) throw new Error("Give a reason for the credit note");
    const r = await api<{ creditNoteNo: number }>(
      `/tenants/current/invoices/${id}/credit-note`,
      { method: "POST", body: { reason: creditReason.trim() } },
    );
    return `Credit note ${r.creditNoteNo} issued and sent to eTIMS.`;
  });

  if (!inv) return <p className="muted">{error || "Loading…"}</p>;
  const outstanding = Number(inv.total_cents) - Number(inv.amount_paid_cents);

  return (
    <>
      <p><Link href="/dashboard">← Dashboard</Link></p>
      <div className="row" style={{ alignItems: "baseline" }}>
        <h1>Invoice #{inv.invoice_no ?? "draft"}</h1>
        <span style={{ textAlign: "right" }}>
          <span className={`pill ${inv.status}`}>{inv.status}</span>{" "}
          {inv.fiscal_status && (
            <span className={`pill ${inv.fiscal_status}`}>
              eTIMS: {inv.control_number ?? inv.fiscal_status}
            </span>
          )}
        </span>
      </div>
      <p className="muted">
        {inv.customer_name} · {inv.issue_date ? new Date(inv.issue_date).toISOString().slice(0, 10) : "not issued"}
      </p>

      <div className="card">
        <table>
          <thead>
            <tr><th>Description</th><th>Qty</th><th>Unit</th><th>VAT</th><th>Total</th></tr>
          </thead>
          <tbody>
            {inv.lines.map((l, i) => (
              <tr key={i}>
                <td>{l.description}</td>
                <td>{Number(l.quantity)}</td>
                <td>{fmtKes(l.unit_price_cents)}</td>
                <td>{l.vat_rate === "0.16" ? "16%" : l.vat_rate === "0" ? "0%" : "exempt"}</td>
                <td>{fmtKes(l.line_total_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ textAlign: "right" }}>
          Subtotal {fmtKes(inv.subtotal_cents)} · VAT {fmtKes(inv.vat_cents)} ·{" "}
          <strong>Total {fmtKes(inv.total_cents)}</strong>
          {Number(inv.amount_paid_cents) > 0 && (
            <> · Paid {fmtKes(inv.amount_paid_cents)} · <strong>Due {fmtKes(outstanding)}</strong></>
          )}
        </p>
        <button className="secondary" onClick={() => void openPdf()}>Download PDF</button>
      </div>

      {msg && <div className="card" style={{ borderColor: "var(--brand)" }}>{msg}</div>}
      {error && <div className="err">{error}</div>}

      {inv.status === "draft" && (
        <div className="card">
          <div className="card-head">
            <h3>Edit entries (draft)</h3>
          </div>
          {!editing ? (
            <button
              className="secondary"
              onClick={() => {
                setEditLines(
                  inv.lines.map((l) => ({
                    description: l.description,
                    quantity: String(Number(l.quantity)),
                    unitKes: String(Number(l.unit_price_cents) / 100),
                    vatRate: l.vat_rate,
                  })),
                );
                setEditing(true);
              }}
            >
              Edit lines
            </button>
          ) : (
            <>
              {editLines.map((l, i) => (
                <div className="row" key={i} style={{ alignItems: "flex-end" }}>
                  <div style={{ flex: 2 }}>
                    <label>Description</label>
                    <input
                      value={l.description}
                      onChange={(e) =>
                        setEditLines((ls) => ls.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))
                      }
                    />
                  </div>
                  <div>
                    <label>Qty</label>
                    <input
                      type="number"
                      min="0.001"
                      step="0.001"
                      value={l.quantity}
                      onChange={(e) =>
                        setEditLines((ls) => ls.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))
                      }
                    />
                  </div>
                  <div>
                    <label>Unit (KES)</label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={l.unitKes}
                      onChange={(e) =>
                        setEditLines((ls) => ls.map((x, j) => (j === i ? { ...x, unitKes: e.target.value } : x)))
                      }
                    />
                  </div>
                  <div>
                    <label>VAT</label>
                    <select
                      value={l.vatRate}
                      onChange={(e) =>
                        setEditLines((ls) => ls.map((x, j) => (j === i ? { ...x, vatRate: e.target.value } : x)))
                      }
                    >
                      <option value="0.16">16%</option>
                      <option value="0">0%</option>
                      <option value="exempt">Exempt</option>
                    </select>
                  </div>
                  <div style={{ flex: 0 }}>
                    <button
                      type="button"
                      className="secondary dt-btn"
                      style={{ marginTop: 0 }}
                      onClick={() => setEditLines((ls) => ls.filter((_, j) => j !== i))}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
              <div className="quick-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    setEditLines((ls) => [...ls, { description: "", quantity: "1", unitKes: "", vatRate: "0.16" }])
                  }
                >
                  + Add line
                </button>
                <button
                  disabled={busy || editLines.length === 0}
                  onClick={() =>
                    void act(async () => {
                      await api(`/tenants/current/invoices/${id}`, {
                        method: "PATCH",
                        body: {
                          lines: editLines
                            .filter((l) => l.description.trim() && Number(l.quantity) > 0)
                            .map((l) => ({
                              description: l.description.trim(),
                              quantity: Number(l.quantity),
                              unitPriceCents: Math.round(Number(l.unitKes || 0) * 100),
                              vatRate: l.vatRate,
                            })),
                        },
                      });
                      setEditing(false);
                      return "Draft updated.";
                    })()
                  }
                >
                  Save changes
                </button>
                <button type="button" className="secondary" onClick={() => setEditing(false)}>
                  Discard
                </button>
              </div>
            </>
          )}
          <p className="muted">
            Issued invoices are immutable by law — corrections after issuing
            go through a credit note below.
          </p>
        </div>
      )}

      {inv.status === "draft" && !editing && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Ready to issue?</h2>
          <p className="muted">
            Issuing fiscalizes this invoice with KRA eTIMS and posts it to
            your books. After that it cannot be edited — only corrected with
            a credit note.
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const r = await api<{ invoiceNo: number }>(
                  `/tenants/current/invoices/${id}/issue`,
                  { method: "POST" },
                );
                return `Invoice ${r.invoiceNo} issued and sent to eTIMS.`;
              })()
            }
          >
            Issue invoice (eTIMS)
          </button>
        </div>
      )}

      {inv.status === "issued" && outstanding > 0 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Collect via M-Pesa</h2>
          <div className="row">
            <div>
              <label>Customer phone (2547XXXXXXXX)</label>
              <input value={msisdn} onChange={(e) => setMsisdn(e.target.value)} />
            </div>
          </div>
          <button disabled={busy} onClick={() => void collect()}>
            Request {fmtKes(outstanding)} now
          </button>
        </div>
      )}

      {["issued", "paid"].includes(inv.status) && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Credit note (cancels this invoice)</h2>
          <label>Reason</label>
          <input
            value={creditReason}
            onChange={(e) => setCreditReason(e.target.value)}
            placeholder="e.g. Goods returned damaged"
          />
          <ConfirmButton
            className="secondary"
            disabled={busy}
            onConfirm={() => void creditNote()}
          >
            Issue credit note
          </ConfirmButton>
        </div>
      )}
    </>
  );
}

export default function InvoicePage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <InvoiceView />
    </Suspense>
  );
}
