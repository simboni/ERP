import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
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
import type { InvoiceLineInput } from "../invoicing/invoices.service";
import { BudgetInput, FinanceService } from "./finance.service";

const FINANCE_ROLES = ["owner", "admin", "accountant"] as const;
const YEAR_RE = /^\d{4}$/;

function requireYear(value: string | undefined): number {
  const year = value ?? String(new Date().getUTCFullYear());
  if (!YEAR_RE.test(year)) {
    throw new BadRequestException("year must be YYYY");
  }
  return Number(year);
}

/**
 * Finance+ endpoints: budgets (planning rows + budget-vs-actual off the
 * journal), fixed assets with a straight-line depreciation run, and
 * recurring invoice templates with a manual run that drafts invoices.
 */
@Controller("tenants/current")
@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)
export class FinanceController {
  constructor(
    private readonly db: DbService,
    private readonly finance: FinanceService,
  ) {}

  // ---- Budgets -----------------------------------------------------------

  @Get("budgets")
  @Roles(...FINANCE_ROLES)
  async listBudgets(
    @TenantClaims() claims: TenantTokenClaims,
    @Query("year") year?: string,
  ) {
    const y = requireYear(year);
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.finance.listBudgets(client, y),
    );
  }

  @Post("budgets")
  @Roles(...FINANCE_ROLES)
  async upsertBudgets(
    @TenantClaims() claims: TenantTokenClaims,
    @Body() body: { entries?: BudgetInput[] },
  ) {
    if (!Array.isArray(body?.entries)) {
      throw new BadRequestException("entries array is required");
    }
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.finance.upsertBudgets(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        entries: body.entries!,
      }),
    );
  }

  @Delete("budgets/:id")
  @Roles(...FINANCE_ROLES)
  async deleteBudget(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) budgetId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.finance.deleteBudget(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        budgetId,
      }),
    );
  }

  @Get("budget-vs-actual")
  @Roles(...FINANCE_ROLES)
  async budgetVsActual(
    @TenantClaims() claims: TenantTokenClaims,
    @Query("year") year?: string,
  ) {
    const y = requireYear(year);
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.finance.budgetVsActual(client, y),
    );
  }

  // ---- Fixed assets ------------------------------------------------------

  @Get("fixed-assets")
  @Roles(...FINANCE_ROLES)
  async listAssets(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.finance.listAssets(client),
    );
  }

  @Post("fixed-assets")
  @Roles(...FINANCE_ROLES)
  async createAsset(
    @TenantClaims() claims: TenantTokenClaims,
    @Body()
    body: {
      name?: string;
      costCents?: number;
      salvageCents?: number;
      acquiredDate?: string;
      usefulLifeMonths?: number;
    },
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.finance.createAsset(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        name: body?.name ?? "",
        costCents: body?.costCents as number,
        salvageCents: body?.salvageCents,
        acquiredDate: body?.acquiredDate ?? "",
        usefulLifeMonths: body?.usefulLifeMonths as number,
      }),
    );
  }

  @Post("fixed-assets/run-depreciation")
  @Roles(...FINANCE_ROLES)
  @HttpCode(200)
  async runDepreciation(
    @TenantClaims() claims: TenantTokenClaims,
    @Body() body: { period?: string },
  ) {
    const period = body?.period ?? new Date().toISOString().slice(0, 7);
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.finance.runDepreciation(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        period,
      }),
    );
  }

  @Patch("fixed-assets/:id")
  @Roles(...FINANCE_ROLES)
  async updateAsset(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) assetId: string,
    @Body() body: { name?: string; disposed?: boolean },
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.finance.updateAsset(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        assetId,
        name: body?.name,
        disposed: body?.disposed,
      }),
    );
  }

  @Delete("fixed-assets/:id")
  @Roles(...FINANCE_ROLES)
  async deleteAsset(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) assetId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.finance.deleteAsset(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        assetId,
      }),
    );
  }

  // ---- Recurring invoice templates ---------------------------------------

  @Get("recurring")
  @Roles(...FINANCE_ROLES)
  async listTemplates(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.finance.listTemplates(client),
    );
  }

  @Post("recurring/run")
  @Roles(...FINANCE_ROLES)
  @HttpCode(200)
  async runRecurring(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.finance.runRecurring(client, {
        tenantId: claims.tid,
        userId: claims.sub,
      }),
    );
  }

  @Post("recurring")
  @Roles(...FINANCE_ROLES)
  async createTemplate(
    @TenantClaims() claims: TenantTokenClaims,
    @Body()
    body: {
      customerId?: string;
      branchId?: string;
      nextRunDate?: string;
      lines?: InvoiceLineInput[];
    },
  ) {
    if (!body?.customerId || !body?.branchId || !Array.isArray(body?.lines)) {
      throw new BadRequestException(
        "customerId, branchId and lines are required",
      );
    }
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.finance.createTemplate(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        customerId: body.customerId!,
        branchId: body.branchId!,
        nextRunDate: body.nextRunDate ?? "",
        lines: body.lines!,
      }),
    );
  }

  @Patch("recurring/:id")
  @Roles(...FINANCE_ROLES)
  async updateTemplate(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) templateId: string,
    @Body()
    body: { active?: boolean; nextRunDate?: string; lines?: InvoiceLineInput[] },
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.finance.updateTemplate(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        templateId,
        active: body?.active,
        nextRunDate: body?.nextRunDate,
        lines: body?.lines,
      }),
    );
  }

  @Delete("recurring/:id")
  @Roles(...FINANCE_ROLES)
  async deleteTemplate(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) templateId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.finance.deleteTemplate(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        templateId,
      }),
    );
  }
}
