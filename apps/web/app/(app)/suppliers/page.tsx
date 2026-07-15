"use client";

import { useEffect, useState } from "react";
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

export default function SuppliersPage() {
  const { t } = useI18n();
  const [rows, setRows] = useState<SupplierRow[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api<SupplierRow[]>("/tenants/current/suppliers/overview")
      .then(setRows)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load"),
      );
  }, []);

  return (
    <>
      <h1>{t("navSuppliers")}</h1>
      {error && <div className="err">{error}</div>}
      <div className="card">
        <DataTable
          rows={rows}
          csvName="suppliers"
          searchKeys={["name", "phone", "email"]}
          pageSizeDefault={10}
          empty={
            <div className="empty">
              <span className="empty-icon">🚚</span>
              <p>
                No suppliers yet — they are created with your first bill on
                the Purchases page.
              </p>
            </div>
          }
          columns={[
            { key: "name", label: "Supplier" },
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
            {
              key: "last_bill_date",
              label: "Last bill",
              value: (s) => s.last_bill_date?.slice(0, 10) ?? "",
              render: (s) => (
                <span className="muted">
                  {s.last_bill_date?.slice(0, 10) ?? "—"}
                </span>
              ),
            },
          ]}
        />
      </div>
    </>
  );
}
