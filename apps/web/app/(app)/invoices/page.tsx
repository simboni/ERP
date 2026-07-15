"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api, fmtKes } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

interface InvoiceRow {
  id: string;
  invoice_no: string | null;
  status: string;
  total_cents: string;
  amount_paid_cents?: string | null;
  customer_name: string;
  fiscal_status: string | null;
  control_number: string | null;
}

export default function InvoicesPage() {
  const { t } = useI18n();
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
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
  const filtered = invoices.filter(
    (i) =>
      (!status || i.status === status) &&
      (!q ||
        i.customer_name.toLowerCase().includes(q.toLowerCase()) ||
        (i.invoice_no ?? "").toLowerCase().includes(q.toLowerCase())),
  );

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

      <div className="row">
        <input
          placeholder={`${t("search")}…`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t("allStatuses")}</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <div className="card">
        {filtered.length === 0 ? (
          <p className="muted">{t("noInvoices")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>No.</th>
                <th>{t("customer")}</th>
                <th>{t("total")}</th>
                <th>{t("status")}</th>
                <th>eTIMS</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((i) => (
                <tr key={i.id}>
                  <td>
                    <Link href={`/invoices/view?id=${i.id}`}>
                      {i.invoice_no ?? "draft"}
                    </Link>
                  </td>
                  <td>{i.customer_name}</td>
                  <td>{fmtKes(i.total_cents)}</td>
                  <td>
                    <span className={`pill ${i.status}`}>{i.status}</span>
                  </td>
                  <td>
                    {i.fiscal_status ? (
                      <span className={`pill ${i.fiscal_status}`}>
                        {i.fiscal_status === "signed"
                          ? (i.control_number ?? "signed")
                          : i.fiscal_status}
                      </span>
                    ) : (
                      <span className="muted">—</span>
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
