/**
 * Kenya statutory payroll calculator — pure functions over resolved rule
 * payloads (see db/migrations/0002 seeds, verified July 2026).
 *
 * All money is integer CENTS. Rates arrive as decimal strings and are
 * applied with integer arithmetic (round half up) — no floating point on
 * money paths, ever (04-architecture.md §4).
 */

export interface PayeRules {
  bands: { uptoCents: number | null; rate: string }[];
  personalReliefCents: number;
  insuranceReliefRate: string;
  insuranceReliefCapCents: number;
  pensionDeductibleCapCents: number;
}

export interface NssfRules {
  rate: string;
  lelCents: number;
  uelCents: number;
}

export interface ShifRules {
  rate: string;
  minCents: number;
}

export interface AhlRules {
  employeeRate: string;
  employerRate: string;
}

export interface PayrollRules {
  paye: PayeRules;
  nssf: NssfRules;
  shif: ShifRules;
  ahl: AhlRules;
  nitaPerEmployeeCents: number;
}

export interface PayrollResult {
  grossCents: number;
  nssfEmployeeCents: number;
  nssfEmployerCents: number;
  shifCents: number;
  ahlEmployeeCents: number;
  ahlEmployerCents: number;
  nitaEmployerCents: number;
  taxableCents: number;
  payeCents: number;
  netCents: number;
}

/** cents * decimal-string rate with integer math, round half up. */
export function mulRate(cents: number, rate: string): number {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(rate);
  if (!m) throw new Error(`Invalid rate: ${rate}`);
  const frac = m[2] ?? "";
  const scale = 10n ** BigInt(frac.length);
  const num = BigInt(m[1] + frac);
  const product = BigInt(cents) * num;
  const rounded = (product + scale / 2n) / scale;
  return Number(rounded);
}

export function computeNssfEmployee(
  grossCents: number,
  nssf: NssfRules,
): number {
  const pensionable = Math.min(grossCents, nssf.uelCents);
  const tier1 = mulRate(Math.min(pensionable, nssf.lelCents), nssf.rate);
  const tier2 = mulRate(Math.max(0, pensionable - nssf.lelCents), nssf.rate);
  return tier1 + tier2;
}

export function computeShif(grossCents: number, shif: ShifRules): number {
  return Math.max(mulRate(grossCents, shif.rate), shif.minCents);
}

export function computePayeOnTaxable(
  taxableCents: number,
  paye: PayeRules,
  insurancePremiumsCents = 0,
): number {
  let tax = 0;
  let lower = 0;
  for (const band of paye.bands) {
    const upper = band.uptoCents ?? Number.MAX_SAFE_INTEGER;
    if (taxableCents <= lower) break;
    const inBand = Math.min(taxableCents, upper) - lower;
    tax += mulRate(inBand, band.rate);
    lower = upper;
  }
  const insuranceRelief = Math.min(
    mulRate(insurancePremiumsCents, paye.insuranceReliefRate),
    paye.insuranceReliefCapCents,
  );
  return Math.max(0, tax - paye.personalReliefCents - insuranceRelief);
}

/**
 * Full monthly statutory computation, post-TLAA-2024 semantics
 * (effective 27 Dec 2024): NSSF (capped by the pension deductible limit),
 * SHIF and AHL are deducted from gross to reach taxable income.
 */
export function computePayroll(
  grossCents: number,
  rules: PayrollRules,
  insurancePremiumsCents = 0,
): PayrollResult {
  if (!Number.isInteger(grossCents) || grossCents < 0) {
    throw new Error("grossCents must be a non-negative integer");
  }
  const nssfEmployeeCents = computeNssfEmployee(grossCents, rules.nssf);
  const nssfEmployerCents = nssfEmployeeCents; // employer matches
  const shifCents = computeShif(grossCents, rules.shif);
  const ahlEmployeeCents = mulRate(grossCents, rules.ahl.employeeRate);
  const ahlEmployerCents = mulRate(grossCents, rules.ahl.employerRate);

  const deductibleNssf = Math.min(
    nssfEmployeeCents,
    rules.paye.pensionDeductibleCapCents,
  );
  const taxableCents = Math.max(
    0,
    grossCents - deductibleNssf - shifCents - ahlEmployeeCents,
  );
  const payeCents = computePayeOnTaxable(
    taxableCents,
    rules.paye,
    insurancePremiumsCents,
  );
  const netCents =
    grossCents - nssfEmployeeCents - shifCents - ahlEmployeeCents - payeCents;

  return {
    grossCents,
    nssfEmployeeCents,
    nssfEmployerCents,
    shifCents,
    ahlEmployeeCents,
    ahlEmployerCents,
    nitaEmployerCents: rules.nitaPerEmployeeCents,
    taxableCents,
    payeCents,
    netCents,
  };
}
