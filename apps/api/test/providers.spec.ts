/**
 * Production adapter tests against in-process fake upstream servers:
 *  - Daraja: OAuth token fetched once and cached across pushes; STK payload
 *    carries the spec password/timestamp; rejections surface as errors,
 *  - OSCU: field mapping, permanent rejection vs transient 5xx handling.
 */
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { DarajaPaymentProvider } from "../src/payments/daraja.provider";
import { EtimsOscuProvider } from "../src/fiscal/oscu.provider";
import {
  FiscalPermanentError,
  FiscalTransientError,
} from "../src/fiscal/provider";

interface Captured {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function fakeUpstream(
  handler: (req: Captured) => { status: number; json: unknown },
): Promise<{ server: Server; baseUrl: string; calls: Captured[] }> {
  const calls: Captured[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const captured = { url: req.url ?? "", headers: req.headers, body };
      calls.push(captured);
      const out = handler(captured);
      res.writeHead(out.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.json));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, calls });
    });
  });
}

describe("DarajaPaymentProvider", () => {
  test("caches OAuth token and sends a spec-shaped STK push", async () => {
    const { server, baseUrl, calls } = await fakeUpstream((req) => {
      if (req.url.startsWith("/oauth")) {
        return {
          status: 200,
          json: { access_token: "tok-123", expires_in: "3599" },
        };
      }
      return {
        status: 200,
        json: { ResponseCode: "0", CheckoutRequestID: "ws_CO_TEST_1" },
      };
    });
    try {
      const daraja = new DarajaPaymentProvider({
        baseUrl,
        consumerKey: "ck",
        consumerSecret: "cs",
        shortcode: "174379",
        passkey: "passkey123",
        callbackUrl: "https://api.example.co.ke/webhooks/mpesa/stk",
      });
      const req = {
        tenantId: "t1",
        amountCents: 116_000,
        msisdn: "254712345678",
        accountRef: "INV-42",
      };
      const first = await daraja.initiateStkPush(req);
      const second = await daraja.initiateStkPush(req);
      expect(first.providerRef).toBe("ws_CO_TEST_1");
      expect(second.providerRef).toBe("ws_CO_TEST_1");

      const oauthCalls = calls.filter((c) => c.url.startsWith("/oauth"));
      expect(oauthCalls).toHaveLength(1); // cached for the second push
      const basic = Buffer.from("ck:cs").toString("base64");
      expect(oauthCalls[0].headers.authorization).toBe(`Basic ${basic}`);

      const push = calls.find((c) => c.url.includes("stkpush"))!;
      expect(push.headers.authorization).toBe("Bearer tok-123");
      const body = JSON.parse(push.body);
      expect(body.Amount).toBe(1160); // whole KES
      expect(body.PartyA).toBe("254712345678");
      expect(body.AccountReference).toBe("INV-42");
      expect(body.Timestamp).toMatch(/^\d{14}$/);
      const decoded = Buffer.from(body.Password, "base64").toString();
      expect(decoded).toBe(`174379passkey123${body.Timestamp}`);
    } finally {
      server.close();
    }
  });

  test("rejects fractional-KES amounts and surfaces Daraja errors", async () => {
    const { server, baseUrl } = await fakeUpstream((req) =>
      req.url.startsWith("/oauth")
        ? { status: 200, json: { access_token: "t", expires_in: 3599 } }
        : { status: 400, json: { errorMessage: "Invalid PhoneNumber" } },
    );
    try {
      const daraja = new DarajaPaymentProvider({
        baseUrl,
        consumerKey: "ck",
        consumerSecret: "cs",
        shortcode: "174379",
        passkey: "pk",
        callbackUrl: "https://x/webhooks/mpesa/stk",
      });
      await expect(
        daraja.initiateStkPush({
          tenantId: "t",
          amountCents: 11_650, // 116.50 — not whole KES
          msisdn: "254700000000",
          accountRef: "X",
        }),
      ).rejects.toThrow(/whole KES/);
      await expect(
        daraja.initiateStkPush({
          tenantId: "t",
          amountCents: 10_000,
          msisdn: "bad",
          accountRef: "X",
        }),
      ).rejects.toThrow(/Invalid PhoneNumber/);
    } finally {
      server.close();
    }
  });
});

describe("EtimsOscuProvider", () => {
  const signReq = {
    tenantId: "t1",
    branchId: "b1",
    docType: "invoice" as const,
    seq: 7,
    payload: {
      issueDate: "2026-07-14",
      buyer: { name: "Kamau Wholesalers", kra_pin: "P051112223A" },
      subtotalCents: 230_000,
      vatCents: 32_000,
      totalCents: 262_000,
      lines: [{}, {}],
    },
  };

  test("maps invoice to the sales payload and returns control data", async () => {
    const { server, baseUrl, calls } = await fakeUpstream(() => ({
      status: 200,
      json: {
        resultCd: "000",
        data: { rcptNo: 7, intrlData: "ABCD1234", rcptSign: "SIGN9999" },
      },
    }));
    try {
      const oscu = new EtimsOscuProvider(
        { baseUrl, tin: "P000111222Z", bhfId: "00", cmcKey: "cmc-key" },
      );
      const result = await oscu.sign(signReq);
      expect(result.controlNumber).toBe("7");
      expect(result.qrPayload).toContain("P000111222Z00ABCD1234");

      const call = calls[0];
      expect(call.headers.tin).toBe("P000111222Z");
      expect(call.headers.cmckey).toBe("cmc-key");
      const body = JSON.parse(call.body);
      expect(body.invcNo).toBe(7);
      expect(body.custTin).toBe("P051112223A");
      expect(body.salesDt).toBe("20260714");
      expect(body.totAmt).toBe(2620);
      expect(body.itemCnt).toBe(2);
    } finally {
      server.close();
    }
  });

  test("KRA rejection is permanent; 5xx is transient", async () => {
    const reject = await fakeUpstream(() => ({
      status: 200,
      json: { resultCd: "901", resultMsg: "Invalid item classification" },
    }));
    try {
      const oscu = new EtimsOscuProvider(
        { baseUrl: reject.baseUrl, tin: "T", bhfId: "00", cmcKey: "k" },
      );
      await expect(oscu.sign(signReq)).rejects.toThrow(FiscalPermanentError);
    } finally {
      reject.server.close();
    }

    const down = await fakeUpstream(() => ({ status: 503, json: {} }));
    try {
      const oscu = new EtimsOscuProvider(
        { baseUrl: down.baseUrl, tin: "T", bhfId: "00", cmcKey: "k" },
      );
      await expect(oscu.sign(signReq)).rejects.toThrow(FiscalTransientError);
    } finally {
      down.server.close();
    }
  });
});
