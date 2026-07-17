"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmtKes, fmtKes0, getApiBase, getTenantToken } from "@/lib/api";
import { DataTable } from "@/components/DataTable";
import { SearchSelect } from "@/components/SearchSelect";

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

type Tab = "reconcile" | "history";

const railLabel = (rail: string): string =>
  rail === "cash"
    ? "Cash"
    : rail === "bank"
      ? "Bank"
      : "M-Pesa";

export default function PaymentsPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("reconcile");
  const [payments, setPayments] = useState<Payment[]>([]);
  const [unmatched, setUnmatched] = useState<Unmatched[]>([]);
  const [openInvoices, setOpenInvoices] = useState<Invoice[]>([]);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
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
      router.replace("/login");
      return;
    }
    load().catch((e) => setError(e instanceof Error ? e.message : "load failed"));
  }, [load, router]);

  const openReceipt = async (paymentId: string): Promise<void> => {
    const res = await fetch(
      `${await getApiBase()}/tenants/current/payments/${paymentId}/receipt.pdf`,
      { headers: { Authorization: `Bearer ${getTenantToken()}` } },
    );
    if (!res.ok) {
      setError("Could not generate the receipt");
      return;
    }
    window.open(URL.createObjectURL(await res.blob()), "_blank");
  };

  const match = async (paymentId: string): Promise<void> => {
    const invoiceId = pick[paymentId];
    if (!invoiceId) return;
    setBusy(true);
    setError("");
    setMsg("");
    try {
      await api(`/tenants/current/payments/${paymentId}/match`, {
        method: "POST",
        body: { invoiceId },
      });
      setMsg("Payment matched and posted to the books.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "match failed");
    } finally {
      setBusy(false);
    }
  };

  // Money-received summary from confirmed payments, split by rail.
  const summary = useMemo(() => {
    const confirmed = payments.filter((p) => p.state === "confirmed");
    const byRail = { cash: 0, bank: 0, mpesa: 0 };
    for (const p of confirmed) {
      const c = Number(p.amount_cents);
      if (p.rail === "cash") byRail.cash += c;
      else if (p.rail === "bank") byRail.bank += c;
      else byRail.mpesa += c;
    }
    const unmatchedCents = unmatched.reduce(
      (s, u) => s + Number(u.amount_cents),
      0,
    );
    return {
      total: byRail.cash + byRail.bank + byRail.mpesa,
      byRail,
      unmatchedCents,
    };
  }, [payments, unmatched]);

  const invoiceOptions = openInvoices.map((i) => ({
    id: i.id,
    label: `#${i.invoice_no} · ${i.customer_name}`,
    sub: fmtKes(i.total_cents),
  }));

  return (
    <>
      <p>
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1>Payments &amp; reconciliation</h1>
      <p className="muted">
        Where money coming in gets tied to the right invoice. M-Pesa
        payments auto-match by reference and amount; anything that
        can&apos;t be matched automatically waits here for you to place it.
      </p>

      <div className="tiles">
        <div className="tile tile-4">
          <div className="tile-value">{fmtKes0(summary.total)}</div>
          <div className="tile-label">Received (confirmed)</div>
        </div>
        <div className="tile tile-3">
          <div className="tile-value">{fmtKes0(summary.byRail.mpesa)}</div>
          <div className="tile-label">via M-Pesa</div>
        </div>
        <div className="tile tile-2">
          <div className="tile-value">
            {fmtKes0(summary.byRail.cash + summary.byRail.bank)}
          </div>
          <div className="tile-label">Cash &amp; bank</div>
        </div>
        <div className="tile tile-1">
          <div className="tile-value">{unmatched.length}</div>
          <div className="tile-label">
            Awaiting matching · {fmtKes0(summary.unmatchedCents)}
          </div>
        </div>
      </div>

      <div className="tabs">
        {(
          [
            ["reconcile", `To reconcile (${unmatched.length})`],
            ["history", `All payments (${payments.length})`],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={tab === key ? "tab active" : "tab"}
            onClick={() => {
              setTab(key);
              setError("");
              setMsg("");
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <div className="err">{error}</div>}
      {msg && (
        <div className="card" style={{ borderColor: "var(--brand)" }}>
          {msg}
        </div>
      )}

      {tab === "reconcile" && (
        <div className="card">
          {unmatched.length === 0 ? (
            <div className="empty">
              <span className="empty-icon">✅</span>
              <p>
                Nothing to reconcile — every payment received is tied to an
                invoice. New M-Pesa payments that don&apos;t auto-match will
                appear here.
              </p>
            </div>
          ) : (
            <DataTable
              rows={unmatched}
              csvName="unmatched-payments"
              searchKeys={["receipt_number", "msisdn", "account_ref"]}
              pageSizeDefault={10}
              columns={[
                {
                  key: "receipt_number",
                  label: "Receipt",
                  render: (u) =>
                    u.receipt_number || <span className="muted">—</span>,
                },
                {
                  key: "msisdn",
                  label: "From",
                  render: (u) => u.msisdn || <span className="muted">—</span>,
                },
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
                  render: (u) => <strong>{fmtKes(u.amount_cents)}</strong>,
                },
                {
                  key: "actions",
                  label: "Match to invoice",
                  value: () => "",
                  render: (u) => (
                    <span
                      style={{
                        display: "inline-flex",
                        gap: 6,
                        alignItems: "center",
                        minWidth: 280,
                      }}
                    >
                      <span style={{ flex: 1, minWidth: 180 }}>
                        <SearchSelect
                          options={invoiceOptions}
                          value={pick[u.id] ?? ""}
                          onChange={(id) =>
                            setPick((s) => ({ ...s, [u.id]: id }))
                          }
                          placeholder="Search invoices…"
                        />
                      </span>
                      <button
                        style={{ marginTop: 0 }}
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
          )}
        </div>
      )}

      {tab === "history" && (
        <div className="card">
          <DataTable
            rows={payments}
            csvName="payments"
            searchKeys={["receipt_number", "rail", "account_ref"]}
            pageSizeDefault={25}
            empty={
              <div className="empty">
                <span className="empty-icon">💳</span>
                <p>
                  No payments yet. Record payments on an invoice, sell on the
                  POS, or register your M-Pesa paybill under Settings so
                  payments reconcile themselves.
                </p>
              </div>
            }
            columns={[
              {
                key: "confirmed_at",
                label: "Date",
                value: (p) => p.confirmed_at ?? "",
                render: (p) => (
                  <span className="muted">
                    {p.confirmed_at?.slice(0, 10) ?? "—"}
                  </span>
                ),
              },
              {
                key: "receipt_number",
                label: "Receipt",
                value: (p) => p.receipt_number ?? "",
                render: (p) =>
                  p.receipt_number ?? <span className="muted">—</span>,
              },
              {
                key: "rail",
                label: "Channel",
                value: (p) => railLabel(p.rail),
                render: (p) => (
                  <span className="pill">{railLabel(p.rail)}</span>
                ),
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
                value: (p) => (p.invoice_id ? "yes" : "no"),
                render: (p) =>
                  p.invoice_id ? (
                    <Link href={`/invoices/view?id=${p.invoice_id}`}>view</Link>
                  ) : (
                    <span className="muted">unmatched</span>
                  ),
              },
              {
                key: "receipt",
                label: "",
                value: () => "",
                render: (p) =>
                  p.state === "confirmed" && p.invoice_id ? (
                    <button
                      type="button"
                      className="secondary dt-btn"
                      onClick={() => void openReceipt(p.id)}
                    >
                      🧾 Receipt
                    </button>
                  ) : null,
              },
            ]}
          />
        </div>
      )}
    </>
  );
}
