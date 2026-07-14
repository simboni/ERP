/**
 * 2FA + rate limiting tests: TOTP primitives (RFC 6238 vectors), full
 * enrolment + MFA-gated login over HTTP, and the auth rate limiter.
 */
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import request from "supertest";
import {
  base32Decode,
  base32Encode,
  totpCode,
  verifyTotp,
} from "../src/auth/totp";
import { resetRateLimits } from "../src/auth/rate-limit.guard";

process.env.APP_DB_URL =
  process.env.APP_DB_URL_TEST ??
  "postgres://jenga_app:app_dev_pw@localhost:5432/jenga_test";
process.env.WORKER_DB_URL =
  process.env.WORKER_DB_URL_TEST ??
  "postgres://jenga_worker:worker_dev_pw@localhost:5432/jenga_test";

import { AppModule } from "../src/app.module";

describe("TOTP primitives", () => {
  test("RFC 6238 SHA-1 test vector (secret '12345678901234567890')", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    // T = 59s -> step 1 -> expected 287082 (RFC 6238 Appendix B).
    expect(totpCode(secret, 1)).toBe("287082");
    // T = 1111111109 -> step 37037036 -> expected 081804.
    expect(totpCode(secret, 37037036)).toBe("081804");
  });

  test("base32 round-trip and drift-tolerant verify", () => {
    const raw = Buffer.from("jenga-erp-2fa-secret");
    const enc = base32Encode(raw);
    expect(base32Decode(enc).equals(raw)).toBe(true);

    const secret = base32Encode(Buffer.from("12345678901234567890"));
    const now = 1_111_111_090_000;
    const code = totpCode(secret, Math.floor(now / 30_000));
    expect(verifyTotp(secret, code, now)).toBe(true);
    expect(verifyTotp(secret, code, now + 30_000)).toBe(true); // ±1 drift
    expect(verifyTotp(secret, code, now + 90_000)).toBe(false);
    expect(verifyTotp(secret, "abc123", now)).toBe(false);
  });
});

describe("MFA flow + rate limiting (HTTP)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  const suffix = randomUUID().slice(0, 8);
  const email = `mfa-${suffix}@test.local`;
  const password = "a-strong-password";
  let userToken: string;
  let secret: string;

  beforeAll(async () => {
    resetRateLimits();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    http = app.getHttpServer();

    await request(http).post("/auth/signup").send({
      email,
      password,
      fullName: "MFA Tester",
      tenantName: "MFA Traders",
      tenantSlug: `mfa-traders-${suffix}`,
    });
    const login = await request(http)
      .post("/auth/login")
      .send({ email, password });
    userToken = login.body.accessToken;
  });

  afterAll(async () => {
    resetRateLimits();
    await app.close();
  });

  test("enrolment: setup -> enable with a live code -> login demands MFA", async () => {
    const setup = await request(http)
      .post("/auth/totp/setup")
      .set("Authorization", `Bearer ${userToken}`);
    expect(setup.status).toBe(201);
    secret = setup.body.secret;
    expect(setup.body.otpauth).toContain("otpauth://totp/JengaERP");

    const wrong = await request(http)
      .post("/auth/totp/enable")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ code: "000000" });
    expect(wrong.status).toBe(401);

    const code = totpCode(secret, Math.floor(Date.now() / 30_000));
    const enable = await request(http)
      .post("/auth/totp/enable")
      .set("Authorization", `Bearer ${userToken}`)
      .send({ code });
    expect(enable.status).toBe(201);

    // Login now returns an MFA challenge, not tokens.
    const challenge = await request(http)
      .post("/auth/login")
      .send({ email, password });
    expect(challenge.status).toBe(200);
    expect(challenge.body.mfaRequired).toBe(true);
    expect(challenge.body.accessToken).toBeUndefined();

    const bad = await request(http)
      .post("/auth/totp/verify")
      .send({ mfaToken: challenge.body.mfaToken, code: "111111" });
    expect(bad.status).toBe(401);

    const good = await request(http)
      .post("/auth/totp/verify")
      .send({
        mfaToken: challenge.body.mfaToken,
        code: totpCode(secret, Math.floor(Date.now() / 30_000)),
      });
    expect(good.status).toBe(200);
    expect(good.body.accessToken).toBeTruthy();
    expect(good.body.refreshToken).toBeTruthy();
  });

  test("a user token cannot be used as an MFA token", async () => {
    const res = await request(http)
      .post("/auth/totp/verify")
      .send({
        mfaToken: userToken,
        code: totpCode(secret, Math.floor(Date.now() / 30_000)),
      });
    expect(res.status).toBe(401);
  });

  test("login attempts are rate limited per IP+email", async () => {
    const victim = `bruteforce-${suffix}@test.local`;
    let limited = false;
    for (let i = 0; i < 12; i++) {
      const res = await request(http)
        .post("/auth/login")
        .send({ email: victim, password: `guess-${i}-long-enough` });
      if (res.status === 429) {
        limited = true;
        expect(i).toBeGreaterThanOrEqual(10);
        break;
      }
      expect(res.status).toBe(401);
    }
    expect(limited).toBe(true);

    // A different account is unaffected by the victim's bucket:
    // it gets a normal 401 (bad password), not a 429.
    const other = await request(http)
      .post("/auth/login")
      .send({ email, password: "wrong-but-not-limited" });
    expect(other.status).toBe(401);
  });
});
