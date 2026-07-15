import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { ProjectsService } from "./projects.service";

const PROJECT_ROLES = ["owner", "admin", "accountant"] as const;

/**
 * Project Operations endpoints: project CRUD, time entries and expenses
 * (editable until billed), a profitability rollup, and one-click billing
 * of unbilled work into a draft invoice.
 */
@Controller("tenants/current")
@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)
export class ProjectsController {
  constructor(
    private readonly db: DbService,
    private readonly projects: ProjectsService,
  ) {}

  // ---- Projects ----------------------------------------------------------

  @Get("projects")
  async list(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.projects.listProjects(client),
    );
  }

  @Get("projects/:id")
  async get(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) projectId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.projects.getProject(client, projectId),
    );
  }

  @Post("projects")
  @Roles(...PROJECT_ROLES)
  async create(
    @TenantClaims() claims: TenantTokenClaims,
    @Body()
    body: {
      name?: string;
      customerId?: string | null;
      budgetCents?: number | null;
      hourlyRateCents?: number | null;
    },
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.projects.createProject(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        name: body?.name ?? "",
        customerId: body?.customerId,
        budgetCents: body?.budgetCents,
        hourlyRateCents: body?.hourlyRateCents,
      }),
    );
  }

  @Patch("projects/:id")
  @Roles(...PROJECT_ROLES)
  async update(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) projectId: string,
    @Body()
    body: {
      name?: string;
      customerId?: string | null;
      status?: string;
      budgetCents?: number | null;
      hourlyRateCents?: number | null;
    },
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.projects.updateProject(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        projectId,
        name: body?.name,
        customerId: body?.customerId,
        status: body?.status,
        budgetCents: body?.budgetCents,
        hourlyRateCents: body?.hourlyRateCents,
      }),
    );
  }

  @Delete("projects/:id")
  @Roles(...PROJECT_ROLES)
  async remove(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) projectId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.projects.deleteProject(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        projectId,
      }),
    );
  }

  // ---- Time entries ------------------------------------------------------

  @Get("projects/:id/time")
  async listTime(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) projectId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.projects.listTime(client, projectId),
    );
  }

  @Post("projects/:id/time")
  @Roles(...PROJECT_ROLES)
  async addTime(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) projectId: string,
    @Body()
    body: {
      entryDate?: string;
      hours?: number;
      note?: string;
      billable?: boolean;
      employeeId?: string | null;
    },
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.projects.addTime(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        projectId,
        entryDate: body?.entryDate ?? "",
        hours: body?.hours as number,
        note: body?.note,
        billable: body?.billable,
        employeeId: body?.employeeId,
      }),
    );
  }

  @Patch("projects/:id/time/:entryId")
  @Roles(...PROJECT_ROLES)
  async updateTime(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) projectId: string,
    @Param("entryId", ParseUUIDPipe) entryId: string,
    @Body()
    body: {
      entryDate?: string;
      hours?: number;
      note?: string;
      billable?: boolean;
      employeeId?: string | null;
    },
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.projects.updateTime(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        projectId,
        entryId,
        entryDate: body?.entryDate,
        hours: body?.hours,
        note: body?.note,
        billable: body?.billable,
        employeeId: body?.employeeId,
      }),
    );
  }

  @Delete("projects/:id/time/:entryId")
  @Roles(...PROJECT_ROLES)
  async deleteTime(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) projectId: string,
    @Param("entryId", ParseUUIDPipe) entryId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.projects.deleteTime(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        projectId,
        entryId,
      }),
    );
  }

  // ---- Expenses ----------------------------------------------------------

  @Get("projects/:id/expenses")
  async listExpenses(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) projectId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.projects.listExpenses(client, projectId),
    );
  }

  @Post("projects/:id/expenses")
  @Roles(...PROJECT_ROLES)
  async addExpense(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) projectId: string,
    @Body()
    body: {
      expenseDate?: string;
      description?: string;
      amountCents?: number;
      billable?: boolean;
    },
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.projects.addExpense(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        projectId,
        expenseDate: body?.expenseDate ?? "",
        description: body?.description ?? "",
        amountCents: body?.amountCents as number,
        billable: body?.billable,
      }),
    );
  }

  @Patch("projects/:id/expenses/:expenseId")
  @Roles(...PROJECT_ROLES)
  async updateExpense(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) projectId: string,
    @Param("expenseId", ParseUUIDPipe) expenseId: string,
    @Body()
    body: {
      expenseDate?: string;
      description?: string;
      amountCents?: number;
      billable?: boolean;
    },
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.projects.updateExpense(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        projectId,
        expenseId,
        expenseDate: body?.expenseDate,
        description: body?.description,
        amountCents: body?.amountCents,
        billable: body?.billable,
      }),
    );
  }

  @Delete("projects/:id/expenses/:expenseId")
  @Roles(...PROJECT_ROLES)
  async deleteExpense(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) projectId: string,
    @Param("expenseId", ParseUUIDPipe) expenseId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.projects.deleteExpense(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        projectId,
        expenseId,
      }),
    );
  }

  // ---- Profitability & billing --------------------------------------------

  @Get("projects/:id/profitability")
  @Roles(...PROJECT_ROLES)
  async profitability(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) projectId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.projects.profitability(client, projectId),
    );
  }

  @Post("projects/:id/bill")
  @Roles(...PROJECT_ROLES)
  @HttpCode(200)
  async bill(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) projectId: string,
    @Body() body: { branchId?: string; dueDate?: string },
  ) {
    return this.db.withTenant(claims.tid, claims.sub, (client) =>
      this.projects.billUnbilled(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        projectId,
        branchId: body?.branchId ?? "",
        dueDate: body?.dueDate,
      }),
    );
  }
}
