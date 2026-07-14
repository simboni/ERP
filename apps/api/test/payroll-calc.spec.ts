/**
 * Payroll calculator unit tests. Expected values are hand-computed from the
 * verified July 2026 statutory figures (docs/research/02-kenya-compliance.md §2):
 * PAYE bands (since Jul 2023), NSSF Year 4 (Feb 2026: LEL 9,000 / UEL 108,000),
 * SHIF 2.75% min 300, AHL 1.5%+1.5%, TLAA-2024 deductibility.
 */
import {
  computePayroll,
  mulRate,
  PayrollRules,
} from "../src/payroll/calculator";

const PAYE = {
  bands: [
    { uptoCents: 2_400_000, rate: "0.10" },
    { uptoCents: 3_233_300, rate: "0.25" },
    { uptoCents: 50_000_000, rate: "0.30" },
    { uptoCents: 80_000_000, rate: "0.325" },
    { uptoCents: null, rate: "0.35" },
  ],
  personalReliefCents: 240_000,
  insuranceReliefRate: "0.15",
  insuranceReliefCapCents: 500_000,
  pensionDeductibleCapCents: 3_000_000,
};

const YEAR4: PayrollRules = {
  paye: PAYE,
  nssf: { rate: "0.06", lelCents: 900_000, uelCents: 10_800_000 },
  shif: { rate: "0.0275", minCents: 30_000 },
  ahl: { employeeRate: "0.015", employerRate: "0.015" },
  nitaPerEmployeeCents: 5_000,
};

const YEAR3: PayrollRules = {
  ...YEAR4,
  nssf: { rate: "0.06", lelCents: 800_000, uelCents: 7_200_000 },
};

describe("mulRate (integer money math)", () => {
  test("applies decimal-string rates exactly", () => {
    expect(mulRate(5_000_000, "0.0275")).toBe(137_500);
    expect(mulRate(833_300, "0.25")).toBe(208_325);
    expect(mulRate(100, "0.325")).toBe(33); // 32.5 rounds half up
    expect(mulRate(0, "0.35")).toBe(0);
  });
  test("rejects garbage rates", () => {
    expect(() => mulRate(100, "12,5")).toThrow();
    expect(() => mulRate(100, "")).toThrow();
  });
});

describe("computePayroll — KES 50,000 gross, Year 4 (from Feb 2026)", () => {
  const r = computePayroll(5_000_000, YEAR4);

  test("NSSF employee 3,000.00 (tier1 540 + tier2 2,460), employer matches", () => {
    expect(r.nssfEmployeeCents).toBe(300_000);
    expect(r.nssfEmployerCents).toBe(300_000);
  });
  test("SHIF 1,375.00", () => expect(r.shifCents).toBe(137_500));
  test("AHL 750.00 both sides", () => {
    expect(r.ahlEmployeeCents).toBe(75_000);
    expect(r.ahlEmployerCents).toBe(75_000);
  });
  test("taxable 44,875.00 (gross minus NSSF+SHIF+AHL)", () =>
    expect(r.taxableCents).toBe(4_487_500));
  test("PAYE 5,845.85 after personal relief", () =>
    expect(r.payeCents).toBe(584_585));
  test("net 39,029.15", () => expect(r.netCents).toBe(3_902_915));
  test("NITA 50.00 employer-borne", () =>
    expect(r.nitaEmployerCents).toBe(5_000));
});

describe("computePayroll — low earner KES 20,000, Year 4", () => {
  const r = computePayroll(2_000_000, YEAR4);
  test("NSSF 1,200.00", () => expect(r.nssfEmployeeCents).toBe(120_000));
  test("SHIF 550.00 (above the 300 floor)", () =>
    expect(r.shifCents).toBe(55_000));
  test("PAYE zero: relief exceeds band tax", () => expect(r.payeCents).toBe(0));
  test("net 17,950.00", () => expect(r.netCents).toBe(1_795_000));
});

describe("SHIF minimum floor", () => {
  test("KES 8,000 gross pays the 300 minimum, not 220", () => {
    const r = computePayroll(800_000, YEAR4);
    expect(r.shifCents).toBe(30_000);
  });
});

describe("NSSF year boundary — KES 150,000 gross (above both UELs)", () => {
  test("Year 3 caps at 4,320.00 (UEL 72,000)", () => {
    const r = computePayroll(15_000_000, YEAR3);
    expect(r.nssfEmployeeCents).toBe(432_000);
  });
  test("Year 4 caps at 6,480.00 (UEL 108,000) — the verified Feb 2026 max", () => {
    const r = computePayroll(15_000_000, YEAR4);
    expect(r.nssfEmployeeCents).toBe(648_000);
  });
});

describe("high earner hits upper bands", () => {
  test("KES 900,000 gross reaches the 32.5% and 35% bands", () => {
    const r = computePayroll(90_000_000, YEAR4);
    // NSSF capped 6,480; SHIF 24,750; AHL 13,500. NSSF deductible capped
    // at 30,000/month (648_000 < 3_000_000, uncapped here).
    expect(r.taxableCents).toBe(
      90_000_000 - 648_000 - 2_475_000 - 1_350_000,
    );
    expect(r.payeCents).toBeGreaterThan(0);
    // Marginal rate sanity: adding 1,000.00 of gross at this level is taxed
    // at 35% of the taxable increase.
    const r2 = computePayroll(90_100_000, YEAR4);
    const taxableDelta = r2.taxableCents - r.taxableCents;
    expect(r2.payeCents - r.payeCents).toBe(mulRate(taxableDelta, "0.35"));
  });
});

describe("insurance relief", () => {
  test("15% of premiums reduces PAYE, capped at 5,000/month", () => {
    const base = computePayroll(5_000_000, YEAR4);
    const withIns = computePayroll(5_000_000, YEAR4, 1_000_000); // 10k premiums
    expect(base.payeCents - withIns.payeCents).toBe(150_000);
    const capped = computePayroll(5_000_000, YEAR4, 100_000_000);
    expect(base.payeCents - capped.payeCents).toBe(500_000);
  });
});

describe("guards", () => {
  test("rejects negative and fractional gross", () => {
    expect(() => computePayroll(-1, YEAR4)).toThrow();
    expect(() => computePayroll(10.5, YEAR4)).toThrow();
  });
});
