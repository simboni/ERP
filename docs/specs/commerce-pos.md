# POS "Sell" Screen — Implementation Spec (Jenga ERP)

**Verdict on data model: no new tables and no migration are needed.** Everything required already exists:
- `payments.rail` CHECK already permits `'cash'` (`db/migrations/0004_payments.sql:41`), and `state='confirmed'` fits cash.
- Account `1000 Cash on Hand` is already in `DEFAULT_ACCOUNTS` (`apps/api/src/ledger/ledger.service.ts:165`).
- `invoice_lines.item_id` + `InvoicesService.issue()` already decrement stock and post COGS atomically.
- Fiscalization, receipt SMS, partial-payment reconciliation all ride the existing invoice/payment paths.

Changed-line budget (target ≤ 800): API ~260, web ~420, CSS ~70, i18n/nav ~45 → ~795.

---

## 1) Migration SQL

**None.** Create no `0017_*.sql`. If your process requires a numbered placeholder, do **not** add one — the module rule is "no new tables if avoidable" and it is avoidable. Verification queries a reviewer can run:

```sql
-- rail 'cash' already allowed:
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = 'payments'::regclass AND conname LIKE '%rail%';
-- Cash on Hand account exists after seed-defaults:
SELECT code, name FROM accounts WHERE code = '1000';
```

---

## 2) API changes

### 2a. `apps/api/src/payments/payments.service.ts` — make `reconcile()` rail-aware (~10 changed lines)

The receipt posting currently hard-codes `1010 M-Pesa`. Add `rail` to the `FOR UPDATE` select and pick the debit account:

```ts
// in reconcile(): add rail to the SELECT
`SELECT id, rail, amount_cents, account_ref, invoice_id, journal_entry_id,
        state, receipt_number
 FROM payments WHERE id = $1 FOR UPDATE`
// posting:
const debitAccount = payment.rail === "cash" ? "1000" : "1010";
const railLabel   = payment.rail === "cash" ? "Cash"  : "M-Pesa";
// memo: `${railLabel} ${payment.receipt_number ?? paymentId} for invoice ${invoice.invoice_no}`
lines: [
  { accountCode: debitAccount, debitCents: received },
  { accountCode: "1100", creditCents: received },
],
```

Also skip the SMS block when `payerMsisdn` is null (already handled — cash rows have `msisdn = NULL`).

### 2b. `apps/api/src/payments/payments.service.ts` — new `recordCashPayment` (~35 lines)

Keeps all payment inserts inside the payments module. Called with the POS transaction's client so the sale is atomic.

```ts
async recordCashPayment(
  client: PoolClient,
  args: { tenantId: string; invoiceId: string; invoiceNo: number; amountCents: number },
): Promise<{ paymentId: string }> {
  const res = await client.query(
    `INSERT INTO payments
       (tenant_id, rail, state, amount_cents, account_ref,
        receipt_number, invoice_id, confirmed_at)
     VALUES ($1, 'cash', 'confirmed', $2, $3, $4, $5, now())
     RETURNING id`,
    [args.tenantId, args.amountCents, String(args.invoiceNo),
     `CASH-${args.invoiceNo}`, args.invoiceId],   // unique per (tenant, receipt_number): invoiceNo is per-tenant unique
  );
  const paymentId = res.rows[0].id as string;
  const m = await this.reconcile(client, args.tenantId, paymentId, args.invoiceId);
  if (!m.matched) throw new BadRequestException("Cash payment failed to match invoice");
  return { paymentId };
}
```

### 2c. `apps/api/src/payments/payments.controller.ts` — `GET tenants/current/payments/:id` (~15 lines)

Needed for STK polling from the POS. **Declare it after `@Get("unmatched")`** so the static route wins.

```ts
@Get(":id")
async getOne(@TenantClaims() claims: TenantTokenClaims,
             @Param("id", ParseUUIDPipe) paymentId: string) {
  return this.db.withTenant(claims.tid, claims.sub, async (client) => {
    const res = await client.query(
      `SELECT id, rail, state, amount_cents, receipt_number, invoice_id,
              last_error, confirmed_at
       FROM payments WHERE id = $1`, [paymentId]);
    if (!res.rows[0]) throw new NotFoundException();
    return res.rows[0];
  });
}
```

### 2d. New `apps/api/src/invoicing/pos.controller.ts` (~170 lines) — register in `app.module.ts` `controllers`

```ts
@Controller("tenants/current/pos")
@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)
export class PosController {
  constructor(private readonly db: DbService,
              private readonly invoices: InvoicesService,
              private readonly payments: PaymentsService) {}
```

**`POST tenants/current/pos/sales`** — `@Roles("owner", "admin", "accountant", "cashier")`

Body:
```ts
{
  branchId: string;                       // required uuid
  customerId?: string;                    // optional; default = walk-in customer
  payMethod: "cash" | "mpesa_stk";        // required
  lines: { itemId: string; quantity: number }[];  // required, non-empty, quantity > 0
  tenderedCents?: number;                 // cash only; if set must be int >= total
}
```

Single `this.db.withTenant(claims.tid, claims.sub, ...)` transaction:

1. `await seedDefaultAccounts(client, claims.tid)` (idempotent; import from `../ledger/ledger.service`).
2. Resolve customer — walk-in find-or-create, race-safe via advisory lock (customers has no unique name index):
```sql
SELECT pg_advisory_xact_lock(hashtext('pos-walkin:' || $1));           -- $1 = tenantId
SELECT id FROM customers WHERE name = 'Walk-in Customer' ORDER BY created_at LIMIT 1;
-- if none:
INSERT INTO customers (tenant_id, name) VALUES ($1, 'Walk-in Customer') RETURNING id;
```
3. Price lines from the catalog (server-priced — never trust client prices):
```sql
SELECT id, name, price_cents, vat_rate FROM items WHERE id = ANY($1::uuid[])
```
Reject with 400 if any `itemId` is missing. Build `InvoiceLineInput[]`: `{ description: item.name, quantity, unitPriceCents: Number(item.price_cents), vatRate: item.vat_rate, itemId: item.id }`.
4. `const draft = await this.invoices.createDraft(client, { tenantId, userId, branchId, customerId, lines })`.
5. `const issued = await this.invoices.issue(client, { tenantId, userId, invoiceId: draft.id, issueDate: today })` — this fiscalizes, decrements stock (overselling aborts the whole sale with the existing "Insufficient stock" 400), posts AR/Sales/VAT + COGS.
6. If `payMethod === "cash"`:
   - If `tenderedCents` provided: must be integer `>= issued.totalCents`, else 400 `"Tendered amount is less than the total"`.
   - `await this.payments.recordCashPayment(client, { tenantId, invoiceId: draft.id, invoiceNo: issued.invoiceNo, amountCents: issued.totalCents })` — note: books the **total**, not the tendered amount; change is returned to the customer, never enters the ledger.
7. Return:
```ts
{ invoiceId, invoiceNo, totalCents, subtotalCents, vatCents,
  paid: payMethod === "cash",
  changeCents: payMethod === "cash" && tenderedCents ? tenderedCents - totalCents : 0 }
```

**M-Pesa STK is deliberately NOT inside this endpoint** — external calls must stay outside DB transactions (04-architecture §5). The web client sequences it (see §3): `pos/sales` (issue only) → existing `POST tenants/current/payments/stk` with `{ amountCents: totalCents, msisdn, accountRef: String(invoiceNo), invoiceId }` → poll `GET payments/:id`. The existing STK callback then reconciles and flips the invoice to `paid`.

No `GET pos/catalog` endpoint — the page reuses `GET tenants/current/items` + `GET tenants/current/stock/levels` and merges client-side.

---

## 3) Web page — `apps/web/app/(app)/pos/page.tsx` (~380 lines)

### Nav & i18n
- `AppShell.tsx`: add one `till` icon (receipt outline) to `Icons`; insert as the **first** item of the `navSales` section: `{ href: "/pos", labelKey: "navPos", icon: "till" }`.
- `lib/i18n.tsx` additions (both languages, exact keys):

| key | en | sw |
|---|---|---|
| `navPos` | Sell (POS) | Uza (POS) |
| `posCharge` | Charge | Lipisha |
| `posCash` | Cash | Taslimu |
| `posTendered` | Cash received | Pesa iliyopokelewa |
| `posChange` | Change | Chenji |
| `posWalkIn` | Walk-in customer | Mteja wa papo hapo |
| `posEmptyCart` | Tap items to add them to the sale. | Gusa bidhaa kuziweka kwenye mauzo. |
| `posAwaitPin` | Waiting for customer PIN… | Inasubiri PIN ya mteja… |
| `posPrintReceipt` | Print receipt | Chapisha risiti |
| `posNewSale` | New sale | Mauzo mapya |
| `posToday` | Today | Leo |

### Structure (tabs pattern, like `hr/page.tsx`)
```
type Tab = "sell" | "today";
<h1>{t("navPos")}</h1>
<div className="tabs"> Sell | Today </div>
```

**Sell tab** — `<div className="pos-grid">` (CSS: `grid-template-columns: 1fr 380px`, stacks to 1 column under 900px):

- **Left card — catalog.** Search `<input>` (filters on `sku`/`name`, client-side). `<div className="pos-items">` grid (`repeat(auto-fill, minmax(150px, 1fr))`) of `<button className="pos-item">` per item: item name, muted SKU, bold `fmtKes(price_cents)`, and a stock pill: `pill paid` with on-hand qty when > 0, `pill failed` "Out" when tracked and 0 (button `disabled`), muted "—" when `track_stock=false`. Data: `Promise.all([api("/tenants/current/items"), api("/tenants/current/stock/levels"), api("/tenants/current/branches")])`; on-hand = sum of level rows for `itemId` + selected `branchId`. Click = add to cart (or `qty+1` if present). On-hand shown net of what's already in the cart.

- **Right card — cart.** Top row: branch `<select>` (default first) and customer `<select>` with first option `value=""` → `t("posWalkIn")`, then `GET customers` list. Cart rows: name, qty stepper (`−` / numeric input `min=1` / `+`), line total, `×` remove. Totals block: Subtotal / VAT / **Total** — UI preview uses `Math.round(unitPrice * qty)` and `Math.round(total * 0.16)`; server totals from the checkout response are authoritative and are what the receipt shows. Payment method: two-button segmented control reusing the `tabs` classes — `t("posCash")` | `M-Pesa`. Cash: `t("posTendered")` KES input → live `t("posChange")` line (red if short; checkout disabled). M-Pesa: MSISDN input, placeholder `2547XXXXXXXX`, validated with `/^2547\d{8}$/`. Bottom: full-width primary button `` `${t("posCharge")} ${fmtKes(totalCents)}` `` (disabled when cart empty / busy / invalid).

- **Checkout flow.**
  - Cash: `POST /tenants/current/pos/sales` → on success open receipt modal immediately (`paid: true`).
  - M-Pesa: `POST pos/sales` (`payMethod:"mpesa_stk"`) → `POST /tenants/current/payments/stk { amountCents: totalCents, msisdn, accountRef: String(invoiceNo), invoiceId }` → poll `GET /tenants/current/payments/{id}` every 2 s, max 90 s, showing `t("posAwaitPin")` with a spinner and the invoice number. `state==="confirmed"` → receipt modal; `"failed"` → show `last_error` with buttons "Retry M-Pesa" (re-runs the STK POST only — invoice already exists) and "Take cash instead" (calls `recordCashPayment` path? **no** — out of scope v1; instruct cashier to settle it from the Payments screen); poll timeout / `"timeout_reconciling"` → info banner "Payment still processing — it will auto-match to invoice #N when confirmed" (existing reconciliation handles it), cart clears.
  - After any successful checkout: clear cart, refetch stock levels.

- **Receipt modal** (`<div className="modal-overlay"><div className="card pos-receipt">`). Data: `GET /tenants/current/invoices/{id}` (lines, totals, `control_number`, `fiscal_status`, `customer_name`) + checkout/poll context (method, M-Pesa `receipt_number`, tendered/change). Content top-to-bottom, centered, `font: 12px/1.5 "Courier New", monospace`:
  tenant name (`sessionStorage jenga.tenantName`) · branch name · `Invoice #N` · datetime · dashed `<hr>` · one row per line `name  qty × unitKES  =  lineKES` · dashed rule · Subtotal / VAT (16%) / **TOTAL** · payment: `CASH — tendered / change` or `M-PESA — <receipt_number>` · `eTIMS: <control_number>` or `eTIMS: pending` when `fiscal_status !== "signed"` · footer `Asante! Karibu tena.` Buttons under the modal (hidden in print): `t("posPrintReceipt")` → `window.print()`, `t("posNewSale")` → close.

**Today tab** — `DataTable` over `GET /tenants/current/invoices` filtered client-side to `issue_date === today`:

| Column | key | notes |
|---|---|---|
| No. | `invoice_no` | |
| `t("customer")` | `customer_name` | searchKeys: `["customer_name"]` |
| `t("total")` | `total_cents` | `num`, render `fmtKes` |
| `t("status")` | `status` | `<span className={"pill " + status}>` |
| eTIMS | `control_number` | muted, `—` when null |
| | actions | "Reprint" link → fetch `invoices/:id`, open receipt modal (payment context omitted → method line reads from invoice status) |

Props: `csvName="pos-today.csv"`, `pageSizeDefault={20}`, `empty={t("noInvoices")}`.

### CSS — append to `apps/web/app/globals.css` (~70 lines)
`.pos-grid`, `.pos-items`, `.pos-item` (card-styled button, hover lift, `:disabled` dimmed), `.pos-receipt` (width 300px), and the print block:

```css
@media print {
  body * { visibility: hidden; }
  .pos-receipt, .pos-receipt * { visibility: visible; }
  .pos-receipt { position: absolute; left: 0; top: 0; width: 72mm;
                 box-shadow: none; border: 0; margin: 0; padding: 0 2mm; }
  .no-print { display: none !important; }
}
@page { size: 80mm auto; margin: 4mm; }
```
(72 mm printable width on 80 mm paper is the thermal-printer norm; browsers with A4 default still print a clean narrow column.)

---

## 4) Test cases — new `apps/api/test/pos.spec.ts` (model on `quotes-reports.spec.ts` bootstrap; also `POST /tenants/current/payments/shortcodes {shortcode:"600100"}` in `beforeAll` so STK callbacks can route)

Setup: signup/login/tenant-token, seed-defaults, branch, one item `{sku:"POS-1", name:"Sugar 1kg", costCents:9000, priceCents:15000, vatRate:"0.16", trackStock:true}`, stock movement `+10`.

1. **Cash sale is atomic and fully settled.** `POST pos/sales {branchId, payMethod:"cash", lines:[{itemId, quantity:2}], tenderedCents: 40000}` → 201 with `paid:true`, `totalCents: 34800` (2×15000=30000 + 4800 VAT), `changeCents: 5200`. Assert `GET invoices/:id` → `status:"paid"`, `amount_paid_cents:"34800"`; `GET stock/levels` on-hand 8; trial balance: `1000` debit +34800, `4000` credit 30000, `2200` credit 4800, `5000` debit 18000 (COGS 2×9000).
2. **Walk-in customer is created once.** Two cash sales without `customerId` → `SELECT count(*) FROM customers WHERE name='Walk-in Customer'` (via `GET customers` filter) = 1, and both invoices reference it.
3. **STK sale confirms via webhook.** `POST pos/sales {payMethod:"mpesa_stk", ...}` → `paid:false`; `POST payments/stk {amountCents: totalCents, msisdn:"254712345678", accountRef:String(invoiceNo), invoiceId}` → `{id, providerRef, state:"pending"}`; `POST /webhooks/mpesa/stk {Body:{stkCallback:{CheckoutRequestID: providerRef, ResultCode:0, ResultDesc:"ok", MpesaReceiptNumber:"SBX123"}}}` → `GET payments/:id` state `confirmed`, invoice `paid`, ledger debit on `1010` (not `1000`).
4. **Oversell aborts the whole sale.** Cart quantity 999 → 400 mentioning "Insufficient stock"; invoice count unchanged (`GET invoices` length stable), no payment row, stock unchanged — proving createDraft+issue rolled back together.
5. **Cash short-tender rejected.** `tenderedCents: 100` on a 34800 sale → 400 "Tendered amount is less than the total"; nothing persisted.

---

## 5) Demo-data additions (`apps/api/src/tenants/demo-data.controller.ts`, ~30 lines, inside the main `seed()` after stock movements are created)

- Create the `Walk-in Customer` row (same SQL as the controller, no lock needed — single-threaded seed).
- Generate **8 POS cash sales dated today** so the POS "Today" tab and receipt reprint demo instantly: for each, pick 1–3 random seeded items (`quantity` 1–4), `invoices.createDraft` with `itemId` lines at catalog price → `invoices.issue` with `issueDate = day(now)` → insert cash payment + `payments.reconcile` via the new `payments.recordCashPayment(client, …)` (PaymentsService is already injected). Add `posSales` to the `counts` object and response.
- Guard: skip any sale that throws "Insufficient stock" (seeded stock is random) — wrap each in try/catch and continue.

---

## 6) Explicitly out of scope (v1)

- **No new tables**: no registers/shifts/cash-drawer sessions, no Z-report / end-of-day till reconciliation, no hold/park sale, no barcode field (search-by-SKU covers scanners that type+Enter).
- **Refunds/voids from the POS** — use the existing invoice credit-note flow (accountant role).
- **Split tender / partial POS payments** (cash+M-Pesa on one sale), card rails, customer credit/tabs.
- **Discounts and price overrides** — catalog price only; server ignores client prices by design.
- **C2B "customer pays till directly" flow at the POS** — existing auto-reconciliation already matches those by invoice number; POS only drives STK.
- **"Take cash instead" after a failed STK** — settle from the Payments screen (manual match); no dual-path endpoint.
- **ESC/POS driver / native printing** — browser `window.print()` with 80mm CSS only.
- **Offline mode / local queue**, multi-cashier concurrency UX beyond what row locks already guarantee, and a dedicated POS role (uses existing `cashier`).
- **Per-branch price lists** — one price per item.

Key files: `apps/api/src/invoicing/pos.controller.ts` (new), `apps/api/src/payments/payments.service.ts`, `apps/api/src/payments/payments.controller.ts`, `apps/api/src/app.module.ts`, `apps/web/app/(app)/pos/page.tsx` (new), `apps/web/components/AppShell.tsx`, `apps/web/lib/i18n.tsx`, `apps/web/app/globals.css`, `apps/api/src/tenants/demo-data.controller.ts`, `apps/api/test/pos.spec.ts` (new).