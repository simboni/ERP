import {
  Controller,
  Get,
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
import { ComplianceService } from "./compliance.service";

@Controller("tenants/current/compliance")
@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)
export class ComplianceController {
  constructor(
    private readonly db: DbService,
    private readonly compliance: ComplianceService,
  ) {}

  @Get("vat-return")
  @Roles("owner", "admin", "accountant")
  async vatReturn(
    @TenantClaims() claims: TenantTokenClaims,
    @Query("period") period: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.compliance.vatReturnDraft(client, period ?? ""),
    );
  }

  @Get("deadlines")
  async deadlines() {
    return this.compliance.deadlines(new Date());
  }
}
