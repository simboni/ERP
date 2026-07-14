"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, fmtKes, getTenantToken } from "@/lib/api";

interface Supplier {
  id: string;
  name: string;
}
interface Bill {
  id: string;
  status: string;
  bill_date: string;
  total_cents: string;
  vat_cents: string;
  supplier_invoice_no: string | null;
  etims_control_number: string | null;
  supplier_name: string;
}

export default function PurchasesPage() {
  const router = useRouter();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [billsList, setBillsList] = useState<Bill[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [newSupplier, setNewSupplier] = useState("");
  const [desc, setDesc] = useState("");
  const [amountKes, setAmountKes] = useState("");
  const [vatRate, setVatRate] = useState<"0.16" | "0" | "exempt">("0.16");
  const [etims, setEtims] = useState("");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (): Promise<void> => {
    const [s, b] = await Promise.all([
      api<Supplier[]>("/tenants/current/suppliers"),
      api<Bill[]>("/tenants/current/bills"),
    ]);
    setSuppliers(s);
    setBillsList(b);
    if (s[0] && !supplierId) setSupplierId(s[0].id);
  }, [supplierId]);

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

  const addBill = act(async () => {
    let supplier = supplierId;
    if (!supplier) {
      if (!newSupplier.trim()) throw new Error("Add a supplier name first");
      const s = await api<Supplier>("/tenants/current/suppliers", {
        method: "POST",
        body: { name: newSupplier.trim() },
      });
      supplier = s.id;
      setNewSupplier("");
    }
    await api("/tenants/current/accounts/seed-defaults", { method: "POST" });
    await api("/tenants/current/bills", {
      method: "POST",
      body: {
        supplierId: supplier,
        billDate: new Date().toISOString().slice(0, 10),
        supplierInvoiceNo: invoiceNo || undefined,
        etimsControlNumber: etims || undefined,
        lines: [
          {
            description: desc,
            quantity: 1,
            unitPriceCents: Math.round(Number(amountKes) * 100),
            vatRate,
          },
        ],
      },
    });
    setDesc("");
    setAmountKes("");
    setEtims("");
    setInvoiceNo("");
  });

  const approve = (id: string) =>
    act(async () => {
      await api(`/tenants/current/bills/${id}/approve`, { method: "POST" });
    });
  const pay = (id: string) =>
    act(async () => {
      await api(`/tenants/current/bills/${id}/pay`, {
        method: "POST",
        body: { method: "bank" },
      });
    });

  return (
    <>
      <p>
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1>Purchases</h1>
      {error && <div className="err">{error}</div>}

      <h2>New bill</h2>
      <div className="card">
        <div className="row">
          <div>
            <label>Supplier</label>
            {suppliers.length ? (
              <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            ) : (
              <input
                placeholder="Supplier name"
                value={newSupplier}
                onChange={(e) => setNewSupplier(e.target.value)}
              />
            )}
          </div>
          <div>
            <label>Supplier invoice no.</label>
            <input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
          </div>
        </div>
        <div className="row">
          <div style={{ flex: 2 }}>
            <label>Description</label>
            <input value={desc} onChange={(e) => setDesc(e.target.value)} />
          </div>
          <div>
            <label>Amount (KES, excl. VAT)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={amountKes}
              onChange={(e) => setAmountKes(e.target.value)}
            />
          </div>
          <div>
            <label>VAT</label>
            <select
              value={vatRate}
              onChange={(e) => setVatRate(e.target.value as typeof vatRate)}
            >
              <option value="0.16">16%</option>
              <option value="0">Zero-rated</option>
              <option value="exempt">Exempt</option>
            </select>
          </div>
        </div>
        <label>eTIMS control number (from the supplier&apos;s invoice)</label>
        <input
          placeholder="Without this the expense is NOT tax-deductible"
          value={etims}
          onChange={(e) => setEtims(e.target.value)}
        />
        <button disabled={busy || !desc || !amountKes} onClick={() => void addBill()}>
          Record bill
        </button>
      </div>

      <h2>Bills</h2>
      <div className="card">
        {billsList.length === 0 ? (
          <p className="muted">No bills yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th><th>Supplier</th><th>Ref</th><th>eTIMS</th>
                <th>Total</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {billsList.map((b) => (
                <tr key={b.id}>
                  <td>{new Date(b.bill_date).toISOString().slice(0, 10)}</td>
                  <td>{b.supplier_name}</td>
                  <td>{b.supplier_invoice_no ?? "—"}</td>
                  <td>
                    {b.etims_control_number ? (
                      <span className="pill signed">✓</span>
                    ) : (
                      <span className="pill" title="Not tax-deductible without eTIMS">⚠</span>
                    )}
                  </td>
                  <td>{fmtKes(b.total_cents)}</td>
                  <td><span className={`pill ${b.status === "paid" ? "paid" : ""}`}>{b.status}</span></td>
                  <td>
                    {b.status === "draft" && (
                      <button className="secondary" disabled={busy} onClick={() => void approve(b.id)()}>
                        Approve
                      </button>
                    )}
                    {b.status === "approved" && (
                      <button disabled={busy} onClick={() => void pay(b.id)()}>
                        Pay (bank)
                      </button>
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
