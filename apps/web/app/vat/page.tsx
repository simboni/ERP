"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, fmtKes, getTenantToken } from "@/lib/api";

interface VatReturn {
  period: string;
  salesVatable16Cents: number;
  salesZeroRatedCents: number;
  salesExemptCents: number;
  outputVatCents: number;
  inputVatCents: number;
  netVatCents: number;
  invoicesTotal: number;
  invoicesFiscalized: number;
  billsMissingEtims: number;
}

export default function VatPage() {
  const router = useRouter();
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [draft, setDraft] = useState<VatReturn | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async (p: string): Promise<void> => {
    setError("");
    try {
      const d = await api<VatReturn>(
        `/tenants/current/compliance/vat-return?period=${p}`,
      );
      setDraft(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }, []);

  useEffect(() => {
    if (!getTenantToken()) {
      router.replace("/");
      return;
    }
    void load(period);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <p>
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1>VAT return (VAT3 draft)</h1>
      <div className="card">
        <div className="row">
          <div>
            <label>Period</label>
            <input
              type="month"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
            />
          </div>
        </div>
        <button onClick={() => void load(period)}>Prepare draft</button>
        {error && <div className="err">{error}</div>}
      </div>

      {draft && (
        <div className="card">
          <h2>Period {draft.period}</h2>
          <table>
            <tbody>
              <tr><td>Vatable sales (16%)</td><td>{fmtKes(draft.salesVatable16Cents)}</td></tr>
              <tr><td>Zero-rated sales</td><td>{fmtKes(draft.salesZeroRatedCents)}</td></tr>
              <tr><td>Exempt sales</td><td>{fmtKes(draft.salesExemptCents)}</td></tr>
              <tr><td><strong>Output VAT</strong></td><td><strong>{fmtKes(draft.outputVatCents)}</strong></td></tr>
              <tr><td>Input VAT (eTIMS-backed bills)</td><td>{fmtKes(draft.inputVatCents)}</td></tr>
              <tr>
                <td><strong>{draft.netVatCents >= 0 ? "VAT payable to KRA" : "VAT credit carried"}</strong></td>
                <td><strong>{fmtKes(Math.abs(draft.netVatCents))}</strong></td>
              </tr>
            </tbody>
          </table>
          <p className="muted">
            {draft.invoicesFiscalized}/{draft.invoicesTotal} sales invoices
            fiscalized with eTIMS.
          </p>
          {draft.billsMissingEtims > 0 && (
            <p className="err">
              ⚠ {draft.billsMissingEtims} approved bill(s) have no eTIMS control
              number — those expenses are not tax-deductible and their VAT is
              excluded from the input claim.
            </p>
          )}
        </div>
      )}
    </>
  );
}
