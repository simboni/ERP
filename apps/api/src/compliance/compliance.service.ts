import { BadRequestException, Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface VatReturnDraft {
  period: string;
  salesVatable16Cents: number;
  salesZeroRatedCents: number;
  salesExemptCents: number;
  outputVatCents: number;
  inputVatCents: number;
  /** Output minus input; positive = payable to KRA. */
  netVatCents: number;
  invoicesTotal: number;
  invoicesFiscalized: number;
  /** Approved bills without an eTIMS control number: expense not deductible (s.23A). */
  billsMissingEtims: number;
  generatedAt: string;
}

export interface Deadline {
  key: string;
  label: string;
  dueDate: string; // ISO date
  daysRemaining: number;
  overdue: boolean;
}

/** Add n working days (Mon-Fri) to the first day of the month after period. */
function addWorkingDays(startExclusive: Date, days: number): Date {
  const d = new Date(startExclusive);
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d;
}

/**
 * Compliance surface (differentiator D1): VAT3 preparation from the books
 * and the statutory deadline feed. Deadline rules per the verified July
 * 2026 baseline (02-kenya-compliance.md §2.6): PAYE/unified return, NSSF,
 * SHIF and VAT3 by the 9th/20th of the following month; housing levy
 * within 9 WORKING days after month end.
 */
@Injectable()
export class ComplianceService {
  async vatReturnDraft(
    client: PoolClient,
    period: string,
  ): Promise<VatReturnDraft> {
    if (!PERIOD_RE.test(period)) {
      throw new BadRequestException("period must be YYYY-MM");
    }
    const res = await client.query(
      `SELECT il.vat_rate,
              coalesce(sum(il.line_total_cents), 0)::bigint AS sales,
              coalesce(sum(il.vat_cents), 0)::bigint AS vat
       FROM invoice_lines il
       JOIN invoices i ON i.id = il.invoice_id
       WHERE i.status IN ('issued', 'paid')
         AND to_char(i.issue_date, 'YYYY-MM') = $1
       GROUP BY il.vat_rate`,
      [period],
    );
    const byRate = new Map<string, { sales: number; vat: number }>(
      res.rows.map((r: { vat_rate: string; sales: string; vat: string }) => [
        r.vat_rate,
        { sales: Number(r.sales), vat: Number(r.vat) },
      ]),
    );
    const fiscal = await client.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE f.status = 'signed')::int AS signed
       FROM invoices i
       LEFT JOIN fiscal_documents f ON f.id = i.fiscal_document_id
       WHERE i.status IN ('issued', 'paid')
         AND to_char(i.issue_date, 'YYYY-MM') = $1`,
      [period],
    );
    // Input VAT: only bills backed by an eTIMS control number qualify for
    // the claim (s.23A + the Jan-2026 return-validation engine).
    const purchases = await client.query(
      `SELECT
         coalesce(sum(vat_cents) FILTER (WHERE etims_control_number IS NOT NULL), 0)::bigint AS input_vat,
         count(*) FILTER (WHERE etims_control_number IS NULL)::int AS missing_etims
       FROM bills
       WHERE status IN ('approved', 'paid')
         AND to_char(bill_date, 'YYYY-MM') = $1`,
      [period],
    );
    const outputVat = byRate.get("0.16")?.vat ?? 0;
    const inputVat = Number(purchases.rows[0].input_vat);
    return {
      period,
      salesVatable16Cents: byRate.get("0.16")?.sales ?? 0,
      salesZeroRatedCents: byRate.get("0")?.sales ?? 0,
      salesExemptCents: byRate.get("exempt")?.sales ?? 0,
      outputVatCents: outputVat,
      inputVatCents: inputVat,
      netVatCents: outputVat - inputVat,
      invoicesTotal: fiscal.rows[0].total,
      invoicesFiscalized: fiscal.rows[0].signed,
      billsMissingEtims: purchases.rows[0].missing_etims,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Deadlines for the filing month following `asOf`'s period. */
  deadlines(asOf: Date): Deadline[] {
    const y = asOf.getUTCFullYear();
    const m = asOf.getUTCMonth(); // period = the month containing asOf... filings due next month
    const periodLabel = `${y}-${String(m + 1).padStart(2, "0")}`;
    const monthEnd = new Date(Date.UTC(y, m + 1, 0));
    const nextMonth9th = new Date(Date.UTC(y, m + 1, 9));
    const nextMonth20th = new Date(Date.UTC(y, m + 1, 20));
    const ahlDue = addWorkingDays(monthEnd, 9);

    const mk = (key: string, label: string, due: Date): Deadline => {
      const days = Math.ceil(
        (due.getTime() - asOf.getTime()) / (24 * 3600 * 1000),
      );
      return {
        key,
        label: `${label} (${periodLabel})`,
        dueDate: due.toISOString().slice(0, 10),
        daysRemaining: days,
        overdue: days < 0,
      };
    };
    return [
      mk("paye", "PAYE + housing levy + NITA unified payroll return", nextMonth9th),
      mk("nssf", "NSSF contributions", nextMonth9th),
      mk("shif", "SHIF contributions", nextMonth9th),
      mk("ahl_remit", "Affordable Housing Levy remittance (9 working days)", ahlDue),
      mk("vat3", "VAT3 return & payment", nextMonth20th),
    ].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  }
}
