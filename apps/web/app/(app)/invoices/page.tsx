"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api, fmtKes } from "@/lib/api";
import { DataTable } from "@/components/DataTable";
import { useI18n } from "@/lib/i18n";

interface InvoiceRow {
  id: string;
  invoice_no: string | null;
  status: string;
  total_cents: string;
  amount_paid_cents?: string | null;
  customer_name: string;
  issue_date: string | null;
  due_date: string | null;
  fiscal_status: string | null;
  control_number: string | null;
}

export default function InvoicesPage() {
  const { t } = useI18n();
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    api<InvoiceRow[]>("/tenants/current/invoices")
      .then(setInvoices)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load"),
      );
  }, []);

  const statuses = useMemo(
    () => Array.from(new Set(invoices.map((i) => i.status))).sort(),
    [invoices],
  );
  const rows = status
    ? invoices.filter((i) => i.status === status)
    : invoices;

  return (
    <>
      <div className="row" style={{ alignItems: "center" }}>
        <h1>{t("invoices")}</h1>
        <p style={{ textAlign: "right" }}>
          <Link href="/invoices/new">
            <button type="button">{t("newInvoice")}</button>
          </Link>
        </p>
      </div>
      {error && <div className="err">{error}</div>}

      <div className="card">
        <DataTable
          rows={rows}
          csvName="invoices"
          searchKeys={["invoice_no", "customer_name"]}
          pageSizeDefault={25}
          toolbar={
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              style={{ width: "auto" }}
            >
              <option value="">{t("allStatuses")}</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          }
          empty={
            <div className="empty">
              <span className="empty-icon">🧾</span>
              <p>{t("noInvoices")}</p>
              <Link href="/invoices/new">
                <button type="button">{t("newInvoice")}</button>
              </Link>
            </div>
          }
          columns={[
            {
              key: "invoice_no",
              label: "No.",
              value: (i) => i.invoice_no ?? "",
              render: (i) => (
                <Link href={`/invoices/view?id=${i.id}`}>
                  {i.invoice_no ?? "draft"}
                </Link>
              ),
            },
            { key: "customer_name", label: t("customer") },
            {
              key: "issue_date",
              label: "Date",
              value: (i) => i.issue_date ?? "",
              render: (i) => (
                <span className="muted">
                  {i.issue_date?.slice(0, 10) ?? "—"}
                </span>
              ),
            },
            {
              key: "total_cents",
              label: t("total"),
              num: true,
              value: (i) => Number(i.total_cents),
              render: (i) => fmtKes(i.total_cents),
            },
            {
              key: "outstanding",
              label: "Outstanding",
              num: true,
              value: (i) =>
                i.status === "issued"
                  ? Number(i.total_cents) - Number(i.amount_paid_cents ?? 0)
                  : 0,
              render: (i) => {
                const out =
                  i.status === "issued"
                    ? Number(i.total_cents) - Number(i.amount_paid_cents ?? 0)
                    : 0;
                return out > 0 ? (
                  <strong>{fmtKes(out)}</strong>
                ) : (
                  <span className="muted">—</span>
                );
              },
            },
            {
              key: "status",
              label: t("status"),
              render: (i) => (
                <span className={`pill ${i.status}`}>{i.status}</span>
              ),
            },
            {
              key: "fiscal_status",
              label: "eTIMS",
              value: (i) => i.control_number ?? i.fiscal_status ?? "",
              render: (i) =>
                i.fiscal_status ? (
                  <span className={`pill ${i.fiscal_status}`}>
                    {i.fiscal_status === "signed"
                      ? (i.control_number ?? "signed")
                      : i.fiscal_status}
                  </span>
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
