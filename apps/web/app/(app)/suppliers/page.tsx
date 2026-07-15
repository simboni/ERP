"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmtKes } from "@/lib/api";
import { DataTable } from "@/components/DataTable";
import { useI18n } from "@/lib/i18n";

interface SupplierRow {
  id: string;
  name: string;
  kra_pin: string | null;
  phone: string | null;
  email: string | null;
  bill_count: number;
  billed_cents: string;
  unpaid_cents: string;
  last_bill_date: string | null;
}
interface SupplierBill {
  id: string;
  status: string;
  bill_date: string | null;
  due_date: string | null;
  total_cents: string;
  vat_cents: string;
  supplier_invoice_no: string | null;
}
interface SupplierForm {
  name: string;
  phone: string;
  email: string;
  kraPin: string;
}

const EMPTY_FORM: SupplierForm = { name: "", phone: "", email: "", kraPin: "" };

export default function SuppliersPage() {
  const { t } = useI18n();
  const [rows, setRows] = useState<SupplierRow[]>([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [selected, setSelected] = useState<SupplierRow | null>(null);
  const [history, setHistory] = useState<SupplierBill[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<SupplierForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<SupplierRow[]> => {
    const r = await api<SupplierRow[]>("/tenants/current/suppliers/overview");
    setRows(r);
    return r;
  }, []);

  useEffect(() => {
    load().catch((err) =>
      setError(err instanceof Error ? err.message : "Failed to load"),
    );
  }, [load]);

  const open = async (s: SupplierRow): Promise<void> => {
    setSelected(s);
    setEditing(false);
    setMsg("");
    setHistory(null);
    try {
      setHistory(
        await api<SupplierBill[]>(
          `/tenants/current/suppliers/${s.id}/bills`,
        ),
      );
    } catch {
      setHistory([]);
    }
  };

  const createSupplier = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      await api("/tenants/current/suppliers", {
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
      setMsg("Supplier added — record their bills from the Purchases page.");
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
      await api(`/tenants/current/suppliers/${selected.id}`, {
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
    for (const b of history) {
      if (
        b.status === "approved" &&
        b.due_date &&
        b.due_date.slice(0, 10) < todayIso
      ) {
        count += 1;
        cents += Number(b.total_cents);
      }
    }
    return { count, cents };
  }, [history, todayIso]);

  const supplierForm = (
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
            ← {t("navSuppliers")}
          </a>
        </p>
        <h1>{selected.name}</h1>
        {msg && (
          <div className="card" style={{ borderColor: "var(--brand)" }}>
            {msg}
          </div>
        )}
        {error && <div className="err">{error}</div>}

        <div className="quick-actions">
          <Link
            href={`/purchases?supplier=${selected.id}`}
            className="action-chip primary"
          >
            ＋ New bill
          </Link>
          <Link
            href={`/purchases?tab=newpo&supplier=${selected.id}`}
            className="action-chip"
          >
            ＋ Purchase order
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

        {editing && supplierForm("Save", saveEdit, () => setEditing(false))}

        <div className="tiles">
          <div className="tile tile-1">
            <span className="muted">Billed (all time)</span>
            <div className="stat">{fmtKes(selected.billed_cents)}</div>
          </div>
          <div className="tile tile-2">
            <span className="muted">Unpaid</span>
            <div className="stat">{fmtKes(selected.unpaid_cents)}</div>
          </div>
          <div className="tile tile-3">
            <span className="muted">Overdue now</span>
            <div className="stat">
              {overdue.count ? fmtKes(overdue.cents) : "—"}
            </div>
            {overdue.count > 0 && (
              <span className="muted">
                {overdue.count} bill{overdue.count > 1 ? "s" : ""} past due
              </span>
            )}
          </div>
          <div className="tile tile-4">
            <span className="muted">Bills</span>
            <div className="stat">{selected.bill_count}</div>
            {selected.last_bill_date && (
              <span className="muted">
                last {selected.last_bill_date.slice(0, 10)}
              </span>
            )}
          </div>
        </div>
        <p className="muted">
          {selected.phone && <>📞 {selected.phone} · </>}
          {selected.email && <>✉ {selected.email} · </>}
          {selected.kra_pin && <>PIN {selected.kra_pin}</>}
        </p>

        <h2>Statement — bills</h2>
        <div className="card">
          {history === null ? (
            <p className="muted">Loading…</p>
          ) : (
            <DataTable
              rows={history}
              csvName={`supplier-statement-${selected.name.toLowerCase().replace(/\s+/g, "-")}`}
              searchKeys={["supplier_invoice_no", "status"]}
              pageSizeDefault={10}
              empty={
                <p className="muted">
                  No bills from this supplier yet — record one on the
                  Purchases page.
                </p>
              }
              columns={[
                {
                  key: "supplier_invoice_no",
                  label: "Ref",
                  render: (b) => b.supplier_invoice_no ?? "—",
                },
                {
                  key: "bill_date",
                  label: "Date",
                  value: (b) => b.bill_date?.slice(0, 10) ?? "",
                  render: (b) => b.bill_date?.slice(0, 10) ?? "—",
                },
                {
                  key: "due_date",
                  label: "Due",
                  value: (b) => b.due_date?.slice(0, 10) ?? "",
                  render: (b) => {
                    const due = b.due_date?.slice(0, 10);
                    if (!due) return "—";
                    const late = b.status === "approved" && due < todayIso;
                    return late ? <strong>{due} ⚠</strong> : due;
                  },
                },
                {
                  key: "total_cents",
                  label: t("total"),
                  num: true,
                  value: (b) => Number(b.total_cents),
                  render: (b) => fmtKes(b.total_cents),
                },
                {
                  key: "status",
                  label: t("status"),
                  render: (b) => (
                    <span className={`pill ${b.status}`}>{b.status}</span>
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
      <h1>{t("navSuppliers")}</h1>
      {msg && (
        <div className="card" style={{ borderColor: "var(--brand)" }}>
          {msg}
        </div>
      )}
      {error && <div className="err">{error}</div>}
      {adding &&
        supplierForm("Add supplier", createSupplier, () => setAdding(false))}
      <div className="card">
        <DataTable
          rows={rows}
          csvName="suppliers"
          searchKeys={["name", "phone", "email"]}
          pageSizeDefault={10}
          toolbar={
            <button
              type="button"
              style={{ marginTop: 0 }}
              onClick={() => {
                setForm(EMPTY_FORM);
                setAdding((v) => !v);
              }}
            >
              ＋ New supplier
            </button>
          }
          empty={
            <div className="empty">
              <span className="empty-icon">🚚</span>
              <p>No suppliers yet.</p>
              <button
                type="button"
                onClick={() => {
                  setForm(EMPTY_FORM);
                  setAdding(true);
                }}
              >
                ＋ Add your first supplier
              </button>
            </div>
          }
          columns={[
            {
              key: "name",
              label: "Supplier",
              render: (s) => (
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    void open(s);
                  }}
                >
                  {s.name}
                </a>
              ),
            },
            {
              key: "phone",
              label: "Contact",
              value: (s) => s.phone ?? s.email ?? "",
              render: (s) => (
                <span className="muted">{s.phone ?? s.email ?? "—"}</span>
              ),
            },
            {
              key: "bill_count",
              label: "Bills",
              num: true,
              value: (s) => s.bill_count,
            },
            {
              key: "billed_cents",
              label: "Billed",
              num: true,
              value: (s) => Number(s.billed_cents),
              render: (s) => fmtKes(s.billed_cents),
            },
            {
              key: "unpaid_cents",
              label: "Unpaid",
              num: true,
              value: (s) => Number(s.unpaid_cents),
              render: (s) =>
                Number(s.unpaid_cents) > 0 ? (
                  <strong>{fmtKes(s.unpaid_cents)}</strong>
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
