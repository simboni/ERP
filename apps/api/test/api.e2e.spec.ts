/**
 * End-to-end API tests: signup -> login -> tenant selection -> RBAC ->
 * cross-tenant denial through the HTTP surface, against jenga_test.
 */
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import request from "supertest";

process.env.APP_DB_URL =
  process.env.APP_DB_URL_TEST ??
  "postgres://jenga_app:app_dev_pw@localhost:5432/jenga_test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
import { AppModule } from "../src/app.module";

describe("API e2e", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  const suffix = randomUUID().slice(0, 8);

  const alice = {
    email: `alice-${suffix}@test.local`,
    password: "correct-horse-battery",
    fullName: "Alice Owner",
    tenantName: "Alice Traders",
    tenantSlug: `alice-traders-${suffix}`,
  };
  const bob = {
    email: `bob-${suffix}@test.local`,
    password: "another-strong-pass",
    fullName: "Bob Owner",
    tenantName: "Bob Supplies",
    tenantSlug: `bob-supplies-${suffix}`,
  };

  let aliceTenantId: string;
  let bobTenantId: string;
  let aliceUserToken: string;
  let aliceTenantToken: string;
  let bobUserToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    http = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  test("signup two workspaces", async () => {
    const resA = await request(http).post("/auth/signup").send(alice);
    expect(resA.status).toBe(201);
    aliceTenantId = resA.body.tenantId;

    const resB = await request(http).post("/auth/signup").send(bob);
    expect(resB.status).toBe(201);
    bobTenantId = resB.body.tenantId;
  });

  test("weak password and bad slug are rejected", async () => {
    const weak = await request(http)
      .post("/auth/signup")
      .send({ ...alice, email: `x-${suffix}@t.io`, password: "short" });
    expect(weak.status).toBe(400);

    const badSlug = await request(http)
      .post("/auth/signup")
      .send({
        ...alice,
        email: `y-${suffix}@t.io`,
        tenantSlug: "Bad Slug!",
      });
    expect(badSlug.status).toBe(400);
  });

  test("login and list memberships", async () => {
    const bad = await request(http)
      .post("/auth/login")
      .send({ email: alice.email, password: "wrong-password-here" });
    expect(bad.status).toBe(401);

    const res = await request(http)
      .post("/auth/login")
      .send({ email: alice.email, password: alice.password });
    expect(res.status).toBe(200);
    aliceUserToken = res.body.accessToken;
    expect(res.body.refreshToken).toBeTruthy();

    const me = await request(http)
      .get("/auth/me")
      .set("Authorization", `Bearer ${aliceUserToken}`);
    expect(me.status).toBe(200);
    expect(me.body.memberships).toEqual([
      expect.objectContaining({ tenantId: aliceTenantId, role: "owner" }),
    ]);

    const bobLogin = await request(http)
      .post("/auth/login")
      .send({ email: bob.email, password: bob.password });
    bobUserToken = bobLogin.body.accessToken;
  });

  test("tenant token: own tenant OK, foreign tenant forbidden", async () => {
    const own = await request(http)
      .post("/auth/tenant-token")
      .set("Authorization", `Bearer ${aliceUserToken}`)
      .send({ tenantId: aliceTenantId });
    expect(own.status).toBe(200);
    aliceTenantToken = own.body.accessToken;

    const foreign = await request(http)
      .post("/auth/tenant-token")
      .set("Authorization", `Bearer ${aliceUserToken}`)
      .send({ tenantId: bobTenantId });
    expect(foreign.status).toBe(403);
  });

  test("tenant routes require a tenant token", async () => {
    const withUserToken = await request(http)
      .get("/tenants/current")
      .set("Authorization", `Bearer ${aliceUserToken}`);
    expect(withUserToken.status).toBe(403);

    const ok = await request(http)
      .get("/tenants/current")
      .set("Authorization", `Bearer ${aliceTenantToken}`);
    expect(ok.status).toBe(200);
    expect(ok.body.id).toBe(aliceTenantId);
    expect(ok.body.slug).toBe(alice.tenantSlug);
  });

  test("owner adds a member; action lands in the audit trail", async () => {
    const add = await request(http)
      .post("/tenants/current/members")
      .set("Authorization", `Bearer ${aliceTenantToken}`)
      .send({ email: bob.email, role: "cashier" });
    expect(add.status).toBe(201);

    const members = await request(http)
      .get("/tenants/current/members")
      .set("Authorization", `Bearer ${aliceTenantToken}`);
    expect(members.body).toHaveLength(2);

    const audit = await request(http)
      .get("/tenants/current/audit")
      .set("Authorization", `Bearer ${aliceTenantToken}`);
    expect(audit.status).toBe(200);
    expect(audit.body[0]).toEqual(
      expect.objectContaining({ action: "member.added" }),
    );
    expect(audit.body[0].hash).toBeTruthy();
  });

  test("RBAC: cashier cannot add members or read audit", async () => {
    const bobInAliceTenant = await request(http)
      .post("/auth/tenant-token")
      .set("Authorization", `Bearer ${bobUserToken}`)
      .send({ tenantId: aliceTenantId });
    expect(bobInAliceTenant.status).toBe(200);
    const cashierToken = bobInAliceTenant.body.accessToken;

    const denied = await request(http)
      .post("/tenants/current/members")
      .set("Authorization", `Bearer ${cashierToken}`)
      .send({ email: alice.email, role: "viewer" });
    expect(denied.status).toBe(403);

    const auditDenied = await request(http)
      .get("/tenants/current/audit")
      .set("Authorization", `Bearer ${cashierToken}`);
    expect(auditDenied.status).toBe(403);

    // But the cashier can see the workspace they now belong to.
    const view = await request(http)
      .get("/tenants/current")
      .set("Authorization", `Bearer ${cashierToken}`);
    expect(view.status).toBe(200);
  });

  test("owner role cannot be granted via addMember", async () => {
    const res = await request(http)
      .post("/tenants/current/members")
      .set("Authorization", `Bearer ${aliceTenantToken}`)
      .send({ email: bob.email, role: "owner" });
    expect(res.status).toBe(400);
  });
});
