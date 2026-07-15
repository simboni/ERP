"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmtKes } from "@/lib/api";
import { DataTable } from "@/components/DataTable";
import { useI18n } from "@/lib/i18n";

interface CustomerRow {
  id: string;
  name: string;
  kra_pin: string | null;
  phone: string | null;
  email: string | null;
  invoice_count: number;
  invoiced_cents: string;
  outstanding_cents: string;
  last_invoice_date: string | null;
}
interface CustomerInvoice {
  id: string;
  invoice_no: string | null;
  status: string;
  issue_date: string | null;
  due_date: string | null;
  total_cents: string;
  amount_paid_cents: string;
}
interface CustomerForm {
  name: string;
  phone: string;
  email: string;
  kraPin: string;
}

const EMPTY_FORM: CustomerForm = { name: "", phone: "", email: "", kraPin: "" };

export default function CustomersPage() {
  const { t } = useI18n();
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [selected, setSelected] = useState<CustomerRow | null>(null);
  const [history, setHistory] = useState<CustomerInvoice[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<CustomerForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<CustomerRow[]> => {
    const r = await api<CustomerRow[]>("/tenants/current/customers/overview");
    setRows(r);
    return r;
  }, []);

  useEffect(() => {
    load().catch((err) =>
      setError(err instanceof Error ? err.message : "Failed to load"),
    );
  }, [load]);

  const open = async (c: CustomerRow): Promise<void> => {
    setSelected(c);
    setEditing(false);
    setMsg("");
    setHistory(null);
    try {
      setHistory(
        await api<CustomerInvoice[]>(
          `/tenants/current/customers/${c.id}/invoices`,
        ),
      );
    } catch {
      setHistory([]);
    }
  };

  const createCustomer = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      await api("/tenants/current/customers", {
        method: "POST",
        body: {
          name: form.name,
          phone: form.phone || undefined,
          email: form.email || undefined,
          kraPin: form.kraPin || undefined,
        },
      });
      setForm(EMPTY_FORM);
      setAdding(false);
      setMsg(`Customer added — invoice them from here or the top bar.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      await api(`/tenants/current/customers/${selected.id}`, {
        method: "PATCH",
        body: {
          name: form.name || undefined,
          phone: form.phone || undefined,
          email: form.email || undefined,
          kraPin: form.kraPin || undefined,
        },
      });
      const fresh = await load();
      const updated = fresh.find((r) => r.id === selected.id);
      if (updated) setSelected(updated);
      setEditing(false);
      setMsg("Details saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  };

  const todayIso = new Date().toISOString().slice(0, 10);
  const overdue = useMemo(() => {
    if (!history) return { count: 0, cents: 0 };
    let count = 0;
    let cents = 0;
    for (const i of history) {
      const owed = Number(i.total_cents) - Number(i.amount_paid_cents);
      if (
        owed > 0 &&
        i.due_date &&
        i.due_date.slice(0, 10) < todayIso &&
        !["void", "draft", "paid"].includes(i.status)
      ) {
        count += 1;
        cents += owed;
      }
    }
    return { count, cents };
  }, [history, todayIso]);

  const customerForm = (
    submitLabel: string,
    onSubmit: () => Promise<void>,
    onCancel: () => void,
  ) => (
    <div className="card">
      <div className="row">
        <div style={{ flex: 2 }}>
          <label>Name *</label>
          <input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </div>
        <div>
          <label>Phone</label>
          <input
            value={form.phone}
            placeholder="07XX XXX XXX"
            onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
          />
        </div>
        <div>
          <label>Email</label>
          <input
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          />
        </div>
        <div>
          <label>KRA PIN</label>
          <input
            value={form.kraPin}
            placeholder="P051…"
            onChange={(e) =>
              setForm((f) => ({ ...f, kraPin: e.target.value }))
            }
          />
        </div>
      </div>
      <button
        disabled={busy || !form.name.trim()}
        onClick={() => void onSubmit()}
      >
        {submitLabel}
      </button>{" "}
      <button className="secondary" disabled={busy} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );

  if (selected) {
    return (
      <>
        <p>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setSelected(null);
            }}
          >
            ← {t("navCustomers")}
          </a>
        </p>
        <h1>{selected.name}</h1>
        {msg && (
          <div className="card" style={{ borderColor: "var(--brand)" }}>
            {msg}
          </div>
        )}
        {error && <div className="err">{error}</div>}

        {/* One-tap actions for this customer */}
        <div className="quick-actions">
          <Link
            href={`/invoices/new?customer=${selected.id}`}
            className="action-chip primary"
          >
            ＋ New invoice
          </Link>
          {selected.phone && (
            <a
              href={`tel:${selected.phone.replace(/\s+/g, "")}`}
              className="action-chip"
            >
              📞 Call
            </a>
          )}
          {(selected.phone || selected.email) && (
            <a
              href={
                selected.email
                  ? `mailto:${selected.email}`
                  : `sms:${selected.phone!.replace(/\s+/g, "")}`
              }
              className="action-chip"
            >
              ✉ Message
            </a>
          )}
          <button
            type="button"
            className="secondary"
            style={{ marginTop: 0 }}
            onClick={() => {
              setForm({
                name: selected.name,
                phone: selected.phone ?? "",
                email: selected.email ?? "",
                kraPin: selected.kra_pin ?? "",
              });
              setEditing((v) => !v);
            }}
          >
            ✎ Edit details
          </button>
        </div>

        {editing && customerForm("Save", saveEdit, () => setEditing(false))}

        <div className="tiles">
          <div className="tile tile-1">
            <span className="muted">Invoiced (all time)</span>
            <div className="stat">{fmtKes(selected.invoiced_cents)}</div>
          </div>
          <div className="tile tile-2">
            <span className="muted">Outstanding</span>
            <div className="stat">{fmtKes(selected.outstanding_cents)}</div>
          </div>
          <div className="tile tile-3">
            <span className="muted">Overdue now</span>
            <div className="stat">
              {overdue.count ? fmtKes(overdue.cents) : "—"}
            </div>
            {overdue.count > 0 && (
              <span className="muted">
                {overdue.count} invoice{overdue.count > 1 ? "s" : ""} past due
              </span>
            )}
          </div>
          <div className="tile tile-4">
            <span className="muted">{t("invoices")}</span>
            <div className="stat">{selected.invoice_count}</div>
            {selected.last_invoice_date && (
              <span className="muted">
                last {selected.last_invoice_date.slice(0, 10)}
              </span>
            )}
          </div>
        </div>
        <p className="muted">
          {selected.phone && <>📞 {selected.phone} · </>}
          {selected.email && <>✉ {selected.email} · </>}
          {selected.kra_pin && <>PIN {selected.kra_pin}</>}
        </p>

        <h2>Statement — {t("invoices")}</h2>
        <div className="card">
          {history === null ? (
            <p className="muted">Loading…</p>
          ) : (
            <DataTable
              rows={history}
              csvName={`statement-${selected.name.toLowerCase().replace(/\s+/g, "-")}`}
              searchKeys={["invoice_no", "status"]}
              pageSizeDefault={10}
              empty={<p className="muted">{t("noInvoices")}</p>}
              columns={[
                {
                  key: "invoice_no",
                  label: "No.",
                  render: (i) => (
                    <Link href={`/invoices/view?id=${i.id}`}>
                      {i.invoice_no ?? "draft"}
                    </Link>
                  ),
                },
                {
                  key: "issue_date",
                  label: "Date",
                  value: (i) => i.issue_date?.slice(0, 10) ?? "",
                  render: (i) => i.issue_date?.slice(0, 10) ?? "—",
                },
                {
                  key: "due_date",
                  label: "Due",
                  value: (i) => i.due_date?.slice(0, 10) ?? "",
                  render: (i) => {
                    const due = i.due_date?.slice(0, 10);
                    if (!due) return "—";
                    const owed =
                      Number(i.total_cents) - Number(i.amount_paid_cents);
                    const late =
                      owed > 0 &&
                      due < todayIso &&
                      !["void", "draft", "paid"].includes(i.status);
                    return late ? <strong>{due} ⚠</strong> : due;
                  },
                },
                {
                  key: "total_cents",
                  label: t("total"),
                  num: true,
                  value: (i) => Number(i.total_cents),
                  render: (i) => fmtKes(i.total_cents),
                },
                {
                  key: "amount_paid_cents",
                  label: "Paid",
                  num: true,
                  value: (i) => Number(i.amount_paid_cents),
                  render: (i) => fmtKes(i.amount_paid_cents),
                },
                {
                  key: "status",
                  label: t("status"),
                  render: (i) => (
                    <span className={`pill ${i.status}`}>{i.status}</span>
                  ),
                },
              ]}
            />
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <h1>{t("navCustomers")}</h1>
      {msg && (
        <div className="card" style={{ borderColor: "var(--brand)" }}>
          {msg}
        </div>
      )}
      {error && <div className="err">{error}</div>}
      {adding &&
        customerForm("Add customer", createCustomer, () => setAdding(false))}
      <div className="card">
        <DataTable
          rows={rows}
          csvName="customers"
          searchKeys={["name", "phone", "email"]}
          pageSizeDefault={25}
          toolbar={
            <button
              type="button"
              style={{ marginTop: 0 }}
              onClick={() => {
                setForm(EMPTY_FORM);
                setAdding((v) => !v);
              }}
            >
              ＋ New customer
            </button>
          }
          empty={
            <div className="empty">
              <span className="empty-icon">🤝</span>
              <p>No customers yet.</p>
              <button
                type="button"
                onClick={() => {
                  setForm(EMPTY_FORM);
                  setAdding(true);
                }}
              >
                ＋ Add your first customer
              </button>
            </div>
          }
          columns={[
            {
              key: "name",
              label: t("customer"),
              render: (c) => (
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    void open(c);
                  }}
                >
                  {c.name}
                </a>
              ),
            },
            {
              key: "phone",
              label: "Contact",
              value: (c) => c.phone ?? c.email ?? "",
              render: (c) => (
                <span className="muted">{c.phone ?? c.email ?? "—"}</span>
              ),
            },
            {
              key: "invoice_count",
              label: t("invoices"),
              num: true,
              value: (c) => c.invoice_count,
            },
            {
              key: "invoiced_cents",
              label: "Invoiced",
              num: true,
              value: (c) => Number(c.invoiced_cents),
              render: (c) => fmtKes(c.invoiced_cents),
            },
            {
              key: "outstanding_cents",
              label: "Outstanding",
              num: true,
              value: (c) => Number(c.outstanding_cents),
              render: (c) =>
                Number(c.outstanding_cents) > 0 ? (
                  <strong>{fmtKes(c.outstanding_cents)}</strong>
                ) : (
                  <span className="muted">—</span>
                ),
            },
          ]}
        />
      </div>
    </>
  );
}
