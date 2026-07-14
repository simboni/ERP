import { createHash } from "node:crypto";

/**
 * Outbound money rail (B2C salaries/refunds, supplier disbursements).
 * The production Daraja B2C adapter additionally requires the initiator
 * SecurityCredential (RSA-encrypted with Safaricom's production cert) and
 * result/timeout callback URLs — wired when go-live credentials exist.
 */
export interface PayoutRequest {
  tenantId: string;
  amountCents: number;
  msisdn: string;
  remarks: string;
}

export interface PayoutResponse {
  providerRef: string; // ConversationID
}

export const PAYOUT_PROVIDER = "PAYOUT_PROVIDER";

export interface PayoutProvider {
  sendB2C(req: PayoutRequest): Promise<PayoutResponse>;
}

export class SandboxPayoutProvider implements PayoutProvider {
  async sendB2C(req: PayoutRequest): Promise<PayoutResponse> {
    if (req.amountCents % 100 !== 0) {
      throw new Error("B2C amounts must be whole KES");
    }
    const digest = createHash("sha256")
      .update(req.tenantId)
      .update(req.msisdn)
      .update(String(req.amountCents))
      .update(req.remarks)
      .digest("hex");
    return { providerRef: `AG_SBX_${digest.slice(0, 20)}` };
  }
}
