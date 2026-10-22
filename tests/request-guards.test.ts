/**
 * Regression tests for cross-site request forgery, request-size limits,
 * the trusted PayPal return origin, and anti-framing headers.
 *
 * Every guarded request below uses a body that fails validation, so even
 * without the guards no route writes to the database or calls PayPal,
 * Gemini, or Zapier. Requests carry an owner session so they reach the
 * guards under test; authentication itself is covered in auth.test.ts.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { POST as createClient } from "@/app/api/clients/route";
import { POST as createInvoice } from "@/app/api/invoices/route";
import { PATCH as updateInvoice } from "@/app/api/invoices/[id]/route";
import { POST as createPaypalOrder } from "@/app/api/invoices/[id]/paypal-order/route";
import { POST as aiDraft } from "@/app/api/ai/invoice-draft/route";
import { POST as followUpDraft } from "@/app/api/follow-ups/draft/route";
import { POST as followUpSend } from "@/app/api/follow-ups/send/route";
import { POST as paypalWebhook } from "@/app/api/paypal/webhook/route";
import { MAX_JSON_BODY_BYTES, readBodyText } from "@/lib/request";
import { PaymentError, getPaymentReturnOrigin } from "@/lib/paypal";
import nextConfig from "../next.config";
import { ownerCookie } from "./auth-helpers";

const COOKIE = await ownerCookie();

const UNKNOWN_ID = "99999999";
const idCtx = { params: Promise.resolve({ id: UNKNOWN_ID }) };

const jsonRoutes: [string, (req: Request) => Promise<Response>][] = [
  ["POST /api/clients", (r) => createClient(r)],
  ["POST /api/invoices", (r) => createInvoice(r as never)],
  ["PATCH /api/invoices/[id]", (r) => updateInvoice(r, idCtx as never)],
  ["POST /api/ai/invoice-draft", (r) => aiDraft(r)],
  ["POST /api/follow-ups/draft", (r) => followUpDraft(r)],
  ["POST /api/follow-ups/send", (r) => followUpSend(r)],
];

function req(headers: Record<string, string>, body: string, method = "POST"): Request {
  return new Request("http://localhost:3000/api/test", { method, headers: { cookie: COOKIE, ...headers }, body });
}

/** Valid JSON that every route rejects with 422 before any side effect. */
const INVALID_BUT_PARSEABLE = JSON.stringify({ invoiceId: "x", name: "", request: "" });

describe("JSON API routes reject cross-site and non-JSON requests (CSRF)", () => {
  for (const [name, handler] of jsonRoutes) {
    test(`${name}: text/plain body (a CORS 'simple' request) → 415`, async () => {
      const res = await handler(req({ "content-type": "text/plain" }, INVALID_BUT_PARSEABLE));
      assert.equal(res.status, 415);
    });

    test(`${name}: form-encoded or missing content type → 415`, async () => {
      const form = await handler(req({ "content-type": "application/x-www-form-urlencoded" }, INVALID_BUT_PARSEABLE));
      assert.equal(form.status, 415);
      const none = await handler(new Request("http://localhost:3000/api/test", {
        method: "POST",
        headers: { cookie: COOKIE },
        body: new Blob([INVALID_BUT_PARSEABLE]), // no type → no content-type header
      }));
      assert.equal(none.status, 415);
    });

    test(`${name}: browser cross-site or same-site request → 403`, async () => {
      for (const site of ["cross-site", "same-site"]) {
        const res = await handler(req({ "content-type": "application/json", "sec-fetch-site": site }, INVALID_BUT_PARSEABLE));
        assert.equal(res.status, 403, site);
      }
    });

    test(`${name}: same-origin and non-browser JSON requests still reach validation`, async () => {
      for (const headers of <Record<string, string>[]>[
        { "content-type": "application/json", "sec-fetch-site": "same-origin" },
        { "content-type": "application/json; charset=utf-8" },
      ]) {
        const res = await handler(req(headers, INVALID_BUT_PARSEABLE));
        assert.equal(res.status, 422, JSON.stringify(headers));
      }
    });

    test(`${name}: oversized body → 413 without parsing`, async () => {
      const big = JSON.stringify({ pad: "x".repeat(MAX_JSON_BODY_BYTES) });
      const res = await handler(req({ "content-type": "application/json" }, big));
      assert.equal(res.status, 413);
    });

    test(`${name}: malformed JSON → 400 with both error shapes`, async () => {
      const res = await handler(req({ "content-type": "application/json" }, "{"));
      assert.equal(res.status, 400);
      const json = (await res.json()) as { error?: string; errors?: { field: string }[] };
      assert.equal(typeof json.error, "string");
      assert.equal(json.errors?.[0]?.field, "body");
    });
  }

  test("POST /api/invoices/[id]/paypal-order: cross-site request → 403 before any lookup", async () => {
    const res = await createPaypalOrder(
      new Request("http://localhost:3000/api/invoices/1/paypal-order", {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site", cookie: COOKIE },
      }),
      idCtx as never
    );
    assert.equal(res.status, 403);
  });
});

describe("readBodyText", () => {
  test("stops reading once the limit is exceeded, even without Content-Length", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1024));
        if (pulled > 1000) controller.close();
      },
    });
    const request = new Request("http://localhost/x", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    assert.equal(await readBodyText(request, 4096), null);
    assert.ok(pulled < 20, `read ${pulled} chunks after exceeding the limit`);
  });

  test("rejects a declared Content-Length over the limit", async () => {
    const request = new Request("http://localhost/x", {
      method: "POST",
      headers: { "content-length": "999999" },
      body: "{}",
    });
    assert.equal(await readBodyText(request, 1024), null);
  });

  test("returns text within the limit, including multi-byte characters", async () => {
    const request = new Request("http://localhost/x", { method: "POST", body: "héllo ✓" });
    assert.equal(await readBodyText(request, 1024), "héllo ✓");
  });
});

describe("PayPal webhook body limit", () => {
  test("oversized webhook body → 413 before signature verification", async () => {
    const res = await paypalWebhook(new Request("http://localhost/api/paypal/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(300 * 1024) }),
    }));
    assert.equal(res.status, 413);
  });
});

describe("getPaymentReturnOrigin (PayPal return URLs must not come from the Host header)", () => {
  test("uses APP_URL when set, ignoring the request host", () => {
    assert.equal(getPaymentReturnOrigin("https://evil.example/api/x", "https://pay.example.com/"), "https://pay.example.com");
    assert.equal(getPaymentReturnOrigin("http://localhost:3000/api/x", "https://pay.example.com/app"), "https://pay.example.com");
  });

  test("without APP_URL, accepts only a local development origin", () => {
    assert.equal(getPaymentReturnOrigin("http://localhost:3000/api/x", undefined), "http://localhost:3000");
    assert.equal(getPaymentReturnOrigin("http://127.0.0.1:3000/api/x", ""), "http://127.0.0.1:3000");
    assert.equal(getPaymentReturnOrigin("http://[::1]:3000/api/x", undefined), "http://[::1]:3000");
  });

  test("without APP_URL, a non-local (spoofable) Host is refused", () => {
    for (const url of ["https://evil.example/api/x", "https://clearcollect.example.com/api/x", "http://localhost.evil.example/x"]) {
      assert.throws(
        () => getPaymentReturnOrigin(url, undefined),
        (err: unknown) => err instanceof PaymentError && err.status === 500,
        url
      );
    }
  });

  test("an invalid or non-http APP_URL is refused", () => {
    for (const appUrl of ["not a url", "javascript:alert(1)", "ftp://pay.example.com"]) {
      assert.throws(() => getPaymentReturnOrigin("http://localhost:3000/x", appUrl), PaymentError, appUrl);
    }
  });

  test("the paypal-order route refuses a spoofed Host before creating any order", async () => {
    const saved = process.env.APP_URL;
    delete process.env.APP_URL;
    try {
      const res = await createPaypalOrder(
        new Request("https://evil.example/api/invoices/1/paypal-order", { method: "POST", headers: { cookie: COOKIE } }),
        idCtx as never
      );
      assert.equal(res.status, 500);
      assert.match(((await res.json()) as { error: string }).error, /APP_URL/);
    } finally {
      if (saved !== undefined) process.env.APP_URL = saved;
    }
  });
});

describe("anti-framing headers (clickjacking)", () => {
  test("every path forbids framing and MIME sniffing", async () => {
    assert.ok(nextConfig.headers, "next.config must define headers()");
    const rules = await nextConfig.headers();
    const all = rules.find((r) => r.source === "/:path*");
    assert.ok(all, "a rule must match every path");
    const get = (key: string) => all.headers.find((h) => h.key.toLowerCase() === key)?.value;
    assert.equal(get("x-frame-options"), "DENY");
    assert.match(get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal(get("x-content-type-options"), "nosniff");
  });
});
