import {
  FiscalPermanentError,
  FiscalProvider,
  FiscalSignRequest,
  FiscalSignResult,
  FiscalTransientError,
} from "./provider";

export interface OscuConfig {
  baseUrl: string; // KRA eTIMS OSCU endpoint (sandbox at certification)
  tin: string; // seller KRA PIN
  bhfId: string; // branch office id registered with KRA
  cmcKey: string; // communication key issued at device initialization
}

type FetchLike = typeof fetch;

/**
 * KRA eTIMS OSCU adapter SHELL (02-kenya-compliance.md §1.2).
 *
 * The exact request/response contract is distributed through the KRA
 * integrator portal after sandbox onboarding; this shell implements the
 * publicly documented shape (trnsSales save with tin/bhfId/cmcKey headers,
 * receipt signature + internal data in the response) so certification work
 * is contract-mapping against a live sandbox, not new architecture. Every
 * field mapping below MUST be validated against the official spec during
 * Phase 0 certification before production use.
 */
export class EtimsOscuProvider implements FiscalProvider {
  constructor(
    private readonly config: OscuConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async sign(req: FiscalSignRequest): Promise<FiscalSignResult> {
    const payload = req.payload as {
      issueDate?: string;
      buyer?: { name?: string; kra_pin?: string } | null;
      subtotalCents?: number;
      vatCents?: number;
      totalCents?: number;
      lines?: unknown[];
    };
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.baseUrl}/trnsSales/saveSales`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          tin: this.config.tin,
          bhfId: this.config.bhfId,
          cmcKey: this.config.cmcKey,
        },
        body: JSON.stringify({
          invcNo: req.seq,
          rcptTyCd: req.docType === "invoice" ? "S" : "R", // sale / refund
          custTin: payload.buyer?.kra_pin ?? null,
          custNm: payload.buyer?.name ?? null,
          salesDt: (payload.issueDate ?? "").replace(/-/g, ""),
          totTaxblAmt: (payload.subtotalCents ?? 0) / 100,
          totTaxAmt: (payload.vatCents ?? 0) / 100,
          totAmt: (payload.totalCents ?? 0) / 100,
          itemCnt: payload.lines?.length ?? 0,
        }),
      });
    } catch (err) {
      throw new FiscalTransientError(
        `OSCU unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.status >= 500) {
      throw new FiscalTransientError(`OSCU HTTP ${res.status}`);
    }
    const body = (await res.json().catch(() => ({}))) as {
      resultCd?: string;
      resultMsg?: string;
      data?: { rcptNo?: string | number; intrlData?: string; rcptSign?: string };
    };
    if (body.resultCd !== "000" || !body.data?.rcptSign) {
      throw new FiscalPermanentError(
        `OSCU rejected document: ${body.resultMsg ?? "unknown error"} (${body.resultCd ?? "?"})`,
      );
    }
    return {
      controlNumber: String(body.data.rcptNo ?? body.data.rcptSign),
      qrPayload: `https://etims.kra.go.ke/common/link/etims/receipt/indexEtimsReceiptData?Data=${this.config.tin}${this.config.bhfId}${body.data.intrlData ?? body.data.rcptSign}`,
    };
  }
}
