import { createHash } from "node:crypto";
import {
  PaymentProvider,
  StkPushRequest,
  StkPushResponse,
} from "./provider";

export interface DarajaConfig {
  baseUrl: string; // https://sandbox.safaricom.co.ke or production
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
  callbackUrl: string; // public HTTPS -> /webhooks/mpesa/stk
}

type FetchLike = typeof fetch;

/**
 * Safaricom Daraja adapter (02-kenya-compliance.md §4). Implements the
 * documented M-Pesa Express flow: OAuth client-credentials token (cached
 * until near expiry), then STK push with the timestamped
 * base64(shortcode+passkey+timestamp) password. Go-live swaps base URL and
 * credentials — the code path is identical for sandbox and production.
 * Amounts: Daraja takes whole KES; we validate cents divide cleanly.
 */
export class DarajaPaymentProvider implements PaymentProvider {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: DarajaConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) {
      return this.token.value;
    }
    const basic = Buffer.from(
      `${this.config.consumerKey}:${this.config.consumerSecret}`,
    ).toString("base64");
    const res = await this.fetchImpl(
      `${this.config.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      { headers: { Authorization: `Basic ${basic}` } },
    );
    if (!res.ok) {
      throw new Error(`Daraja OAuth failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      access_token: string;
      expires_in: string | number;
    };
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + Number(body.expires_in) * 1000,
    };
    return this.token.value;
  }

  /** yyyyMMddHHmmss in Nairobi time, per the Daraja spec. */
  static timestamp(now = new Date()): string {
    const nairobi = new Date(now.getTime() + 3 * 3600 * 1000);
    return nairobi.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  }

  async initiateStkPush(req: StkPushRequest): Promise<StkPushResponse> {
    if (req.amountCents % 100 !== 0) {
      throw new Error("Daraja STK amounts must be whole KES");
    }
    const token = await this.getToken();
    const timestamp = DarajaPaymentProvider.timestamp();
    const password = Buffer.from(
      `${this.config.shortcode}${this.config.passkey}${timestamp}`,
    ).toString("base64");
    const res = await this.fetchImpl(
      `${this.config.baseUrl}/mpesa/stkpush/v1/processrequest`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          BusinessShortCode: this.config.shortcode,
          Password: password,
          Timestamp: timestamp,
          TransactionType: "CustomerPayBillOnline",
          Amount: req.amountCents / 100,
          PartyA: req.msisdn,
          PartyB: this.config.shortcode,
          PhoneNumber: req.msisdn,
          CallBackURL: this.config.callbackUrl,
          AccountReference: req.accountRef.slice(0, 12),
          TransactionDesc: `Payment ${req.accountRef}`.slice(0, 13),
        }),
      },
    );
    const body = (await res.json().catch(() => ({}))) as {
      CheckoutRequestID?: string;
      ResponseCode?: string;
      errorMessage?: string;
    };
    if (!res.ok || body.ResponseCode !== "0" || !body.CheckoutRequestID) {
      throw new Error(
        `Daraja STK push rejected: ${body.errorMessage ?? `HTTP ${res.status}`}`,
      );
    }
    return { providerRef: body.CheckoutRequestID };
  }

  /** Deterministic idempotency helper for logging/tracing. */
  static requestFingerprint(req: StkPushRequest): string {
    return createHash("sha256")
      .update(req.tenantId)
      .update(req.msisdn)
      .update(String(req.amountCents))
      .update(req.accountRef)
      .digest("hex")
      .slice(0, 16);
  }
}
