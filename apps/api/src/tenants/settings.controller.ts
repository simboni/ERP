import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Patch,
  UseGuards,
} from "@nestjs/common";
import type { TenantTokenClaims } from "@jenga/shared";
import { AuditService } from "../audit/audit.service";
import {
  JwtAuthGuard,
  Roles,
  RolesGuard,
  TenantClaims,
  TenantContextGuard,
} from "../auth/guards";
import { DbService } from "../db/db.service";
import {
  BUSINESS_TYPE_KEYS,
  isBusinessType,
  isOptionalModuleKey,
} from "./industry.constants";

/**
 * The tenant's own configuration surface: legal identity (KRA PIN, VAT
 * number, addresses, contacts) plus the numbering and tax defaults that
 * invoices, quotes and receipts read as their source of truth. Everything
 * lives on the RLS-protected tenants row, so a read/write here can only ever
 * touch the caller's own workspace; mutations are owner/admin only.
 */
@Controller("tenants/current")
@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)
export class SettingsController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  private static readonly PROFILE_COLUMNS = `
    id, name, slug, status, created_at,
    legal_name, kra_pin, vat_number, phone, email,
    postal_address, physical_address, currency,
    fiscal_year_start_month, invoice_footer, invoice_prefix,
    quote_prefix, default_vat_rate, prices_vat_inclusive,
    default_payment_terms_days, business_type, enabled_modules, logo`;

  @Get("profile")
  async getProfile(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT ${SettingsController.PROFILE_COLUMNS}
         FROM tenants WHERE id = $1`,
        [claims.tid],
      );
      if (!res.rows[0]) throw new NotFoundException();
      // Read-only numbering peek: what the next issued document will be.
      const nums = await client.query(
        `SELECT
           (SELECT coalesce(max(invoice_no), 0) + 1 FROM invoices) AS next_invoice_no,
           (SELECT coalesce(max(quote_no), 0) + 1 FROM quotes) AS next_quote_no`,
      );
      return {
        ...res.rows[0],
        next_invoice_no: Number(nums.rows[0].next_invoice_no),
        next_quote_no: Number(nums.rows[0].next_quote_no),
      };
    });
  }

  @Patch("profile")
  @Roles("owner", "admin")
  async patchProfile(
    @TenantClaims() claims: TenantTokenClaims,
    @Body() body: Record<string, unknown>,
  ) {
    // Whitelisted text fields: trimmed, empty → NULL (clears the value).
    const textFields = [
      "name",
      "legal_name",
      "kra_pin",
      "vat_number",
      "phone",
      "email",
      "postal_address",
      "physical_address",
      "invoice_footer",
      "invoice_prefix",
      "quote_prefix",
      "default_vat_rate",
    ];
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    for (const f of textFields) {
      if (body[f] === undefined) continue;
      const raw = body[f];
      if (raw !== null && typeof raw !== "string") {
        throw new BadRequestException(`${f} must be text`);
      }
      const trimmed = raw === null ? null : (raw as string).trim();
      if (f === "name" && !trimmed) {
        throw new BadRequestException("name cannot be blank");
      }
      sets.push(`${f} = $${i++}`);
      params.push(trimmed === "" ? null : trimmed);
    }

    if (body.currency !== undefined) {
      const cur = String(body.currency ?? "").trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(cur)) {
        throw new BadRequestException("currency must be a 3-letter ISO code");
      }
      sets.push(`currency = $${i++}`);
      params.push(cur);
    }

    if (body.fiscal_year_start_month !== undefined) {
      const m = Number(body.fiscal_year_start_month);
      if (!Number.isInteger(m) || m < 1 || m > 12) {
        throw new BadRequestException(
          "fiscal_year_start_month must be 1–12",
        );
      }
      sets.push(`fiscal_year_start_month = $${i++}`);
      params.push(m);
    }

    if (body.default_payment_terms_days !== undefined) {
      const d = Number(body.default_payment_terms_days);
      if (!Number.isInteger(d) || d < 0) {
        throw new BadRequestException(
          "default_payment_terms_days must be a non-negative integer",
        );
      }
      sets.push(`default_payment_terms_days = $${i++}`);
      params.push(d);
    }

    if (body.prices_vat_inclusive !== undefined) {
      if (typeof body.prices_vat_inclusive !== "boolean") {
        throw new BadRequestException("prices_vat_inclusive must be a boolean");
      }
      sets.push(`prices_vat_inclusive = $${i++}`);
      params.push(body.prices_vat_inclusive);
    }

    // Industry switchboard. businessType is validated against the 8 known
    // types; enabledModules must be a subset of the 7 optional keys (unknown
    // keys are rejected). Neither field ever branches app logic — they only
    // decide which optional modules the tenant sees.
    if (body.businessType !== undefined) {
      if (!isBusinessType(body.businessType)) {
        throw new BadRequestException(
          `businessType must be one of: ${BUSINESS_TYPE_KEYS.join(", ")}`,
        );
      }
      sets.push(`business_type = $${i++}`);
      params.push(body.businessType);
    }

    if (body.enabledModules !== undefined) {
      const mods = body.enabledModules;
      if (!Array.isArray(mods) || !mods.every(isOptionalModuleKey)) {
        throw new BadRequestException(
          "enabledModules must be an array of known optional module keys",
        );
      }
      // De-duplicate, preserving order.
      const unique = [...new Set(mods as string[])];
      sets.push(`enabled_modules = $${i++}`);
      params.push(unique);
    }

    if (body.logo !== undefined) {
      const logo = body.logo;
      if (logo !== null && typeof logo !== "string") {
        throw new BadRequestException("logo must be a data URL or null");
      }
      if (
        logo &&
        !logo.startsWith("data:image/") &&
        !logo.startsWith("data:application/")
      ) {
        throw new BadRequestException(
          "logo must be a data URL (data:image/...)",
        );
      }
      // Limit logo size to 500KB to prevent bloating the tenant row.
      if (logo && logo.length > 500 * 1024) {
        throw new BadRequestException("logo must be under 500KB");
      }
      sets.push(`logo = $${i++}`);
      params.push(logo || null);
    }

    if (sets.length === 0) {
      throw new BadRequestException("No editable fields provided");
    }

    params.push(claims.tid);
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `UPDATE tenants SET ${sets.join(", ")}
         WHERE id = $${i}
         RETURNING ${SettingsController.PROFILE_COLUMNS}`,
        params,
      );
      if (!res.rows[0]) throw new NotFoundException();
      await this.audit.record(client, {
        tenantId: claims.tid,
        actorUserId: claims.sub,
        action: "tenant.profile_updated",
        entityType: "tenant",
        entityId: claims.tid,
        payload: { fields: sets.map((s) => s.split(" = ")[0]) },
      });
      return res.rows[0];
    });
  }
}
