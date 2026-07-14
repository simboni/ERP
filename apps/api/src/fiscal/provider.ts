import { createHash } from "node:crypto";

/**
 * Country-pluggable fiscalization interface (04-architecture.md §5).
 * Kenya's OSCU/VSCU adapter, Tanzania VFD, Uganda EFRIS etc. all implement
 * this; the queue and domain code never know which country is behind it.
 */
export interface FiscalSignRequest {
  tenantId: string;
  branchId: string;
  docType: "invoice" | "credit_note";
  seq: number;
  payload: Record<string, unknown>;
}

export interface FiscalSignResult {
  controlNumber: string;
  qrPayload: string;
}

/** Retryable: network blips, KRA downtime. Backoff and try again. */
export class FiscalTransientError extends Error {}

/** Not retryable: the document itself is invalid. Goes to dead_letter. */
export class FiscalPermanentError extends Error {}

export interface FiscalProvider {
  sign(req: FiscalSignRequest): Promise<FiscalSignResult>;
}

/**
 * Deterministic sandbox provider for dev/test. The real KRA OSCU/VSCU
 * adapter replaces this behind the same interface once integrator
 * certification (roadmap Phase 0) grants production credentials.
 *
 * Test hooks: payload.simulate = "transient-fail" | "permanent-reject".
 */
export class SandboxFiscalProvider implements FiscalProvider {
  async sign(req: FiscalSignRequest): Promise<FiscalSignResult> {
    if (req.payload.simulate === "transient-fail") {
      throw new FiscalTransientError("sandbox: simulated KRA timeout");
    }
    if (req.payload.simulate === "permanent-reject") {
      throw new FiscalPermanentError("sandbox: simulated KRA rejection");
    }
    const digest = createHash("sha256")
      .update(req.tenantId)
      .update(req.branchId)
      .update(String(req.seq))
      .update(JSON.stringify(req.payload))
      .digest("hex");
    return {
      controlNumber: `SBX${String(req.seq).padStart(10, "0")}`,
      qrPayload: `https://etims-sbx.kra.go.ke/verify/${digest.slice(0, 24)}`,
    };
  }
}
