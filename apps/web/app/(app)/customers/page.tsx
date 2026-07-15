"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
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

export default function CustomersPage() {
  const { t } = useI18n();
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<CustomerRow | null>(null);
  const [history, setHistory] = useState<CustomerInvoice[] | null>(null);

  useEffect(() => {
    api<CustomerRow[]>("/tenants/current/customers/overview")
      .then(setRows)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load"),
      );
  }, []);

  const open = async (c: CustomerRow): Promise<void> => {
    setSelected(c);
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
        <div className="row">
          <div className="card">
            <span className="muted">Invoiced (all time)</span>
            <div className="stat">{fmtKes(selected.invoiced_cents)}</div>
          </div>
          <div className="card">
            <span className="muted">Outstanding</span>
            <div className="stat">{fmtKes(selected.outstanding_cents)}</div>
          </div>
        </div>
        <p className="muted">
          {selected.phone && <>📞 {selected.phone} · </>}
          {selected.email && <>✉ {selected.email} · </>}
          {selected.kra_pin && <>PIN {selected.kra_pin}</>}
        </p>
        <h2>{t("invoices")}</h2>
        <div className="card">
          {history === null ? (
            <p className="muted">Loading…</p>
          ) : history.length === 0 ? (
            <p className="muted">{t("noInvoices")}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>No.</th>
                  <th>Date</th>
                  <th>{t("total")}</th>
                  <th>Paid</th>
                  <th>{t("status")}</th>
                </tr>
              </thead>
              <tbody>
                {history.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <Link href={`/invoices/view?id=${i.id}`}>
                        {i.invoice_no ?? "draft"}
                      </Link>
                    </td>
                    <td>{i.issue_date?.slice(0, 10) ?? "—"}</td>
                    <td>{fmtKes(i.total_cents)}</td>
                    <td>{fmtKes(i.amount_paid_cents)}</td>
                    <td>
                      <span className={`pill ${i.status}`}>{i.status}</span>
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

  return (
    <>
      <h1>{t("navCustomers")}</h1>
      {error && <div className="err">{error}</div>}
      <div className="card">
        <DataTable
          rows={rows}
          csvName="customers"
          searchKeys={["name", "phone", "email"]}
          pageSizeDefault={25}
          empty={
            <div className="empty">
              <span className="empty-icon">🤝</span>
              <p>
                No customers yet — they are created with your first invoice
                or quote.
              </p>
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
