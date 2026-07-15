import { BadRequestException, Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";

export interface PostingLine {
  accountCode: string;
  debitCents?: number;
  creditCents?: number;
  memo?: string;
}

export interface PostingInput {
  tenantId: string;
  postedBy: string | null;
  entryDate: string; // YYYY-MM-DD
  memo: string;
  sourceType: string;
  sourceId?: string;
  idempotencyKey: string;
  lines: PostingLine[];
}

/**
 * The single posting path (04-architecture.md §4): every subledger document
 * becomes a journal entry through post(), inside the caller's tenant
 * transaction. Balance is checked here AND by the deferred DB constraint
 * trigger — the database is the last line of defence, this code is the
 * first. Entries are immutable; corrections are reversing entries.
 */
@Injectable()
export class LedgerService {
  async post(
    client: PoolClient,
    input: PostingInput,
  ): Promise<{ entryId: string; entryNo: number; deduplicated: boolean }> {
    const debits = input.lines.reduce((s, l) => s + (l.debitCents ?? 0), 0);
    const credits = input.lines.reduce((s, l) => s + (l.creditCents ?? 0), 0);
    if (debits !== credits || debits === 0) {
      throw new BadRequestException(
        `Unbalanced posting: debits ${debits} != credits ${credits}`,
      );
    }
    for (const l of input.lines) {
      const d = l.debitCents ?? 0;
      const c = l.creditCents ?? 0;
      if (!Number.isInteger(d) || !Number.isInteger(c) || d < 0 || c < 0) {
        throw new BadRequestException("Line amounts must be non-negative integers");
      }
      if ((d > 0) === (c > 0)) {
        throw new BadRequestException(
          "Each line must have exactly one of debit or credit",
        );
      }
    }

    // Idempotency: same key returns the existing entry untouched.
    const existing = await client.query(
      `SELECT id, entry_no FROM journal_entries
       WHERE tenant_id = $1 AND idempotency_key = $2`,
      [input.tenantId, input.idempotencyKey],
    );
    if (existing.rows[0]) {
      return {
        entryId: existing.rows[0].id,
        entryNo: Number(existing.rows[0].entry_no),
        deduplicated: true,
      };
    }

    // Resolve account codes -> ids (RLS scopes to this tenant).
    const codes = [...new Set(input.lines.map((l) => l.accountCode))];
    const accountsRes = await client.query(
      `SELECT id, code FROM accounts WHERE code = ANY($1)`,
      [codes],
    );
    const byCode = new Map<string, string>(
      accountsRes.rows.map((r: { code: string; id: string }) => [r.code, r.id]),
    );
    for (const code of codes) {
      if (!byCode.has(code)) {
        throw new BadRequestException(`Unknown account code: ${code}`);
      }
    }

    // Per-tenant monotonic entry number.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('journal:' || $1))",
      [input.tenantId],
    );
    const nextNoRes = await client.query(
      `SELECT coalesce(max(entry_no), 0) + 1 AS next
       FROM journal_entries WHERE tenant_id = $1`,
      [input.tenantId],
    );
    const entryNo = Number(nextNoRes.rows[0].next);

    const entryRes = await client.query(
      `INSERT INTO journal_entries
         (tenant_id, entry_no, entry_date, memo, source_type, source_id,
          idempotency_key, posted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        input.tenantId,
        entryNo,
        input.entryDate,
        input.memo,
        input.sourceType,
        input.sourceId ?? null,
        input.idempotencyKey,
        input.postedBy,
      ],
    );
    const entryId: string = entryRes.rows[0].id;

    for (const line of input.lines) {
      await client.query(
        `INSERT INTO journal_lines
           (tenant_id, entry_id, account_id, debit_cents, credit_cents, line_memo)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          input.tenantId,
          entryId,
          byCode.get(line.accountCode),
          line.debitCents ?? 0,
          line.creditCents ?? 0,
          line.memo ?? "",
        ],
      );
    }
    return { entryId, entryNo, deduplicated: false };
  }

  /** Trial balance per account as of now (reporting read; RLS-scoped). */
  async trialBalance(client: PoolClient): Promise<
    { code: string; name: string; type: string; balanceCents: number }[]
  > {
    const res = await client.query(
      `SELECT a.code, a.name, a.type,
              coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint AS balance
       FROM accounts a
       LEFT JOIN journal_lines jl ON jl.account_id = a.id
       GROUP BY a.id ORDER BY a.code`,
    );
    return res.rows.map(
      (r: { code: string; name: string; type: string; balance: string }) => ({
        code: r.code,
        name: r.name,
        type: r.type,
        balanceCents: Number(r.balance),
      }),
    );
  }
}

/**
 * Kenyan SME default chart of accounts (03-product-vision.md M4).
 * System accounts are the ones auto-posting depends on.
 */
export const DEFAULT_ACCOUNTS: {
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
  system?: boolean;
}[] = [
  { code: "1000", name: "Cash on Hand", type: "asset", system: true },
  { code: "1010", name: "M-Pesa", type: "asset", system: true },
  { code: "1020", name: "Bank Account", type: "asset" },
  { code: "1100", name: "Accounts Receivable", type: "asset", system: true },
  { code: "1200", name: "Inventory", type: "asset" },
  { code: "1300", name: "Input VAT Receivable", type: "asset", system: true },
  // Contra-asset: carries a credit balance (monthly depreciation credits).
  { code: "1500", name: "Accumulated Depreciation", type: "asset", system: true },
  { code: "2100", name: "Accounts Payable", type: "liability", system: true },
  { code: "2200", name: "VAT Payable", type: "liability", system: true },
  { code: "2300", name: "Statutory Payables", type: "liability", system: true },
  { code: "2310", name: "Wages Payable", type: "liability", system: true },
  { code: "3000", name: "Owner's Equity", type: "equity" },
  { code: "4000", name: "Sales Revenue", type: "income", system: true },
  { code: "5000", name: "Cost of Goods Sold", type: "expense" },
  { code: "6000", name: "Operating Expenses", type: "expense" },
  { code: "6100", name: "Salaries & Wages", type: "expense", system: true },
  { code: "6200", name: "Depreciation Expense", type: "expense", system: true },
];

export async function seedDefaultAccounts(
  client: PoolClient,
  tenantId: string,
): Promise<number> {
  let created = 0;
  for (const a of DEFAULT_ACCOUNTS) {
    const res = await client.query(
      `INSERT INTO accounts (tenant_id, code, name, type, is_system)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, code) DO NOTHING`,
      [tenantId, a.code, a.name, a.type, a.system ?? false],
    );
    created += res.rowCount ?? 0;
  }
  return created;
}
