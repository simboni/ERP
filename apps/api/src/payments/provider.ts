import { createHash } from "node:crypto";

/**
 * Payment rail abstraction. The real Daraja adapter (OAuth token cache,
 * STK push, Transaction Status, B2C) replaces the sandbox behind this
 * interface at Safaricom go-live; aggregator adapters (cards) join later.
 */
export interface StkPushRequest {
  tenantId: string;
  amountCents: number;
  msisdn: string;
  accountRef: string;
}

export interface StkPushResponse {
  providerRef: string; // CheckoutRequestID
}

export interface PaymentProvider {
  initiateStkPush(req: StkPushRequest): Promise<StkPushResponse>;
}

export class SandboxPaymentProvider implements PaymentProvider {
  async initiateStkPush(req: StkPushRequest): Promise<StkPushResponse> {
    const digest = createHash("sha256")
      .update(req.tenantId)
      .update(req.msisdn)
      .update(req.accountRef)
      .update(String(req.amountCents))
      .digest("hex");
    return { providerRef: `ws_CO_SBX_${digest.slice(0, 20)}` };
  }
}
