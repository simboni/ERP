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
import { LedgerService, seedDefaultAccounts } from "../ledger/ledger.service";
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
      projects: 0,
      tasks: 0,
      folders: 0,
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
      // The seeder posts expenses, bills and payroll to the ledger, so the
      // chart of accounts must exist first — otherwise the first posting
      // fails with "Unknown account code".
      await seedDefaultAccounts(client, claims.tid);
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

    // 8. Business profile: fill the tenant's own details so invoices,
    // quotes and receipts print a complete letterhead out of the box.
    try {
      await this.db.withTenant(claims.tid, claims.sub, async (client) => {
        await client.query(
          `UPDATE tenants SET
             legal_name       = coalesce(legal_name, name),
             kra_pin          = coalesce(kra_pin, $2),
             vat_number       = coalesce(vat_number, $3),
             phone            = coalesce(phone, $4),
             email            = coalesce(email, $5),
             physical_address = coalesce(physical_address, $6),
             postal_address   = coalesce(postal_address, $7),
             invoice_footer   = coalesce(invoice_footer, $8)
           WHERE id = $1`,
          [
            claims.tid,
            `P05${int(1000000, 9999999)}Q`,
            `0${int(100000, 999999)}X`,
            `+2547${int(10000000, 99999999)}`,
            "accounts@demo.jenga.co.ke",
            `${pick(TOWNS)} Business Park, Nairobi`,
            `P.O. Box ${int(100, 99999)}-00100, Nairobi`,
            "Thank you for your business — asante kwa biashara.",
          ],
        );
      });
    } catch {
      // profile seeding is best-effort (columns may predate a deploy)
    }

    // 9. Projects: a few live jobs with tasks across the board, a
    // milestone and logged time — so the PM module opens populated.
    try {
      await this.db.withTenant(claims.tid, claims.sub, async (client) => {
        const emps = await client.query(
          "SELECT id FROM employees ORDER BY created_at LIMIT 6",
        );
        const empIds: string[] = emps.rows.map((r) => r.id);
        const projNames = [
          "Office fit-out — Westlands",
          "POS rollout — 4 branches",
          "Annual audit support",
          "Website & branding refresh",
        ];
        const taskTitles = [
          "Site survey and measurements",
          "Prepare BoQ and quote",
          "Client sign-off",
          "Procure materials",
          "Installation week 1",
          "Snag list and handover",
        ];
        const statuses = ["done", "done", "in_progress", "todo", "todo", "blocked"];
        const prios = ["high", "medium", "medium", "low", "high", "medium"];
        for (let p = 0; p < projNames.length; p++) {
          const proj = await client.query(
            `INSERT INTO projects
               (tenant_id, customer_id, name, status, budget_cents,
                hourly_rate_cents, description, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [
              claims.tid,
              base.customerIds[p] ?? null,
              projNames[p],
              p === 2 ? "completed" : "active",
              int(2000, 20000) * 100 * 10,
              int(1500, 4000) * 100,
              "Seeded sample project for demonstration.",
              claims.sub,
            ],
          );
          const projId = proj.rows[0].id;
          counts.projects++;
          for (let t = 0; t < taskTitles.length; t++) {
            const st = statuses[t];
            await client.query(
              `INSERT INTO project_tasks
                 (tenant_id, project_id, title, status, priority,
                  assignee_employee_id, due_date, estimate_hours, sort_order,
                  created_by, completed_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
              [
                claims.tid,
                projId,
                taskTitles[t],
                st,
                prios[t],
                empIds[t % Math.max(1, empIds.length)] ?? null,
                daysAgo(int(-20, 20)).toISOString().slice(0, 10),
                int(2, 16),
                t,
                claims.sub,
                st === "done" ? daysAgo(int(1, 20)).toISOString() : null,
              ],
            );
            counts.tasks++;
          }
          await client.query(
            `INSERT INTO project_milestones
               (tenant_id, project_id, name, due_date, status, reached_at,
                created_by)
             VALUES ($1,$2,'Phase 1 delivered',$3,$4,$5,$6)`,
            [
              claims.tid,
              projId,
              daysAgo(int(-30, -5)).toISOString().slice(0, 10),
              p < 2 ? "reached" : "open",
              p < 2 ? daysAgo(int(1, 10)).toISOString() : null,
              claims.sub,
            ],
          );
          if (empIds[0]) {
            await client.query(
              `INSERT INTO project_time_entries
                 (tenant_id, project_id, employee_id, entry_date, hours,
                  note, billable, created_by)
               VALUES ($1,$2,$3,$4,$5,'On-site work',true,$6)`,
              [
                claims.tid,
                projId,
                empIds[0],
                daysAgo(int(1, 20)).toISOString().slice(0, 10),
                int(3, 8),
                claims.sub,
              ],
            );
          }
        }
      });
    } catch {
      // projects seeding is best-effort (tables may predate a deploy)
    }

    // 10. Document folders: a starter filing structure so the DMS opens
    // with a tree rather than an empty root.
    try {
      await this.db.withTenant(claims.tid, claims.sub, async (client) => {
        for (const name of [
          "Contracts",
          "Licenses & permits",
          "Receipts",
          "Statutory filings",
          "Staff records",
        ]) {
          await client.query(
            `INSERT INTO document_folders (tenant_id, name, created_by)
             VALUES ($1, $2, $3)`,
            [claims.tid, name, claims.sub],
          );
          counts.folders++;
        }
      });
    } catch {
      // folders seeding is best-effort
    }

    return { seeded: true, counts };
  }

  /**
   * HR + CRM sample data for a workspace that already has employees
   * (e.g. one seeded before those modules existed). Guarded the same way:
   * refuses if departments already exist.
   */
  @Post("hr-crm")
  @HttpCode(200)
  @Roles("owner", "admin")
  async seedHrCrm(@TenantClaims() claims: TenantTokenClaims) {
    const rnd = mulberry32(7);
    const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
    const int = (min: number, max: number): number =>
      min + Math.floor(rnd() * (max - min + 1));
    const iso = (offsetDays: number): string =>
      new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const guard = await client.query(
        "SELECT count(*)::int AS n FROM departments",
      );
      if (guard.rows[0].n >= 3) {
        throw new BadRequestException(
          "HR/CRM demo data appears to be loaded already.",
        );
      }

      // Departments + assignments + designations.
      const DEPTS = ["Sales", "Operations", "Finance", "Logistics", "Administration"];
      const TITLES = ["Manager", "Supervisor", "Officer", "Assistant", "Clerk"];
      const deptIds: string[] = [];
      for (const name of DEPTS) {
        const r = await client.query(
          `INSERT INTO departments (tenant_id, name) VALUES ($1, $2)
           ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [claims.tid, name],
        );
        deptIds.push(r.rows[0].id);
      }
      const emps = await client.query(
        "SELECT id FROM employees WHERE status = 'active' ORDER BY created_at",
      );
      for (let i = 0; i < emps.rows.length; i++) {
        await client.query(
          `UPDATE employees SET department_id = $2, designation = $3,
                                hired_on = $4
           WHERE id = $1`,
          [
            emps.rows[i].id,
            deptIds[i % deptIds.length],
            TITLES[i % TITLES.length],
            iso(-int(60, 900)),
          ],
        );
      }

      // Leave policies + a believable mix of requests.
      const policies: string[] = [];
      for (const [name, days] of [
        ["Annual leave", 21],
        ["Sick leave", 14],
        ["Maternity leave", 90],
      ] as const) {
        const r = await client.query(
          `INSERT INTO leave_policies (tenant_id, name, days_per_year)
           VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [claims.tid, name, days],
        );
        policies.push(r.rows[0].id);
      }
      let leaveRequests = 0;
      const mkLeave = async (
        empIdx: number,
        startOff: number,
        len: number,
        status: string,
      ): Promise<void> => {
        const emp = emps.rows[empIdx % emps.rows.length];
        if (!emp) return;
        await client.query(
          `INSERT INTO leave_requests
             (tenant_id, employee_id, policy_id, start_date, end_date, days,
              reason, status, decided_by, decided_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                   CASE WHEN $8 = 'pending' THEN NULL ELSE $9::uuid END,
                   CASE WHEN $8 = 'pending' THEN NULL ELSE now() END)`,
          [
            claims.tid,
            emp.id,
            pick(policies),
            iso(startOff),
            iso(startOff + len - 1),
            Math.max(1, Math.round(len * 5 / 7)),
            pick(["Family", "Travel upcountry", "Medical", "Personal", ""]),
            status,
            claims.sub,
          ],
        );
        leaveRequests++;
      };
      await mkLeave(0, -2, 7, "approved"); // out right now
      await mkLeave(1, 0, 3, "approved"); // out right now
      await mkLeave(2, 7, 5, "pending");
      await mkLeave(3, 14, 10, "pending");
      await mkLeave(4, -40, 5, "approved");
      await mkLeave(5, -20, 3, "rejected");

      for (const [title, body] of [
        ["Eid holiday", "Office closed on Friday for Eid — plan deliveries accordingly."],
        ["New M-Pesa till", "We have moved to till 894321. Update your customers."],
        ["Quarterly stock take", "Stock take on the 28th. Inventory freezes at 4pm."],
      ]) {
        await client.query(
          `INSERT INTO announcements (tenant_id, title, body, created_by)
           VALUES ($1, $2, $3, $4)`,
          [claims.tid, title, body, claims.sub],
        );
      }

      // CRM: contacts across stages, deals across the pipeline, follow-ups.
      const COMPANIES = ["Tembo Hotels", "Simba Hardware", "Pwani Fresh", "Milele Schools", "Jua Kali Works", "Safari Tours KE", "Nyota Pharmacy", "Ushindi Sacco", "Green Farms", "Bora Electronics", "Malaika Salon", "Kilifi Builders"];
      const PEOPLE = ["Alice Wambui", "Brian Otieno", "Cynthia Njoki", "Dennis Mwangi", "Eva Chebet", "Felix Omondi", "Grace Akinyi", "Hassan Ali", "Irene Wanjala", "James Kariuki", "Khadija Noor", "Luke Kiprono"];
      const contactIds: string[] = [];
      for (let i = 0; i < 12; i++) {
        const stage = i < 5 ? "lead" : i < 9 ? "opportunity" : "customer";
        const r = await client.query(
          `INSERT INTO crm_contacts (tenant_id, name, company, phone, email,
                                     stage, source, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [
            claims.tid,
            PEOPLE[i],
            COMPANIES[i],
            `+2547${int(10000000, 99999999)}`,
            `${PEOPLE[i].split(" ")[0].toLowerCase()}@${COMPANIES[i].split(" ")[0].toLowerCase()}.co.ke`,
            stage,
            pick(["Referral", "Walk-in", "WhatsApp", "Exhibition", "Website"]),
            claims.sub,
          ],
        );
        contactIds.push(r.rows[0].id);
      }
      const DEAL_TITLES = ["Office supplies contract", "Quarterly restock", "Fit-out project", "Uniform order", "Annual maintenance", "Bulk cement supply", "POS rollout", "Catering supplies", "Solar installation", "Fleet servicing"];
      const stages = ["new", "new", "qualified", "qualified", "proposal", "proposal", "won", "won", "lost", "new"];
      let dealCount = 0;
      for (let i = 0; i < 10; i++) {
        await client.query(
          `INSERT INTO deals (tenant_id, contact_id, title, value_cents,
                              stage, expected_close, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            claims.tid,
            contactIds[i % contactIds.length],
            DEAL_TITLES[i],
            int(30, 900) * 100000,
            stages[i],
            iso(int(5, 60)),
            claims.sub,
          ],
        );
        dealCount++;
      }
      let activityCount = 0;
      for (let i = 0; i < 10; i++) {
        await client.query(
          `INSERT INTO crm_activities (tenant_id, contact_id, kind, body,
                                       due_date, done, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            claims.tid,
            contactIds[i],
            pick(["call", "meeting", "task", "note"]),
            pick([
              "Called about pricing — send quote",
              "Meeting at their office, bring samples",
              "Follow up on delivery schedule",
              "Asked for eTIMS invoice sample",
              "Negotiating payment terms",
            ]),
            i < 6 ? iso(int(0, 7)) : null,
            i >= 8,
            claims.sub,
          ],
        );
        activityCount++;
      }

      return {
        seeded: true,
        counts: {
          departments: DEPTS.length,
          employeesAssigned: emps.rows.length,
          leavePolicies: 3,
          leaveRequests,
          announcements: 3,
          crmContacts: contactIds.length,
          deals: dealCount,
          activities: activityCount,
        },
      };
    });
  }
}
