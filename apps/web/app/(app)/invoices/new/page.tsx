"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, getTenantToken } from "@/lib/api";
import { SearchSelect } from "@/components/SearchSelect";

interface Branch {
  id: string;
  name: string;
}
interface Customer {
  id: string;
  name: string;
}
interface Line {
  description: string;
  quantity: number;
  unitPriceKes: string;
  vatRate: "0.16" | "0" | "exempt";
}

const EMPTY_LINE: Line = {
  description: "",
  quantity: 1,
  unitPriceKes: "",
  vatRate: "0.16",
};

export default function NewInvoice() {
  const router = useRouter();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [branchId, setBranchId] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [newCustomer, setNewCustomer] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [lines, setLines] = useState<Line[]>([{ ...EMPTY_LINE }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (): Promise<void> => {
    const [b, c] = await Promise.all([
      api<Branch[]>("/tenants/current/branches"),
      api<Customer[]>("/tenants/current/customers"),
    ]);
    setBranches(b);
    setCustomers(c);
    if (b[0]) setBranchId(b[0].id);
    // Deep links (e.g. the customer page's "New invoice" action) preselect
    // the customer via ?customer=<id>.
    const wanted = new URLSearchParams(window.location.search).get("customer");
    const preselect = wanted && c.find((x) => x.id === wanted);
    if (preselect) setCustomerId(preselect.id);
    else if (c[0]) setCustomerId(c[0].id);
  }, []);

  useEffect(() => {
    if (!getTenantToken()) {
      router.replace("/login");
      return;
    }
    load().catch((err) =>
      setError(err instanceof Error ? err.message : "Failed to load"),
    );
  }, [load, router]);

  const setLine = (i: number, patch: Partial<Line>): void => {
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  };

  const submit = async (issueNow: boolean): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      let branch = branchId;
      if (!branch) {
        if (!newBranch.trim()) throw new Error("Add a branch name first");
        const b = await api<Branch>("/tenants/current/branches", {
          method: "POST",
          body: { code: "HQ", name: newBranch.trim() },
        });
        branch = b.id;
      }
      let customer = customerId;
      if (!customer) {
        if (!newCustomer.trim()) throw new Error("Add a customer name first");
        const c = await api<Customer>("/tenants/current/customers", {
          method: "POST",
          body: { name: newCustomer.trim() },
        });
        customer = c.id;
      }
      // Seed the chart of accounts idempotently before first issue.
      await api("/tenants/current/accounts/seed-defaults", { method: "POST" });

      const draft = await api<{ id: string }>("/tenants/current/invoices", {
        method: "POST",
        body: {
          branchId: branch,
          customerId: customer,
          lines: lines.map((l) => ({
            description: l.description,
            quantity: Number(l.quantity),
            unitPriceCents: Math.round(Number(l.unitPriceKes) * 100),
            vatRate: l.vatRate,
          })),
        },
      });
      if (issueNow) {
        await api(`/tenants/current/invoices/${draft.id}/issue`, {
          method: "POST",
        });
      }
      // Land on the invoice itself: drafts show Edit + Issue there.
      router.push(`/invoices/view?id=${draft.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save invoice");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>New invoice</h1>
      <p className="muted">Issued invoices are fiscalized with KRA eTIMS automatically.</p>
      <form onSubmit={(e) => e.preventDefault()}>
        <div className="card">
          <div className="row">
            <div>
              <label>Branch</label>
              {branches.length ? (
                <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              ) : (
                <input
                  placeholder="e.g. Main Shop"
                  value={newBranch}
                  onChange={(e) => setNewBranch(e.target.value)}
                />
              )}
            </div>
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
                <input
                  placeholder="Customer name"
                  value={newCustomer}
                  onChange={(e) => setNewCustomer(e.target.value)}
                />
              )}
            </div>
          </div>
        </div>

        {lines.map((l, i) => (
          <div className="card" key={i}>
            <div className="row">
              <div style={{ flex: 2 }}>
                <label>Description</label>
                <input
                  value={l.description}
                  onChange={(e) => setLine(i, { description: e.target.value })}
                  required
                />
              </div>
              <div>
                <label>Qty</label>
                <input
                  type="number"
                  min="0.001"
                  step="0.001"
                  value={l.quantity}
                  onChange={(e) => setLine(i, { quantity: Number(e.target.value) })}
                  required
                />
              </div>
              <div>
                <label>Unit price (KES)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={l.unitPriceKes}
                  onChange={(e) => setLine(i, { unitPriceKes: e.target.value })}
                  required
                />
              </div>
              <div>
                <label>VAT</label>
                <select
                  value={l.vatRate}
                  onChange={(e) =>
                    setLine(i, { vatRate: e.target.value as Line["vatRate"] })
                  }
                >
                  <option value="0.16">16%</option>
                  <option value="0">Zero-rated</option>
                  <option value="exempt">Exempt</option>
                </select>
              </div>
            </div>
          </div>
        ))}

        <button
          type="button"
          className="secondary"
          onClick={() => setLines((ls) => [...ls, { ...EMPTY_LINE }])}
        >
          + Add line
        </button>{" "}
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void submit(false)}
        >
          Save as draft
        </button>{" "}
        <button disabled={busy} type="button" onClick={() => void submit(true)}>
          Issue invoice (eTIMS)
        </button>
        <p className="muted">
          Save as draft to review or edit later — drafts can be changed
          freely and are only fiscalized when you issue them. Once issued,
          an invoice is final; a faulty issued invoice is corrected with a
          credit note from its page.
        </p>
        {error && <div className="err">{error}</div>}
      </form>
    </>
  );
}
