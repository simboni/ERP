import {
  BadRequestException,
  Controller,
  HttpCode,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { TenantTokenClaims } from "@jenga/shared";
import {
  JwtAuthGuard,
  Roles,
  RolesGuard,
  TenantClaims,
  TenantContextGuard,
} from "../auth/guards";
import { DbService } from "../db/db.service";
import { InvoicesService } from "../invoicing/invoices.service";
import { QuotesService } from "../invoicing/quotes.service";
import { LedgerService } from "../ledger/ledger.service";
import { PaymentsService } from "../payments/payments.service";
import { BillsService } from "../purchases/bills.service";
import { PayrollService } from "../payroll/payroll.service";

/** Deterministic PRNG so demo data is stable run-to-run. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["Wanjiku", "Otieno", "Achieng", "Kamau", "Njeri", "Mutua", "Chebet", "Kipchoge", "Amina", "Baraka", "Zawadi", "Mwangi", "Akinyi", "Njoroge", "Wafula", "Moraa", "Kiptoo", "Nyambura", "Omondi", "Wairimu"];
const LAST = ["Traders", "Enterprises", "Supplies", "Hardware", "Distributors", "Agencies", "Ventures", "Holdings", "Stores", "Solutions", "Logistics", "Merchants", "& Sons", "Wholesalers", "Investments"];
const TOWNS = ["Nairobi", "Mombasa", "Kisumu", "Nakuru", "Eldoret", "Thika", "Machakos", "Nyeri", "Kitale", "Kakamega"];
const ITEM_NAMES = ["Maize flour 2kg", "Cooking oil 1L", "Sugar 1kg", "Rice 5kg", "Cement 50kg", "Iron sheets 3m", "Paint 4L", "LED bulb 9W", "Water tank 500L", "Office chair", "Printer paper A4", "Toner cartridge", "Milk 500ml crate", "Bread wholesale pack", "Tea leaves 250g", "Detergent 5kg", "Solar lamp", "Phone charger", "Padlock heavy duty", "Wheelbarrow", "Nails 1kg", "PVC pipe 3m", "Fertilizer 25kg", "Animal feed 70kg", "Gas cylinder 6kg refill", "Motor oil 5L", "Tyre 14-inch", "Battery 12V", "School uniform set", "Textbook bundle"];
const EXPENSE_MEMOS = ["Fuel for delivery van", "Office rent", "Electricity token", "Internet subscription", "Casual labour", "Vehicle service", "Stationery", "Security services", "County permit fees", "Airtime for staff", "Cleaning supplies", "Water bill", "Garbage collection", "Bank charges", "Marketing flyers"];
const EMPLOYEE_NAMES = ["Peter Simboni", "Grace Wanjiru", "John Ochieng", "Mary Adhiambo", "David Kiprop", "Faith Muthoni", "Samuel Barasa", "Esther Nekesa", "James Maina", "Lucy Atieno", "Daniel Kimutai", "Ruth Wambui", "Joseph Odhiambo", "Sarah Chepkoech", "Michael Ndungu"];

const day = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * One-click realistic demo dataset (~100 records per major module) so an
 * evaluating founder sees the platform as a running business, not empty
 * tables. Idempotent-ish: refuses to run twice on the same tenant.
 */
@Controller("tenants/current/demo-data")
@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)
export class DemoDataController {
  constructor(
    private readonly db: DbService,
    private readonly invoices: InvoicesService,
    private readonly quotes: QuotesService,
    private readonly bills: BillsService,
    private readonly payroll: PayrollService,
    private readonly payments: PaymentsService,
    private readonly ledger: LedgerService,
  ) {}

  @Post()
  @HttpCode(200)
  @Roles("owner", "admin")
  async seed(@TenantClaims() claims: TenantTokenClaims) {
    const rnd = mulberry32(42);
    const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
    const int = (min: number, max: number): number =>
      min + Math.floor(rnd() * (max - min + 1));
    const now = new Date();
    const daysAgo = (n: number): Date =>
      new Date(now.getTime() - n * 24 * 3600 * 1000);

    const counts = {
      customers: 0,
      items: 0,
      quotes: 0,
      invoices: 0,
      payments: 0,
      suppliers: 0,
      bills: 0,
      expenses: 0,
      employees: 0,
      payrollRuns: 0,
      stockMovements: 0,
    };

    // Guard: only on a tenant that hasn't been seeded.
    await this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const existing = await client.query(
        "SELECT count(*)::int AS n FROM customers",
      );
      if (existing.rows[0].n >= 50) {
        throw new BadRequestException(
          "Demo data appears to be loaded already (50+ customers exist).",
        );
      }
    });

    // 1. Branch (reuse or create), customers, items, employees, suppliers.
    const base = await this.db.withTenant(
      claims.tid,
      claims.sub,
      async (client) => {
        let branchId: string;
        const br = await client.query("SELECT id FROM branches LIMIT 1");
        if (br.rows[0]) {
          branchId = br.rows[0].id;
        } else {
          const created = await client.query(
            `INSERT INTO branches (tenant_id, code, name)
             VALUES ($1, '00', 'Head Office') RETURNING id`,
            [claims.tid],
          );
          branchId = created.rows[0].id;
        }

        const customerIds: string[] = [];
        for (let i = 0; i < 100; i++) {
          const name = `${pick(FIRST)} ${pick(LAST)} ${pick(TOWNS)}`;
          const res = await client.query(
            `INSERT INTO customers (tenant_id, name, phone, email)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [
              claims.tid,
              `${name.slice(0, 60)} #${i + 1}`,
              `+2547${int(10000000, 99999999)}`,
              `customer${i + 1}@demo.jenga.co.ke`,
            ],
          );
          customerIds.push(res.rows[0].id);
          counts.customers++;
        }

        const itemIds: { id: string; priceCents: number }[] = [];
        for (let i = 0; i < ITEM_NAMES.length; i++) {
          const price = int(150, 8000) * 100;
          const res = await client.query(
            `INSERT INTO items (tenant_id, sku, name, unit, cost_cents,
                                price_cents, vat_rate, track_stock)
             VALUES ($1, $2, $3, 'pcs', $4, $5, '0.16', true) RETURNING id`,
            [
              claims.tid,
              `SKU-${String(i + 1).padStart(3, "0")}`,
              ITEM_NAMES[i],
              Math.floor(price * 0.7),
              price,
            ],
          );
          itemIds.push({ id: res.rows[0].id, priceCents: price });
          counts.items++;
          // Opening stock.
          await client.query(
            `INSERT INTO stock_movements (tenant_id, item_id, branch_id,
                                          qty_delta, reason, created_by)
             VALUES ($1, $2, $3, $4, 'adjustment', $5)`,
            [claims.tid, res.rows[0].id, branchId, int(500, 2000), claims.sub],
          );
          counts.stockMovements++;
        }

        for (const name of EMPLOYEE_NAMES) {
          await client.query(
            `INSERT INTO employees (tenant_id, full_name, kra_pin, msisdn,
                                    gross_cents)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              claims.tid,
              name,
              `A${int(100000000, 999999999)}Z`,
              `+2547${int(10000000, 99999999)}`,
              int(25000, 250000) * 100,
            ],
          );
          counts.employees++;
        }

        const supplierIds: string[] = [];
        for (let i = 0; i < 20; i++) {
          const res = await client.query(
            `INSERT INTO suppliers (tenant_id, name, phone, email)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [
              claims.tid,
              `${pick(TOWNS)} ${pick(LAST)} Ltd #${i + 1}`,
              `+2547${int(10000000, 99999999)}`,
              `supplier${i + 1}@demo.jenga.co.ke`,
            ],
          );
          supplierIds.push(res.rows[0].id);
          counts.suppliers++;
        }
        return { branchId, customerIds, itemIds, supplierIds };
      },
    );

    // 2. Invoices: 100 spread over ~6 months; most issued, some drafts.
    // Each record is its own transaction: one failure (e.g. a stock guard)
    // skips that record, never the batch.
    const issued: { id: string; invoiceNo: number; totalCents: number }[] = [];
    for (let i = 0; i < 100; i++) {
      try {
        await this.db.withTenant(claims.tid, claims.sub, async (client) => {
          const ageDays = int(0, 175);
          const lines = Array.from({ length: int(1, 4) }, () => {
            const item = pick(base.itemIds);
            return {
              description: "",
              quantity: int(1, 5),
              unitPriceCents: item.priceCents,
              vatRate: "0.16" as const,
              itemId:
                base.itemIds.indexOf(item) % 3 === 0 ? undefined : item.id,
            };
          });
          const draft = await this.invoices.createDraft(client, {
            tenantId: claims.tid,
            userId: claims.sub,
            branchId: base.branchId,
            customerId: pick(base.customerIds),
            dueDate: day(daysAgo(ageDays - int(14, 30))),
            lines,
          });
          counts.invoices++;
          if (i % 10 !== 9) {
            const res = await this.invoices.issue(client, {
              tenantId: claims.tid,
              userId: claims.sub,
              invoiceId: draft.id,
              issueDate: day(daysAgo(ageDays)),
            });
            issued.push({
              id: draft.id,
              invoiceNo: res.invoiceNo,
              totalCents: res.totalCents,
            });
          }
        });
      } catch {
        // skip this record; keep seeding
      }
    }

    // 3. Payments: ~60% of issued invoices paid via demo M-Pesa receipts.
    for (let i = 0; i < issued.length; i++) {
      if (rnd() > 0.6) continue;
      const inv = issued[i];
      try {
      await this.db.withTenant(claims.tid, claims.sub, async (client) => {
        const partial = rnd() < 0.15;
        const amount = partial
          ? Math.max(100, Math.floor(inv.totalCents / 2))
          : inv.totalCents;
        const res = await client.query(
          `INSERT INTO payments (tenant_id, rail, state, amount_cents, msisdn,
                                 account_ref, receipt_number, confirmed_at)
           VALUES ($1, 'mpesa_c2b', 'confirmed', $2, $3, $4, $5, now())
           RETURNING id`,
          [
            claims.tid,
            amount,
            `+2547${int(10000000, 99999999)}`,
            String(inv.invoiceNo),
            `DEMO${String(i + 1).padStart(6, "0")}`,
          ],
        );
        await this.payments.reconcile(client, claims.tid, res.rows[0].id);
        counts.payments++;
      });
      } catch {
        // skip this record; keep seeding
      }
    }

    // 4. Quotes: 40, in a healthy status mix.
    for (let i = 0; i < 40; i++) {
      try {
      await this.db.withTenant(claims.tid, claims.sub, async (client) => {
        const item = pick(base.itemIds);
        const q = await this.quotes.createDraft(client, {
          tenantId: claims.tid,
          userId: claims.sub,
          branchId: base.branchId,
          customerId: pick(base.customerIds),
          validUntil: day(new Date(now.getTime() + int(7, 45) * 86400000)),
          lines: [
            {
              description: "",
              quantity: int(1, 8),
              unitPriceCents: item.priceCents,
              vatRate: "0.16" as const,
              itemId: item.id,
            },
          ],
        });
        const status = pick(["draft", "sent", "sent", "accepted", "expired"]);
        if (status !== "draft") {
          await client.query("UPDATE quotes SET status = $1 WHERE id = $2", [
            status,
            q.id,
          ]);
        }
        counts.quotes++;
      });
      } catch {
        // skip this record; keep seeding
      }
    }

    // 5. Bills: 60 across suppliers; approve most, pay some.
    for (let i = 0; i < 60; i++) {
      try {
      await this.db.withTenant(claims.tid, claims.sub, async (client) => {
        const ageDays = int(0, 175);
        const bill = await this.bills.createDraft(client, {
          tenantId: claims.tid,
          userId: claims.sub,
          supplierId: pick(base.supplierIds),
          billDate: day(daysAgo(ageDays)),
          dueDate: day(daysAgo(ageDays - 30)),
          supplierInvoiceNo: `SUP-${int(1000, 9999)}`,
          etimsControlNumber:
            rnd() < 0.8 ? `010${int(10000000, 99999999)}` : undefined,
          lines: [
            {
              description: pick(ITEM_NAMES),
              quantity: int(1, 20),
              unitPriceCents: int(100, 5000) * 100,
              vatRate: "0.16" as const,
              accountCode: pick(["6000", "6000", "6100"]),
            },
          ],
        });
        counts.bills++;
        if (i % 5 !== 4) {
          await this.bills.approve(client, {
            tenantId: claims.tid,
            userId: claims.sub,
            billId: bill.id,
          });
        }
      });
      } catch {
        // skip this record; keep seeding
      }
    }

    // 6. Expenses: 60 petty-cash entries over 6 months.
    for (let i = 0; i < 60; i++) {
      await this.db.withTenant(claims.tid, claims.sub, async (client) => {
        const amount = int(200, 25000) * 100;
        await this.ledger.post(client, {
          tenantId: claims.tid,
          postedBy: claims.sub,
          entryDate: day(daysAgo(int(0, 175))),
          memo: pick(EXPENSE_MEMOS),
          sourceType: "expense",
          idempotencyKey: `demo-expense:${claims.tid}:${i}`,
          lines: [
            { accountCode: "6000", debitCents: amount },
            {
              accountCode: pick(["1000", "1010", "1020"]),
              creditCents: amount,
            },
          ],
        });
        counts.expenses++;
      });
    }

    // 7. Payroll: one committed run for last month.
    try {
    await this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
      const period = lastMonth.toISOString().slice(0, 7);
      const run = await this.payroll.draftRun(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        period,
      });
      await this.payroll.commit(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        runId: run.runId,
      });
      counts.payrollRuns++;
    });
    } catch {
      // payroll seeding is best-effort
    }

    return { seeded: true, counts };
  }
}
