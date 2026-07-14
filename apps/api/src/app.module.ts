import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuditService } from "./audit/audit.service";
import { AuthController } from "./auth/auth.controller";
import { AuthService } from "./auth/auth.service";
import { loadConfig } from "./config";
import { DbService } from "./db/db.service";
import { FiscalController } from "./fiscal/fiscal.controller";
import { FISCAL_PROVIDER, FiscalService } from "./fiscal/fiscal.service";
import { SandboxFiscalProvider } from "./fiscal/provider";
import { HealthController } from "./health.controller";
import { RulesService } from "./rules/rules.service";
import { TenantsController } from "./tenants/tenants.controller";

@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: loadConfig().jwtSecret,
      signOptions: { expiresIn: loadConfig().accessTokenTtlSec },
    }),
  ],
  controllers: [
    AuthController,
    TenantsController,
    FiscalController,
    HealthController,
  ],
  providers: [
    DbService,
    AuthService,
    AuditService,
    RulesService,
    FiscalService,
    // Swapped for the real KRA OSCU/VSCU adapter once integrator
    // certification grants credentials (roadmap Phase 0).
    { provide: FISCAL_PROVIDER, useClass: SandboxFiscalProvider },
  ],
})
export class AppModule {}
