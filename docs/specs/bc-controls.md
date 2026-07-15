I have everything needed. Here is the implementation spec.

# Jenga ERP — Internal Controls (Audit Trail Viewer + Approval Workflow)

Estimated footprint: ~780 changed lines. New module: `controls`. New page: `/controls`.

---

## 1) Migration — `db/migrations/0017_controls.sql` (complete, ready to paste)

```sql
-- 0017: Internal controls — approval workflow + tenant settings.
-- Business Central-style maker-checker with a monetary gate: bills and
-- M-Pesa B2C payouts at/above a tenant-configurable threshold require
-- owner approval before posting. approval_requests is the single queue;
-- the audit_log (0001) already records every state change.

-- ---------------------------------------------------------------------------
-- Tenant settings (one row per tenant; NULL threshold = approvals off).
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_settings (
  tenant_id                 uuid PRIMARY KEY REFERENCES tenants (id),
  approval_threshold_cents  bigint
                            CHECK (approval_threshold_cents IS NULL
                                   OR approval_threshold_cents > 0),
  updated_by                uuid REFERENCES users (id),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_settings_tenant ON tenant_settings
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Approval requests. kind identifies the gated action; payload carries the
-- action's arguments (e.g. {method, msisdn} for a payout) so the owner's
-- approval can execute it verbatim. At most ONE pending request per
-- (kind, entity) — the partial unique index is the concurrency guard.
-- ---------------------------------------------------------------------------
CREATE TABLE approval_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  kind          text NOT NULL CHECK (kind IN ('bill_approve', 'bill_pay')),
  entity_type   text NOT NULL CHECK (entity_type IN ('bill')),
  entity_id     uuid NOT NULL,
  amount_cents  bigint NOT NULL CHECK (amount_cents >= 0),
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_by  uuid NOT NULL REFERENCES users (id),
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by    uuid REFERENCES users (id),
  decided_at    timestamptz,
  reject_reason text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX approval_requests_tenant_idx
  ON approval_requests (tenant_id, status, created_at DESC);
CREATE UNIQUE INDEX approval_requests_pending_uniq
  ON approval_requests (tenant_id, kind, entity_id)
  WHERE status = 'pending';

ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY approval_requests_tenant ON approval_requests
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Bills gain a pending_approval state (between draft and approved).
-- ---------------------------------------------------------------------------
ALTER TABLE bills DROP CONSTRAINT bills_status_check;
ALTER TABLE bills ADD CONSTRAINT bills_status_check
  CHECK (status IN ('draft', 'pending_approval', 'approved', 'paid', 'void'));

-- Audit viewer filters by entity efficiently.
CREATE INDEX audit_log_tenant_entity_idx
  ON audit_log (tenant_id, entity_type, id DESC);

GRANT SELECT, INSERT, UPDATE ON tenant_settings TO jenga_app;
GRANT SELECT, INSERT, UPDATE ON approval_requests TO jenga_app;
```

---

## 2) API changes

### 2a. New `apps/api/src/controls/approvals.service.ts`

```ts
@Injectable()
export class ApprovalsService {
  constructor(private readonly audit: AuditService) {}

  /** NULL = approvals disabled. */
  async thresholdCents(client: PoolClient): Promise<number | null> {
    const r = await client.query(
      "SELECT approval_threshold_cents FROM tenant_settings LIMIT 1");
    const v = r.rows[0]?.approval_threshold_cents;
    return v === null || v === undefined ? null : Number(v);
  }

  /** True when this amount, from this role, needs owner sign-off. */
  gated(threshold: number | null, amountCents: number, role: Role): boolean {
    return threshold !== null && amountCents >= threshold && role !== "owner";
  }

  async createRequest(client: PoolClient, args: {
    tenantId: string; requestedBy: string;
    kind: "bill_approve" | "bill_pay"; entityId: string;
    amountCents: number; payload?: Record<string, unknown>;
  }): Promise<string> {
    // INSERT ... RETURNING id; on unique_violation (23505) throw
    // BadRequestException("An approval request for this is already pending")
    // then this.audit.record(client, { action: "approval.requested",
    //   entityType: "approval_request", entityId: id,
    //   payload: { kind, entityId, amountCents } })
  }

  /** Close any pending request for an entity from inside the action's own
   *  transaction (so a direct owner action auto-resolves the queue). */
  async closePending(client: PoolClient, args: {
    kind: string; entityId: string; decidedBy: string;
  }): Promise<void> {
    await client.query(
      `UPDATE approval_requests
       SET status = 'approved', decided_by = $3, decided_at = now()
       WHERE kind = $1 AND entity_id = $2 AND status = 'pending'`,
      [args.kind, args.entityId, args.decidedBy]);
  }
}
```

### 2b. New `apps/api/src/controls/controls.controller.ts`

`@Controller("tenants/current")`, `@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)`. Injects `DbService`, `ApprovalsService`, `BillsService`, `AuditService`.

| Route | Roles | Behavior |
|---|---|---|
| `GET controls/settings` | any | `SELECT approval_threshold_cents FROM tenant_settings` → `{ approvalThresholdCents: number \| null }` (no row → null) |
| `PUT controls/settings` | `owner` | body `{ approvalThresholdCents: number \| null }`; validate `null` or positive integer; upsert (SQL below); audit `controls.threshold_set` with `{ approvalThresholdCents }` |
| `GET approvals?status=pending\|approved\|rejected` | any | list SQL below |
| `GET approvals/counts` | any | `SELECT count(*)::int AS pending FROM approval_requests WHERE status = 'pending'` → `{ pending }` |
| `POST approvals/:id/approve` | `owner` | executor — see below |
| `POST approvals/:id/reject` | `owner` | body `{ reason?: string }` — see below |

Settings upsert:

```sql
INSERT INTO tenant_settings (tenant_id, approval_threshold_cents, updated_by)
VALUES ($1, $2, $3)
ON CONFLICT (tenant_id) DO UPDATE
SET approval_threshold_cents = EXCLUDED.approval_threshold_cents,
    updated_by = EXCLUDED.updated_by, updated_at = now()
```

Approvals list (LEFT JOIN keeps future entity kinds working):

```sql
SELECT ar.id, ar.kind, ar.entity_type, ar.entity_id, ar.amount_cents,
       ar.payload, ar.status, ar.created_at, ar.decided_at, ar.reject_reason,
       ru.full_name AS requested_by_name, du.full_name AS decided_by_name,
       b.supplier_invoice_no, b.status AS bill_status, s.name AS supplier_name
FROM approval_requests ar
JOIN users ru ON ru.id = ar.requested_by
LEFT JOIN users du ON du.id = ar.decided_by
LEFT JOIN bills b ON ar.entity_type = 'bill' AND b.id = ar.entity_id
LEFT JOIN suppliers s ON s.id = b.supplier_id
WHERE ($2::text IS NULL OR ar.status = $2)
ORDER BY ar.created_at DESC
LIMIT 200
```

**`POST approvals/:id/approve` executor logic:**

- `kind = 'bill_approve'` — single `withTenant` transaction: `SELECT * FROM approval_requests WHERE id = $1 FOR UPDATE` (404 if missing, 400 if not pending) → call `bills.approve(client, { billId: entity_id, ... , userId: claims.sub })` (which posts the JE, flips the bill to `approved`, and — via `closePending` inside `approve`, see 2c — marks this request approved) → audit `approval.approved`. Fully atomic.
- `kind = 'bill_pay'` — pay has an external phase, so it cannot be one transaction. Sequence: (1) `withTenant`: load request, must be pending; load bill status. If bill already `paid` (owner paid directly earlier and closePending somehow missed), just close the request and return. (2) Call `bills.pay({ tenantId, userId: claims.sub, billId: entity_id, method: payload.method, msisdn: payload.msisdn })` — its phase-3 transaction closes the pending request via `closePending` and writes `bill.paid` audit. If `pay` throws, the request stays `pending` (retryable; ledger idempotency key `bill-payment:<id>` makes double-execution safe). (3) Return `{ journalEntryId, providerRef }`.

**`POST approvals/:id/reject`:** one `withTenant` txn: lock request `FOR UPDATE`, must be pending; `UPDATE approval_requests SET status='rejected', decided_by=$2, decided_at=now(), reject_reason=$3 WHERE id=$1`; if `kind='bill_approve'`, `UPDATE bills SET status='draft' WHERE id=$entity_id AND status='pending_approval'` (back to maker for edit); audit `approval.rejected` with `{ reason }`. (`bill_pay` rejection leaves the bill `approved` — money never moved.)

Register `ControlsController` + `ApprovalsService` in `app.module.ts`.

### 2c. Changes to `apps/api/src/purchases`

`bills.controller.ts` — `POST bills/:id/approve` (roles unchanged):

```ts
return this.db.withTenant(claims.tid, claims.sub, async (client) => {
  const r = await client.query(
    "SELECT status, total_cents FROM bills WHERE id = $1 FOR UPDATE", [billId]);
  if (!r.rows[0]) throw new NotFoundException("Bill not found");
  const threshold = await this.approvals.thresholdCents(client);
  if (this.approvals.gated(threshold, Number(r.rows[0].total_cents), claims.rol)) {
    if (r.rows[0].status !== "draft")
      throw new BadRequestException("Only draft bills can be submitted for approval");
    const requestId = await this.approvals.createRequest(client, {
      tenantId: claims.tid, requestedBy: claims.sub, kind: "bill_approve",
      entityId: billId, amountCents: Number(r.rows[0].total_cents),
    });
    await client.query(
      "UPDATE bills SET status = 'pending_approval' WHERE id = $1", [billId]);
    return { pendingApproval: true, approvalRequestId: requestId };
  }
  return this.bills.approve(client, { tenantId: claims.tid, userId: claims.sub, billId });
});
```

`POST bills/:id/pay` — before calling `bills.pay`, and only when `body.method === "mpesa_b2c"`, run a `withTenant` pre-check: load bill (`must be approved`), read threshold; if `gated(threshold, total, claims.rol)` → `createRequest(kind: "bill_pay", payload: { method, msisdn }, amountCents: total)` and return `{ pendingApproval: true, approvalRequestId }`. Otherwise proceed to `this.bills.pay(...)` as today. (Duplicate submissions hit the partial unique index → clean 400.)

`bills.service.ts`:
- `approve()`: change guard to `if (bill.status !== "draft" && bill.status !== "pending_approval")` and after the `UPDATE bills SET status='approved'` add `await this.approvalsClose(client, "bill_approve", args.billId, args.userId)` — inject `ApprovalsService` and call `closePending`.
- `pay()` phase 3: after `UPDATE bills SET status='paid'`, add `closePending(client, { kind: "bill_pay", entityId: args.billId, decidedBy: args.userId })`.

### 2d. Audit viewer — extend `TenantsController.auditTrail` (`GET tenants/current/audit`, roles owner/admin unchanged)

Accept `@Query()` `actor` (uuid), `entityType`, `action` (prefix), `from`/`to` (YYYY-MM-DD), `limit`:

```sql
SELECT a.id, a.actor_user_id, u.full_name AS actor_name, u.email AS actor_email,
       a.action, a.entity_type, a.entity_id, a.payload, a.created_at
FROM audit_log a
LEFT JOIN users u ON u.id = a.actor_user_id
WHERE a.tenant_id = $1
  AND ($2::uuid  IS NULL OR a.actor_user_id = $2::uuid)
  AND ($3::text  IS NULL OR a.entity_type = $3)
  AND ($4::text  IS NULL OR a.action LIKE $4 || '%')
  AND ($5::date  IS NULL OR a.created_at >= $5::date)
  AND ($6::date  IS NULL OR a.created_at < ($6::date + 1))
ORDER BY a.id DESC
LIMIT LEAST(GREATEST(COALESCE($7::int, 200), 1), 1000)
```

Pass empty strings as `null`. Keep `prev_hash`/`hash` out of the response (integrity is server-side).

---

## 3) Web

### 3a. New page `apps/web/app/(app)/controls/page.tsx`

Standard page conventions: `"use client"`, tenant-token guard + `router.replace("/")`, `act()` busy/error wrapper, `← Dashboard` link, `<h1>Controls</h1>`.

Role helper (top of file): decode `rol` from the tenant JWT payload — `JSON.parse(atob(getTenantToken()!.split(".")[1])).rol` in a try/catch; `isOwner` gates action buttons and the settings form.

Tabs (`useState<"approvals" | "audit" | "settings">("approvals")`, `<div className="tabs">` of `className={tab===k ? "tab active" : "tab"}` buttons):

**Approvals tab**
- Tile row (3 `card` tiles like dashboard): Pending approvals (count), Pending value (`fmtKes0` sum of pending `amount_cents`), Threshold (`fmtKes0` or "Off").
- `DataTable<ApprovalRow>` — `csvName="approvals"`, `searchKeys={["supplier_name","requested_by_name"]}`, toolbar: status `<select>` (Pending / All / Approved / Rejected) that refetches `/tenants/current/approvals?status=…`.

| key | label | notes |
|---|---|---|
| `created_at` | Requested | `value` → `r.created_at`, render date slice(0,10) |
| `kind` | Type | render pill: `bill_approve` → "Bill posting", `bill_pay` → "M-Pesa payout" |
| `supplier_name` | Supplier / Ref | render `${supplier_name ?? "—"} · ${supplier_invoice_no ?? entity_id.slice(0,8)}` |
| `requested_by_name` | Requested by | |
| `amount_cents` | Amount | `num`, `value: r => Number(r.amount_cents)`, render `fmtKes` |
| `status` | Status | pill: `pending` (default), `approved` → `className="pill paid"`, `rejected` → `pill` |
| `actions` | (blank label) | when `status==="pending" && isOwner`: Approve button (`POST /tenants/current/approvals/${id}/approve`) + secondary Reject (uses `window.prompt("Reason?")` → `POST .../reject` body `{reason}`) |

- `empty`: `<p className="muted">Nothing waiting for approval.</p>`

**Audit trail tab**
- Fetch `/tenants/current/audit?actor=&entityType=&from=&to=` on tab open and on Apply. Also fetch `/tenants/current/members` once for the actor dropdown.
- `DataTable<AuditRow>` — `csvName="audit-trail"`, `pageSizeDefault={25}`, `searchKeys={["action","entity_type","actor_name"]}`, toolbar: actor `<select>` (All + member names), entity-type `<select>` (All, invoice, bill, payment, payroll_run, membership, approval_request, controls), two `<input type="date">` (from/to), secondary "Apply" button.

| key | label | notes |
|---|---|---|
| `created_at` | Time | render `new Date(...).toLocaleString()` , `value` raw for sort/CSV |
| `actor_name` | Actor | render `actor_name ?? "system"` |
| `action` | Action | render `<span className="pill">{action}</span>` |
| `entity_type` | Entity | render `${entity_type}${entity_id ? " · " + entity_id.slice(0,8) : ""}` |
| `payload` | Details | `value: r => JSON.stringify(r.payload)`, render truncated to 80 chars with `title` = full JSON |

**Settings tab** (non-owners see a muted "Only the owner can change approval controls." card)
- Card: explanation line ("Bills and M-Pesa payouts at or above this amount must be approved by the owner before they post."), KES number input (display = cents/100), "Save threshold" button → `PUT /tenants/current/controls/settings` body `{ approvalThresholdCents: Math.round(Number(v)*100) }`, and a secondary "Turn off approvals" button sending `{ approvalThresholdCents: null }`.

### 3b. `AppShell.tsx` + i18n

- Nav: add to the `navCompliance` section: `{ href: "/controls", labelKey: "navControls", icon: "shield" }`.
- Badge: in `AppShell`, `useState<number>(0)` + `useEffect` on `pathname` → `api<{pending:number}>("/tenants/current/approvals/counts").then(r => setPending(r.pending)).catch(() => undefined)`; in the nav render, when `item.href === "/controls" && pending > 0` append `<span className="nav-badge">{pending}</span>`. CSS (globals): `.nav-badge { margin-left:auto; background:var(--brand); color:#fff; border-radius:999px; font-size:11px; min-width:18px; padding:1px 6px; text-align:center; }`.
- `lib/i18n.tsx`: `navControls: "Controls"` (en) / `navControls: "Udhibiti"` (sw).

### 3c. `purchases/page.tsx` (minimal)

- Render `pending_approval` status as `<span className="pill">awaiting owner</span>`; after `approve()` returns `{pendingApproval: true}`, no special handling needed (list reload shows the new status). No other changes.

---

## 4) Test cases (API e2e, same harness as existing purchase tests)

1. **Below threshold posts directly.** Owner sets threshold KES 50,000 (`PUT controls/settings {approvalThresholdCents: 5000000}`). Accountant drafts a KES 10,000 bill, calls `bills/:id/approve` → response has `journalEntryId`, bill status `approved`, zero rows in `approval_requests`.
2. **At/above threshold gates non-owners, owner approval executes atomically.** Accountant drafts a KES 80,000 bill, calls approve → `{pendingApproval: true}`, bill `pending_approval`, no journal entry for `idempotencyKey bill:<id>`; `approvals/counts` = 1. Owner `POST approvals/:id/approve` → JE exists, bill `approved`, request `approved` with `decided_by` = owner, audit has `approval.requested` then `approval.approved`.
3. **Owner bypasses the gate and auto-closes stale requests.** With a pending `bill_approve` request, the owner calls `bills/:id/approve` directly → bill posts and the pending request flips to `approved` (closePending), leaving `approvals/counts` = 0.
4. **Reject returns the bill to draft.** Owner `POST approvals/:id/reject {reason:"wrong supplier"}` → request `rejected` with reason, bill back to `draft`, audit `approval.rejected`; accountant can edit-free re-approve path re-creates a new request.
5. **B2C payout gate + role guard.** Admin pays an approved KES 80,000 bill with `method: "mpesa_b2c", msisdn: "254712345678"` → `{pendingApproval: true}`, no payout sent (sandbox provider `sent` empty), bill stays `approved`. Admin calling `approvals/:id/approve` → 403. Owner approving → payout provider called once, JE `bill-payment:<id>` exists, bill `paid`, request closed. Re-approving → 400 (not pending).
6. **Audit filters.** `GET audit?entityType=bill&from=<today>` returns only bill rows; `actor=<accountant uuid>` excludes owner-actioned rows; `limit=5000` is clamped to 1000.

---

## 5) Demo data (`tenants/demo-data.controller.ts`, main seed, after step 5 "Bills")

```ts
// 5b. Controls: KES 30,000 approval threshold + a queue of big bills
// awaiting the owner, so /controls lands populated.
await this.db.withTenant(claims.tid, claims.sub, async (client) => {
  await client.query(
    `INSERT INTO tenant_settings (tenant_id, approval_threshold_cents, updated_by)
     VALUES ($1, 3000000, $2)
     ON CONFLICT (tenant_id) DO UPDATE SET approval_threshold_cents = 3000000`,
    [claims.tid, claims.sub]);
  const big = await client.query(
    `SELECT id, total_cents FROM bills
     WHERE status = 'draft' AND total_cents >= 3000000
     ORDER BY total_cents DESC LIMIT 3`);
  for (const b of big.rows) {
    await client.query(
      `INSERT INTO approval_requests
         (tenant_id, kind, entity_type, entity_id, amount_cents, requested_by)
       VALUES ($1, 'bill_approve', 'bill', $2, $3, $4)`,
      [claims.tid, b.id, b.total_cents, claims.sub]);
    await client.query(
      "UPDATE bills SET status = 'pending_approval' WHERE id = $1", [b.id]);
    counts.approvals++;
  }
});
```

Add `approvals: 0` to the `counts` object. (The existing seed already produces a rich audit_log via `AuditService`, so the audit tab needs no extra seeding.)

---

## 6) Out of scope (explicit)

- Multi-step / multi-approver chains, delegated approvers, amount bands per role — single owner gate only.
- Approval gates on invoices, payroll commits, credit notes, journal entries, or stock movements (`kind` CHECK deliberately allows only bill flows; extend the CHECK in a later migration).
- Per-kind thresholds (one tenant-wide threshold covers both gated actions).
- Notifications to the owner on request creation (the outbox exists; wiring `TEMPLATES.approval_requested` is a follow-up).
- Editing a `pending_approval` bill (must be rejected back to draft first).
- Audit hash-chain verification endpoint/UI (viewer only; hashes stay internal).
- Server-side pagination of the audit viewer beyond the 1000-row cap; CSV export is client-side of fetched rows via DataTable.
- Backfilling `tenant_settings` rows for existing tenants (absent row = approvals off by design).