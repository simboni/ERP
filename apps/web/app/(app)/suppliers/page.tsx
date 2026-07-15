"use client";

import { useEffect, useState } from "react";
import { api, fmtKes } from "@/lib/api";
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
  const [q, setQ] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api<SupplierRow[]>("/tenants/current/suppliers/overview")
      .then(setRows)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load"),
      );
  }, []);

  const filtered = rows.filter(
    (s) => !q || s.name.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <>
      <h1>{t("navSuppliers")}</h1>
      {error && <div className="err">{error}</div>}
      <input
        placeholder={`${t("search")}…`}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        style={{ maxWidth: 320 }}
      />
      <div className="card">
        {filtered.length === 0 ? (
          <p className="muted">
            No suppliers yet — they are created with your first bill on the
            Purchases page.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Supplier</th>
                <th>Contact</th>
                <th>Bills</th>
                <th>Billed</th>
                <th>Unpaid</th>
                <th>Last bill</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td className="muted">{s.phone ?? s.email ?? "—"}</td>
                  <td>{s.bill_count}</td>
                  <td>{fmtKes(s.billed_cents)}</td>
                  <td>
                    {Number(s.unpaid_cents) > 0 ? (
                      <strong>{fmtKes(s.unpaid_cents)}</strong>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="muted">{s.last_bill_date?.slice(0, 10) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
