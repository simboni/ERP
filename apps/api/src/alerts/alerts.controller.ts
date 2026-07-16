import { Controller, Get, UseGuards } from "@nestjs/common";
import {
  JwtAuthGuard,
  TenantContextGuard,
  TenantClaims,
} from "../auth/guards";
import { AlertsService, type AlertFeed } from "./alerts.service";
import type { TenantTokenClaims } from "@jenga/shared";

@Controller("alerts")
@UseGuards(JwtAuthGuard, TenantContextGuard)
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  async feed(@TenantClaims() claims: TenantTokenClaims): Promise<AlertFeed> {
    return this.alerts.getFeed(claims);
  }
}
