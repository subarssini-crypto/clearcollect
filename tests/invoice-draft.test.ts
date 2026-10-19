/**
 * Offline tests for AI invoice drafts — no Gemini API calls, no DB writes.
 * Covers strict draft validation, server-side totals, and the draft
 * endpoint's input/configuration guards.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DRAFT_JSON_SCHEMA, validateInvoiceDraft } from "@/lib/invoice-draft";
import { AiDraftError, generateInvoiceDraft } from "@/lib/ai-invoice";
import { POST } from "@/app/api/ai/invoice-draft/route";

const ctx = { clientIds: [1, 2] };

function draft(overrides: Record<string, unknown> = {}) {
  return {
    clientId: 1,
    currency: "USD",
    issueDate: "2026-10-18",
    dueDate: "2026-11-01",
    lineItems: [
      { description: "Web design", quantity: 10, rate: 95 },
      { description: "Frontend development", quantity: 8.5, rate: 110.25 },
    ],
    assumptions: ["Due date defaulted to 14 days"],
    ...overrides,
  };
}

function fieldsOf(result: ReturnType<typeof validateInvoiceDraft>) {
  return result.ok ? [] : result.errors.map((e) => e.field);
}

describe("validateInvoiceDraft", () => {
  test("accepts a valid draft and recomputes amounts and total in cents", () => {
    const result = validateInvoiceDraft(draft(), ctx);
    assert.ok(result.ok);
    assert.deepEqual(result.data.lineItems.map((l) => l.amount), [950, 937.13]);
    assert.equal(result.data.total, 1887.13);
    assert.equal(result.data.clientId, 1);
    assert.deepEqual(result.data.assumptions, ["Due date defaulted to 14 days"]);
  });

  test("output never contains status or payment fields", () => {
    const result = validateInvoiceDraft(draft(), ctx);
    assert.ok(result.ok);
    for (const key of ["status", "paypalOrderId", "paypalCaptureId", "invoiceNumber"]) {
      assert.ok(!(key in result.data), `unexpected ${key}`);
    }
  });

  test("rejects status, payment, and amount fields supplied by the AI", () => {
    const result = validateInvoiceDraft(
      draft({
        status: "PAID",
        paypalOrderId: "X",
        total: 1,
        lineItems: [{ description: "Work", quantity: 1, rate: 10, amount: 999 }],
      }),
      ctx
    );
    assert.deepEqual(fieldsOf(result).sort(), ["lineItems[0].amount", "paypalOrderId", "status", "total"]);
  });

  test("unknown client becomes unselected with a note", () => {
    const result = validateInvoiceDraft(draft({ clientId: 99 }), ctx);
    assert.ok(result.ok);
    assert.equal(result.data.clientId, null);
    assert.match(result.data.assumptions.at(-1) ?? "", /select a client/);
  });

  test("rejects unsupported currency", () => {
    assert.deepEqual(fieldsOf(validateInvoiceDraft(draft({ currency: "BTC" }), ctx)), ["currency"]);
  });

  test("normalizes lowercase currency", () => {
    const result = validateInvoiceDraft(draft({ currency: "eur" }), ctx);
    assert.ok(result.ok);
    assert.equal(result.data.currency, "EUR");
  });

  test("rejects invalid dates and due date not after issue date", () => {
    assert.deepEqual(fieldsOf(validateInvoiceDraft(draft({ issueDate: "2026-02-30" }), ctx)), ["issueDate"]);
    assert.deepEqual(fieldsOf(validateInvoiceDraft(draft({ dueDate: "2026-10-18" }), ctx)), ["dueDate"]);
  });

  test("rejects empty or oversized line item lists", () => {
    assert.deepEqual(fieldsOf(validateInvoiceDraft(draft({ lineItems: [] }), ctx)), ["lineItems"]);
    const many = Array.from({ length: 51 }, () => ({ description: "x", quantity: 1, rate: 1 }));
    assert.deepEqual(fieldsOf(validateInvoiceDraft(draft({ lineItems: many }), ctx)), ["lineItems"]);
  });

  test("rejects non-positive, non-numeric, or over-precise quantities and rates", () => {
    const result = validateInvoiceDraft(
      draft({
        lineItems: [
          { description: "A", quantity: 0, rate: 10 },
          { description: "B", quantity: 1, rate: -5 },
          { description: "C", quantity: "2", rate: 10 },
          { description: "D", quantity: 1, rate: 10.005 },
          { description: " ", quantity: 1, rate: 10 },
        ],
      }),
      ctx
    );
    assert.deepEqual(fieldsOf(result), [
      "lineItems[0].quantity",
      "lineItems[1].rate",
      "lineItems[2].quantity",
      "lineItems[3].rate",
      "lineItems[4].description",
    ]);
  });

  test("requires whole-number rates for zero-decimal currencies", () => {
    const bad = validateInvoiceDraft(draft({ currency: "JPY", lineItems: [{ description: "A", quantity: 1, rate: 100.5 }] }), ctx);
    assert.deepEqual(fieldsOf(bad), ["lineItems[0].rate"]);
    const good = validateInvoiceDraft(draft({ currency: "JPY", lineItems: [{ description: "A", quantity: 3, rate: 1500 }] }), ctx);
    assert.ok(good.ok);
    assert.equal(good.data.total, 4500);
  });

  test("rejects totals above the invoice maximum", () => {
    const result = validateInvoiceDraft(draft({ lineItems: [{ description: "A", quantity: 100000, rate: 1000 }] }), ctx);
    assert.deepEqual(fieldsOf(result), ["total"]);
  });

  test("rejects non-object drafts", () => {
    assert.deepEqual(fieldsOf(validateInvoiceDraft([], ctx)), ["draft"]);
    assert.deepEqual(fieldsOf(validateInvoiceDraft(null, ctx)), ["draft"]);
  });
});

describe("POST /api/ai/invoice-draft (offline guards)", () => {
  function call(body: string) {
    return POST(new Request("http://localhost/api/ai/invoice-draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }));
  }

  test("rejects invalid JSON", async () => {
    assert.equal((await call("{")).status, 400);
  });

  test("rejects missing, empty, or overlong requests", async () => {
    assert.equal((await call("{}")).status, 422);
    assert.equal((await call(JSON.stringify({ request: "   " }))).status, 422);
    assert.equal((await call(JSON.stringify({ request: "x".repeat(2001) }))).status, 422);
  });

  test("returns 503 without calling Gemini when GEMINI_API_KEY is not set", async () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const res = await call(JSON.stringify({ request: "10 hours of design for Acme at $95/hr" }));
      assert.equal(res.status, 503);
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    }
  });
});

describe("Gemini draft generator (offline)", () => {
  test("throws a 503 AiDraftError before any network call when GEMINI_API_KEY is not set", async () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      await assert.rejects(generateInvoiceDraft("10 hours of design", [], "2026-10-19"), (err: unknown) => {
        assert.ok(err instanceof AiDraftError);
        assert.equal(err.status, 503);
        return true;
      });
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    }
  });

  test("response schema sent to Gemini has no status, payment, or amount fields", () => {
    const keys = JSON.stringify(DRAFT_JSON_SCHEMA);
    for (const field of ["status", "paypal", "amount", "total", "invoiceNumber"]) {
      assert.ok(!keys.includes(`"${field}`), `schema mentions ${field}`);
    }
    assert.equal(DRAFT_JSON_SCHEMA.additionalProperties, false);
    assert.equal(DRAFT_JSON_SCHEMA.properties.lineItems.items.additionalProperties, false);
  });
});
