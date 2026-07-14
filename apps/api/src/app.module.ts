import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuditService } from "./audit/audit.service";
import { AuthController } from "./auth/auth.controller";
import { AuthService } from "./auth/auth.service";
import { ComplianceController } from "./compliance/compliance.controller";
import { ComplianceService } from "./compliance/compliance.service";
import { loadConfig } from "./config";
import { DbService } from "./db/db.service";
import { FiscalController } from "./fiscal/fiscal.controller";
import { FISCAL_PROVIDER, FiscalService } from "./fiscal/fiscal.service";
import { EtimsOscuProvider } from "./fiscal/oscu.provider";
import { SandboxFiscalProvider } from "./fiscal/provider";
import { DarajaPaymentProvider } from "./payments/daraja.provider";
import { HealthController } from "./health.controller";
import { InvoicesController } from "./invoicing/invoices.controller";
import { InvoicesService } from "./invoicing/invoices.service";
import { LedgerService } from "./ledger/ledger.service";
import {
  MpesaWebhookController,
  PaymentsController,
} from "./payments/payments.controller";
import { PAYMENT_PROVIDER, PaymentsService } from "./payments/payments.service";
import {
  PAYOUT_PROVIDER,
  SandboxPayoutProvider,
} from "./payments/payout.provider";
import { SandboxPaymentProvider } from "./payments/provider";
import { PayrollController } from "./payroll/payroll.controller";
import { PayrollService } from "./payroll/payroll.service";
import { BillsController } from "./purchases/bills.controller";
import { BillsService } from "./purchases/bills.service";
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
    InvoicesController,
    PaymentsController,
    MpesaWebhookController,
    PayrollController,
    ComplianceController,
    BillsController,
    HealthController,
  ],
  providers: [
    DbService,
    AuthService,
    AuditService,
    RulesService,
    FiscalService,
    LedgerService,
    InvoicesService,
    PaymentsService,
    PayrollService,
    ComplianceService,
    BillsService,
    { provide: PAYOUT_PROVIDER, useClass: SandboxPayoutProvider },
    // Provider selection is configuration: sandbox by default; the
    // production adapters activate via env once Phase-0 credentials exist.
    {
      provide: PAYMENT_PROVIDER,
      useFactory: () =>
        process.env.PAYMENT_PROVIDER === "daraja"
          ? new DarajaPaymentProvider({
              baseUrl:
                process.env.DARAJA_BASE_URL ?? "https://sandbox.safaricom.co.ke",
              consumerKey: process.env.DARAJA_CONSUMER_KEY ?? "",
              consumerSecret: process.env.DARAJA_CONSUMER_SECRET ?? "",
              shortcode: process.env.DARAJA_SHORTCODE ?? "",
              passkey: process.env.DARAJA_PASSKEY ?? "",
              callbackUrl: process.env.DARAJA_STK_CALLBACK_URL ?? "",
            })
          : new SandboxPaymentProvider(),
    },
    {
      provide: FISCAL_PROVIDER,
      useFactory: () =>
        process.env.FISCAL_PROVIDER === "oscu"
          ? new EtimsOscuProvider({
              baseUrl: process.env.OSCU_BASE_URL ?? "",
              tin: process.env.OSCU_TIN ?? "",
              bhfId: process.env.OSCU_BHF_ID ?? "00",
              cmcKey: process.env.OSCU_CMC_KEY ?? "",
            })
          : new SandboxFiscalProvider(),
    },
  ],
})
export class AppModule {}
