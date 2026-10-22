/**
 * Offline tests for AI invoice drafts — Gemini is never called (the model
 * call is replaced with t.mock.method) and nothing is written to MySQL.
 * Covers strict draft validation, server-side totals, clarification instead
 * of invented numbers, client resolution against database records,
 * transparent date defaults, and the draft endpoint's guards. Route tests
 * read existing clients but never write.
 */

import { after, describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  DRAFT_JSON_SCHEMA,
  appendGeneralAnswers,
  extractStatedNumbers,
  findMissingDetails,
  resolveClarification,
  resolveDraftClient,
  validateInvoiceDraft,
  type Clarification,
  type DraftContext,
  type DraftOutcome,
  type InvoiceDraft,
} from "@/lib/invoice-draft";
import { AiDraftError, gemini, generateInvoiceDraft } from "@/lib/ai-invoice";
import { prisma } from "@/lib/prisma";
import { POST } from "@/app/api/ai/invoice-draft/route";
import { ownerCookie } from "./auth-helpers";

after(() => prisma.$disconnect());

const CLIENTS = [
  { id: 1, name: "Sumchi", company: "Sumchi Studio" },
  { id: 2, name: "Acme Corp", company: "Acme Corporation" },
  { id: 3, name: "Acme Labs", company: null },
];

const AMBIGUOUS_DAYS = "Create an invoice for three days of frontend development at $20 per hour.";

function ctx(overrides: Partial<DraftContext> = {}): DraftContext {
  return {
    request: "10 hours of web design at $95/hr and 8.5 hours of frontend development at $110.25/hr",
    clients: CLIENTS,
    selectedClientId: 1,
    today: "2026-10-18",
    ...overrides,
  };
}

function raw(overrides: Record<string, unknown> = {}) {
  return {
    questions: [],
    clientMention: null,
    currency: "USD",
    issueDate: null,
    dueDate: null,
    paymentTermsDays: null,
    lineItems: [
      { description: "Web design", quantity: 10, rate: 95 },
      { description: "Frontend development", quantity: 8.5, rate: 110.25 },
    ],
    assumptions: [],
    ...overrides,
  };
}

function fieldsOf(result: ReturnType<typeof validateInvoiceDraft>) {
  return result.ok ? [] : result.errors.map((e) => e.field);
}

function draftOf(result: ReturnType<typeof validateInvoiceDraft> | DraftOutcome): InvoiceDraft {
  const outcome = "ok" in result ? (assert.ok(result.ok, JSON.stringify(result)), result.data) : result;
  assert.equal(outcome.kind, "draft", JSON.stringify(outcome));
  return outcome as InvoiceDraft;
}

function questionsOf(result: ReturnType<typeof validateInvoiceDraft> | DraftOutcome): string[] {
  const outcome = "ok" in result ? (assert.ok(result.ok, JSON.stringify(result)), result.data) : result;
  assert.equal(outcome.kind, "clarification", JSON.stringify(outcome));
  return (outcome as Clarification).questions.map((q) => q.text);
}

/** Replaces the Gemini call for one test; returns the mock to inspect calls. */
function mockGemini(t: TestContext, response: unknown) {
  return t.mock.method(gemini, "generateJson", async () => JSON.stringify(response));
}

describe("server-side totals and forbidden fields", () => {
  test("recomputes amounts and total in cents, ignoring any AI arithmetic", () => {
    const draft = draftOf(validateInvoiceDraft(raw(), ctx()));
    assert.deepEqual(draft.lineItems.map((l) => l.amount), [950, 937.13]);
    assert.equal(draft.total, 1887.13);
  });

  test("output never contains status, payment, or invoice-number fields", () => {
    const draft = draftOf(validateInvoiceDraft(raw(), ctx()));
    for (const key of ["status", "paypalOrderId", "paypalCaptureId", "invoiceNumber"]) {
      assert.ok(!(key in draft), `unexpected ${key}`);
    }
  });

  test("rejects status, payment, total, and client-id fields supplied by the AI", () => {
    const result = validateInvoiceDraft(raw({ status: "PAID", paypalOrderId: "X", total: 1, clientId: 2 }), ctx());
    assert.deepEqual(fieldsOf(result).sort(), ["clientId", "paypalOrderId", "status", "total"]);
  });

  test("rejects a line-item amount supplied by the AI", () => {
    const result = validateInvoiceDraft(raw({ lineItems: [{ description: "Work", quantity: 1, rate: 10, amount: 999 }] }), ctx());
    assert.deepEqual(fieldsOf(result), ["lineItems[0].amount"]);
  });

  test("rejects unsupported currency and normalizes lowercase", () => {
    assert.deepEqual(fieldsOf(validateInvoiceDraft(raw({ currency: "BTC" }), ctx())), ["currency"]);
    assert.equal(draftOf(validateInvoiceDraft(raw({ currency: "eur" }), ctx())).currency, "EUR");
  });

  test("rejects malformed dates and payment terms", () => {
    assert.deepEqual(fieldsOf(validateInvoiceDraft(raw({ issueDate: "2026-02-30" }), ctx())), ["issueDate"]);
    assert.deepEqual(fieldsOf(validateInvoiceDraft(raw({ dueDate: "next week" }), ctx())), ["dueDate"]);
    assert.deepEqual(fieldsOf(validateInvoiceDraft(raw({ paymentTermsDays: 0 }), ctx())), ["paymentTermsDays"]);
    assert.deepEqual(fieldsOf(validateInvoiceDraft(raw({ paymentTermsDays: 2.5 }), ctx())), ["paymentTermsDays"]);
  });

  test("rejects oversized line item lists", () => {
    const many = Array.from({ length: 51 }, () => ({ description: "x", quantity: 1, rate: 1 }));
    assert.deepEqual(fieldsOf(validateInvoiceDraft(raw({ lineItems: many }), ctx())), ["lineItems"]);
  });

  test("rejects non-positive, non-numeric, or over-precise quantities and rates", () => {
    const result = validateInvoiceDraft(
      raw({
        lineItems: [
          { description: "A", quantity: 0, rate: 10 },
          { description: "B", quantity: 1, rate: -5 },
          { description: "C", quantity: "2", rate: 10 },
          { description: "D", quantity: 1, rate: 10.005 },
          { description: " ", quantity: 1, rate: 10 },
        ],
      }),
      ctx()
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
    const bad = validateInvoiceDraft(raw({ currency: "JPY", lineItems: [{ description: "A", quantity: 1, rate: 100.5 }] }), ctx());
    assert.deepEqual(fieldsOf(bad), ["lineItems[0].rate"]);
    const good = draftOf(validateInvoiceDraft(
      raw({ currency: "JPY", lineItems: [{ description: "A", quantity: 3, rate: 1500 }] }),
      ctx({ request: "3 logo concepts at ¥1500 each" })
    ));
    assert.equal(good.total, 4500);
  });

  test("rejects totals above the invoice maximum", () => {
    const result = validateInvoiceDraft(raw({ lineItems: [{ description: "A", quantity: 100000, rate: 1000 }] }), ctx());
    assert.deepEqual(fieldsOf(result), ["total"]);
  });

  test("rejects non-object drafts and malformed questions", () => {
    assert.deepEqual(fieldsOf(validateInvoiceDraft([], ctx())), ["draft"]);
    assert.deepEqual(fieldsOf(validateInvoiceDraft(null, ctx())), ["draft"]);
    assert.deepEqual(fieldsOf(validateInvoiceDraft(raw({ questions: "how many?" }), ctx())), ["questions"]);
  });
});

describe("missing financial details are not invented", () => {
  test("hourly rate + work in days with no hours → clarification, never 8 hours/day", () => {
    for (const request of [
      AMBIGUOUS_DAYS,
      "3 days of frontend work at $20/hr",
      "Bill Acme for 2 weeks of design, $40 hourly",
      "half a day of consulting at $90 an hour",
    ]) {
      const questions = findMissingDetails(request);
      assert.equal(questions.length, 1, request);
      assert.match(questions[0], /hours/i);
      assert.match(questions[0], /does not assume/i);
    }
  });

  test("no clarification when hours, or a day rate, are given", () => {
    for (const request of [
      "3 days of frontend development, 6 hours per day, at $20 per hour",
      "24 hours of frontend development at $20/hr",
      "3 days of frontend development at $400 per day",
      "10 hours spread over 3 days at $20 an hour",
      "a 40-hour week of support at $30 per hour",
    ]) {
      assert.deepEqual(findMissingDetails(request), [], request);
    }
  });

  test("the ambiguous request is answered with a question before Gemini is called", async (t) => {
    const call = mockGemini(t, raw());
    const outcome = await generateInvoiceDraft(ctx({ request: AMBIGUOUS_DAYS }));
    assert.match(questionsOf(outcome)[0], /billable hours/);
    assert.equal(call.mock.callCount(), 0);
  });

  test("numbers the user never stated are flagged for explicit confirmation", async (t) => {
    // Even if the model converts "three days" into 24 hours on its own,
    // the draft marks the invented quantity instead of presenting it as fact.
    mockGemini(t, raw({ lineItems: [{ description: "Frontend development", quantity: 24, rate: 20 }] }));
    const draft = draftOf(await generateInvoiceDraft(ctx({ request: "three days of frontend development at $20" })));
    assert.equal(draft.lineItems[0].needsConfirmation, true);
    assert.equal(draft.total, 480); // still computed server-side, but flagged
    assert.equal(draft.confirmations.length, 1);
    assert.match(draft.confirmations[0], /quantity 24 was not stated/);
  });

  test("an invented rate is flagged too", () => {
    const draft = draftOf(validateInvoiceDraft(
      raw({ lineItems: [{ description: "Logo design", quantity: 1, rate: 500 }] }),
      ctx({ request: "Logo design for Sumchi" })
    ));
    assert.match(draft.confirmations[0], /rate 500.00 was not stated/);
  });

  test("model questions win over any draft; empty line items become a question", () => {
    const asked = questionsOf(validateInvoiceDraft(raw({ questions: ["What is your hourly rate?"] }), ctx()));
    assert.deepEqual(asked, ["What is your hourly rate?"]);
    assert.equal(questionsOf(validateInvoiceDraft(raw({ lineItems: [] }), ctx())).length, 1);
  });

  test("stated numbers are recognised in digits, separators, k-suffix, and words", () => {
    const stated = extractStatedNumbers("Two logos at $1,200.50 each, a 2k retainer, 7.5 hours, twelve calls");
    for (const value of [2, 1200.5, 2000, 7.5, 12]) assert.ok(stated.has(Math.round(value * 100)), String(value));
  });
});

describe("explicit values are preserved", () => {
  const request = "Invoice for 12.5 hours of design at €80/hour, issued 2026-11-02, due 2026-12-01";

  test("quantities, rates, currency, and dates from the request are kept exactly", async (t) => {
    mockGemini(t, raw({
      currency: "EUR",
      issueDate: "2026-11-02",
      dueDate: "2026-12-01",
      lineItems: [{ description: "Design", quantity: 12.5, unit: "hour", rate: 80 }],
    }));
    const draft = draftOf(await generateInvoiceDraft(ctx({ request })));
    assert.deepEqual(draft.lineItems, [{ description: "Design", quantity: 12.5, unit: "hour", rate: 80, amount: 1000, needsConfirmation: false }]);
    assert.equal(draft.total, 1000);
    assert.equal(draft.currency, "EUR");
    assert.equal(draft.currencySource, "request");
    assert.deepEqual([draft.issueDate, draft.issueDateSource], ["2026-11-02", "request"]);
    assert.deepEqual([draft.dueDate, draft.dueDateSource], ["2026-12-01", "request"]);
    assert.deepEqual(draft.confirmations, []);
  });

  test("explicit request dates are never replaced by form dates or defaults", () => {
    const draft = draftOf(validateInvoiceDraft(
      raw({ issueDate: "2026-11-02", dueDate: "2026-12-01" }),
      ctx({ formDates: { issueDate: "2026-10-01", dueDate: "2026-10-05" } })
    ));
    assert.deepEqual([draft.issueDate, draft.dueDate], ["2026-11-02", "2026-12-01"]);
  });
});

describe("date defaults are transparent", () => {
  test("no dates stated → today and today + 14, both labelled as app defaults", () => {
    const draft = draftOf(validateInvoiceDraft(raw(), ctx()));
    assert.deepEqual([draft.issueDate, draft.issueDateSource], ["2026-10-18", "default"]);
    assert.deepEqual([draft.dueDate, draft.dueDateSource], ["2026-11-01", "default"]);
  });

  test("the default due date is computed from an explicit issue date", () => {
    const draft = draftOf(validateInvoiceDraft(raw({ issueDate: "2026-12-20" }), ctx()));
    assert.deepEqual([draft.dueDate, draft.dueDateSource], ["2027-01-03", "default"]);
  });

  test("dates the user typed in the form beat app defaults", () => {
    const draft = draftOf(validateInvoiceDraft(raw(), ctx({ formDates: { issueDate: "2026-10-20", dueDate: "2026-11-30" } })));
    assert.deepEqual([draft.issueDate, draft.issueDateSource, draft.dueDate, draft.dueDateSource], ["2026-10-20", "form", "2026-11-30", "form"]);
  });

  test("stated payment terms set the due date and are labelled", () => {
    const draft = draftOf(validateInvoiceDraft(raw({ paymentTermsDays: 30 }), ctx()));
    assert.deepEqual([draft.dueDate, draft.dueDateSource], ["2026-11-17", "payment_terms"]);
  });

  test("a due date not after the issue date is asked about, not silently replaced", () => {
    const fromRequest = questionsOf(validateInvoiceDraft(raw({ issueDate: "2026-11-02", dueDate: "2026-11-02" }), ctx()));
    assert.match(fromRequest[0], /not after the issue date/);
    const fromForm = questionsOf(validateInvoiceDraft(raw({ issueDate: "2026-11-02" }), ctx({ formDates: { dueDate: "2026-10-30" } })));
    assert.match(fromForm[0], /2026-10-30/);
  });

  test("a missing currency uses the app default with a visible note", () => {
    const draft = draftOf(validateInvoiceDraft(raw({ currency: null }), ctx()));
    assert.equal(draft.currency, "USD");
    assert.equal(draft.currencySource, "default");
    assert.match(draft.assumptions.join(" "), /No currency was stated/);
  });
});

describe("client resolution (database records only)", () => {
  test("no client named → the selected client is kept", () => {
    assert.deepEqual(resolveDraftClient(null, 1, CLIENTS), { clientId: 1, clientNotice: null });
    assert.equal(draftOf(validateInvoiceDraft(raw(), ctx())).clientId, 1);
  });

  test("no client named and none selected → asks the user to choose", () => {
    const { clientId, clientNotice } = resolveDraftClient(null, null, CLIENTS);
    assert.equal(clientId, null);
    assert.match(clientNotice ?? "", /Choose the client/);
  });

  test("a mention of the selected client (name or company, any case) keeps it", () => {
    for (const mention of ["Sumchi", "sumchi studio", "SUMCHI"]) {
      assert.deepEqual(resolveDraftClient(mention, 1, CLIENTS), { clientId: 1, clientNotice: null }, mention);
    }
  });

  test("an explicitly named different client is used, with a visible notice", () => {
    const { clientId, clientNotice } = resolveDraftClient("Acme Corp", 1, CLIENTS);
    assert.equal(clientId, 2);
    assert.match(clientNotice ?? "", /changed from Sumchi \(Sumchi Studio\) to Acme Corp/);
  });

  test("an unknown name is never assigned to another client", () => {
    const { clientId, clientNotice } = resolveDraftClient("Bob's Bakery", 1, CLIENTS);
    assert.equal(clientId, null);
    assert.match(clientNotice ?? "", /no saved client matches/);
  });

  test("an ambiguous name asks the user to choose (unless the selection is one of the matches)", () => {
    const ambiguous = resolveDraftClient("Acme", 1, CLIENTS);
    assert.equal(ambiguous.clientId, null);
    assert.match(ambiguous.clientNotice ?? "", /more than one client.*Acme Corp.*Acme Labs/);
    assert.deepEqual(resolveDraftClient("Acme", 3, CLIENTS), { clientId: 3, clientNotice: null });
  });

  test("a selected id that is not in the database is never returned", () => {
    assert.equal(resolveDraftClient(null, 999, CLIENTS).clientId, null);
  });
});

describe("POST /api/ai/invoice-draft", () => {
  async function call(body: unknown) {
    return POST(new Request("http://localhost/api/ai/invoice-draft", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await ownerCookie() },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }));
  }

  async function withGeminiKey<T>(fn: () => Promise<T>): Promise<T> {
    const saved = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "test-key-never-sent"; // the Gemini call itself is mocked
    try {
      return await fn();
    } finally {
      if (saved === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = saved;
    }
  }

  test("rejects invalid JSON", async () => {
    assert.equal((await call("{")).status, 400);
  });

  test("rejects missing, empty, or overlong requests", async () => {
    assert.equal((await call({})).status, 422);
    assert.equal((await call({ request: "   " })).status, 422);
    assert.equal((await call({ request: "x".repeat(2001) })).status, 422);
  });

  test("rejects malformed selected client ids and dates", async () => {
    for (const body of [
      { request: "10 hours at $50/hr", selectedClientId: "1" },
      { request: "10 hours at $50/hr", selectedClientId: 0 },
      { request: "10 hours at $50/hr", selectedClientId: 1.5 },
      { request: "10 hours at $50/hr", issueDate: "31/12/2026" },
      { request: "10 hours at $50/hr", dueDate: "2026-02-30" },
    ]) {
      assert.equal((await call(body)).status, 422, JSON.stringify(body));
    }
  });

  test("returns 503 without calling Gemini when GEMINI_API_KEY is not set", async (t) => {
    const mock = mockGemini(t, raw());
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      assert.equal((await call({ request: "10 hours of design for Acme at $95/hr" })).status, 503);
      assert.equal(mock.mock.callCount(), 0);
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    }
  });

  test("a selected client id that does not exist in MySQL → 422 before Gemini", async (t) => {
    const mock = mockGemini(t, raw());
    const res = await withGeminiKey(() => call({ request: "10 hours at $50/hr", selectedClientId: 2_000_000_000 }));
    assert.equal(res.status, 422);
    assert.match(JSON.stringify(await res.json()), /selected client no longer exists/);
    assert.equal(mock.mock.callCount(), 0);
  });

  test("the ambiguous three-day request returns a question, not a $480 draft", async (t) => {
    const mock = mockGemini(t, raw());
    const res = await withGeminiKey(() => call({ request: AMBIGUOUS_DAYS }));
    assert.equal(res.status, 200);
    const { data } = (await res.json()) as { data: DraftOutcome };
    assert.equal(data.kind, "clarification");
    assert.equal(mock.mock.callCount(), 0);
  });

  test("keeps the selected client and saves nothing to the database", async (t) => {
    const client = await prisma.client.findFirst({ select: { id: true } });
    if (!client) return t.skip("no client in the database");
    mockGemini(t, raw({ lineItems: [{ description: "Web design", quantity: 10, rate: 95 }] }));
    const before = await Promise.all([prisma.invoice.count(), prisma.client.count()]);

    const res = await withGeminiKey(() => call({ request: "10 hours of web design at $95/hr", selectedClientId: client.id }));
    assert.equal(res.status, 200);
    const draft = draftOf(((await res.json()) as { data: DraftOutcome }).data);
    assert.equal(draft.clientId, client.id);
    assert.equal(draft.clientNotice, null);
    assert.equal(draft.total, 950);

    assert.deepEqual(await Promise.all([prisma.invoice.count(), prisma.client.count()]), before);
  });

  test("an unknown client name in the request is not assigned to the selected client", async (t) => {
    const client = await prisma.client.findFirst({ select: { id: true } });
    if (!client) return t.skip("no client in the database");
    mockGemini(t, raw({ clientMention: "Zz Nonexistent Client 7f3a" }));
    const res = await withGeminiKey(() => call({ request: "10 hours of web design at $95/hr and 8.5 hours of frontend development at $110.25/hr for Zz Nonexistent Client 7f3a", selectedClientId: client.id }));
    const draft = draftOf(((await res.json()) as { data: DraftOutcome }).data);
    assert.equal(draft.clientId, null);
    assert.match(draft.clientNotice ?? "", /no saved client matches/);
  });

  test("a form date the user typed is respected over the default", async (t) => {
    mockGemini(t, raw());
    const res = await withGeminiKey(() => call({
      request: "10 hours of web design at $95/hr and 8.5 hours of frontend development at $110.25/hr",
      issueDate: "2026-10-20",
      dueDate: "2026-12-31",
    }));
    const draft = draftOf(((await res.json()) as { data: DraftOutcome }).data);
    assert.deepEqual([draft.issueDate, draft.dueDate, draft.dueDateSource], ["2026-10-20", "2026-12-31", "form"]);
  });
});

describe("Gemini draft generator (offline)", () => {
  test("throws a 503 AiDraftError before any network call when GEMINI_API_KEY is not set", async () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      await assert.rejects(generateInvoiceDraft(ctx({ request: "10 hours of design at $50/hr" })), (err: unknown) => {
        assert.ok(err instanceof AiDraftError);
        assert.equal(err.status, 503);
        return true;
      });
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    }
  });

  test("invalid model output is rejected with 422, never passed through", async (t) => {
    mockGemini(t, raw({ status: "PAID" }));
    await assert.rejects(generateInvoiceDraft(ctx()), (err: unknown) => err instanceof AiDraftError && err.status === 422);
  });

  test("response schema sent to Gemini has no status, payment, amount, or client-id fields", () => {
    const keys = JSON.stringify(DRAFT_JSON_SCHEMA);
    for (const field of ["status", "paypal", "amount", "total", "invoiceNumber", "clientId"]) {
      assert.ok(!keys.includes(`"${field}`), `schema mentions ${field}`);
    }
    assert.equal(DRAFT_JSON_SCHEMA.additionalProperties, false);
    assert.equal(DRAFT_JSON_SCHEMA.properties.lineItems.items.additionalProperties, false);
  });
});

// ── Structured clarification (browser test: rates missing for 3 items) ──

const BROWSER_REQUEST = "work - frontend - 3 hrs; backend 14 hrs; ai - 2 hrs";
const RATE_IDS = ["lineItems[0].rate", "lineItems[1].rate", "lineItems[2].rate"];

function missingRates(overrides: Record<string, unknown> = {}) {
  return raw({
    currency: null,
    lineItems: [
      { description: "Frontend", quantity: 3, unit: "hour", rate: null },
      { description: "Backend", quantity: 14, unit: "hour", rate: null },
      { description: "AI", quantity: 2, unit: "hour", rate: null },
    ],
    ...overrides,
  });
}

function firstRound(pending = missingRates()): Clarification {
  const result = validateInvoiceDraft(pending, ctx({ request: BROWSER_REQUEST }));
  assert.ok(result.ok && result.data.kind === "clarification", JSON.stringify(result));
  return result.data as Clarification;
}

/** Answers by question id, in whatever order the object lists them. */
function answer(byId: Record<string, string>, pending = firstRound().pending!, earlierAnswers: string[] = []) {
  return resolveClarification(
    { pending, answers: Object.entries(byId).map(([id, text]) => ({ id, answer: text })), earlierAnswers },
    ctx({ request: BROWSER_REQUEST })
  );
}

function problemsOf(result: ReturnType<typeof resolveClarification>): Record<string, string | undefined> {
  assert.ok(result.ok && result.data.kind === "clarification", JSON.stringify(result));
  return Object.fromEntries((result.data as Clarification).questions.map((q) => [q.id, q.problem]));
}

describe("clarification questions name the item, field, unit, and currency", () => {
  test("missing rates become one explicit question each, with stable ids", () => {
    const round = firstRound();
    assert.deepEqual(round.questions.map((q) => [q.id, q.field, q.text]), [
      ["lineItems[0].rate", "rate", "Frontend: 3 hours at what hourly rate (USD/hour)?"],
      ["lineItems[1].rate", "rate", "Backend: 14 hours at what hourly rate (USD/hour)?"],
      ["lineItems[2].rate", "rate", "AI: 2 hours at what hourly rate (USD/hour)?"],
    ]);
    assert.match(round.notes.join(" "), /No currency was stated.*USD \(the app default\)/);
    assert.ok(round.pending);
  });

  test("the same questions come from the model output (Gemini mocked)", async (t) => {
    mockGemini(t, missingRates());
    const outcome = await generateInvoiceDraft(ctx({ request: BROWSER_REQUEST }));
    assert.deepEqual(questionsOf(outcome)[0], "Frontend: 3 hours at what hourly rate (USD/hour)?");
  });

  test("a stated currency, a missing quantity, and a fixed price are worded accordingly", () => {
    const round = firstRound(raw({
      currency: "EUR",
      lineItems: [
        { description: "Design", quantity: null, unit: "hour", rate: 80 },
        { description: "Logo", quantity: null, unit: "fixed", rate: null },
        { description: "Workshop", quantity: 2, unit: "day", rate: null },
      ],
    }));
    assert.deepEqual(round.questions.map((q) => q.text), [
      "Design: how many hours at 80 EUR/hour?",
      "Logo: what is the fixed price (EUR)?",
      "Workshop: 2 days at what daily rate (EUR/day)?",
    ]);
    assert.deepEqual(round.notes, []);
  });
});

describe("clarification answers are matched by id and never guessed", () => {
  test("\"6 dollars\", \"3 dollars\", \"2\" → 3×6 + 14×3 + 2×2 = 64 USD, values stated", () => {
    const draft = draftOf(answer({ [RATE_IDS[0]]: "6 dollars", [RATE_IDS[1]]: "3 dollars", [RATE_IDS[2]]: "2" }));
    assert.deepEqual(draft.lineItems.map((l) => [l.description, l.quantity, l.unit, l.rate, l.amount]), [
      ["Frontend", 3, "hour", 6, 18],
      ["Backend", 14, "hour", 3, 42],
      ["AI", 2, "hour", 2, 4],
    ]);
    assert.equal(draft.total, 64);
    assert.equal(draft.currency, "USD");
    assert.equal(draft.currencySource, "request");
    assert.deepEqual(draft.confirmations, []);
  });

  test("answers glued to units (\"6dollars\") parse the same way", () => {
    assert.equal(draftOf(answer({ [RATE_IDS[0]]: "6dollars", [RATE_IDS[1]]: "$3/hr", [RATE_IDS[2]]: "2 USD per hour" })).total, 64);
  });

  test("reordered answers still map to their own questions", () => {
    const draft = draftOf(answer({ [RATE_IDS[2]]: "2", [RATE_IDS[0]]: "6 dollars", [RATE_IDS[1]]: "3 dollars" }));
    assert.deepEqual(draft.lineItems.map((l) => l.rate), [6, 3, 2]);
    assert.equal(draft.total, 64);
  });

  test("all three answers typed into one box are not split by position", () => {
    const problems = problemsOf(answer({ [RATE_IDS[0]]: "6 dollars, 3 dollars, 2", [RATE_IDS[1]]: "", [RATE_IDS[2]]: "" }));
    assert.match(problems[RATE_IDS[0]] ?? "", /more than one number \(6, 3, 2\)/);
    assert.match(problems[RATE_IDS[1]] ?? "", /No answer was given/);
    assert.match(problems[RATE_IDS[2]] ?? "", /No answer was given/);
  });

  test("answers without units use the unit and currency the question states, marked as the app default", () => {
    const draft = draftOf(answer({ [RATE_IDS[0]]: "6", [RATE_IDS[1]]: "3", [RATE_IDS[2]]: "2" }));
    assert.equal(draft.total, 64);
    assert.equal(draft.currency, "USD");
    assert.equal(draft.currencySource, "default");
    assert.match(draft.assumptions.join(" "), /No currency was stated/);
  });

  test("a different time unit is sent back, not converted; accepted answers are kept", () => {
    const result = answer({ [RATE_IDS[0]]: "6 dollars per day", [RATE_IDS[1]]: "3", [RATE_IDS[2]]: "2" });
    const problems = problemsOf(result);
    assert.match(problems[RATE_IDS[0]] ?? "", /per hour.*per day.*not converted/);
    assert.equal(problems[RATE_IDS[1]], undefined);
    assert.ok(result.ok && result.data.kind === "clarification");
    const pending = (result.data as Clarification).pending as { lineItems: { rate: number | null }[] };
    assert.deepEqual(pending.lineItems.map((l) => l.rate), [null, 3, 2]);
    assert.deepEqual((result.data as Clarification).questions.map((q) => q.id), [RATE_IDS[0]]);
  });

  test("a quantity in the wrong unit is sent back", () => {
    const round = firstRound(raw({ currency: "USD", lineItems: [{ description: "Design", quantity: null, unit: "hour", rate: 80 }] }));
    const problems = problemsOf(resolveClarification(
      { pending: round.pending!, answers: [{ id: "lineItems[0].quantity", answer: "3 days" }], earlierAnswers: [] },
      ctx({ request: "Design at $80/hr" })
    ));
    assert.match(problems["lineItems[0].quantity"] ?? "", /asks for hours, but the answer is in days/);
  });

  test("unclear, approximate, ranged, negative, or misplaced answers get a follow-up", () => {
    for (const [text, expected] of [
      ["not sure", /not an exact value/],
      ["about 6", /not an exact value/],
      ["6?", /not an exact value/],
      ["5-6", /more than one number/],
      ["-6", /greater than 0/],
      ["0", /greater than 0/],
      ["6.125", /2 decimal places/],
      ["six-ish dollars", /not an exact value/],
      ["same as backend", /mentions “Backend”/],
      ["backend 3 dollars", /mentions “Backend”/],
      ["lots", /No number was found/],
    ] as const) {
      const problems = problemsOf(answer({ [RATE_IDS[0]]: text, [RATE_IDS[1]]: "3", [RATE_IDS[2]]: "2" }));
      assert.match(problems[RATE_IDS[0]] ?? "", expected, text);
    }
  });

  test("a number written as a word is accepted", () => {
    assert.equal(draftOf(answer({ [RATE_IDS[0]]: "six dollars", [RATE_IDS[1]]: "3", [RATE_IDS[2]]: "2" })).total, 64);
  });

  test("an answer in another currency than the request states is sent back", () => {
    const round = firstRound(missingRates({ currency: "EUR" }));
    const problems = problemsOf(answer({ [RATE_IDS[0]]: "6 dollars", [RATE_IDS[1]]: "3", [RATE_IDS[2]]: "2" }, round.pending!));
    assert.match(problems[RATE_IDS[0]] ?? "", /invoice is in EUR, but the answer is in USD/);
  });

  test("answers naming different currencies are sent back; one consistent currency is used", () => {
    const problems = problemsOf(answer({ [RATE_IDS[0]]: "6 dollars", [RATE_IDS[1]]: "3 euros", [RATE_IDS[2]]: "2" }));
    assert.match(problems[RATE_IDS[0]] ?? "", /more than one currency/);
    assert.match(problems[RATE_IDS[1]] ?? "", /more than one currency/);
    assert.equal(problems[RATE_IDS[2]], undefined);
    const euros = draftOf(answer({ [RATE_IDS[0]]: "€6", [RATE_IDS[1]]: "3 EUR", [RATE_IDS[2]]: "2" }));
    assert.deepEqual([euros.currency, euros.total], ["EUR", 64]);
  });

  test("a follow-up round completes the draft; earlier answers count as stated", () => {
    const first = answer({ [RATE_IDS[0]]: "6 dollars", [RATE_IDS[1]]: "not sure", [RATE_IDS[2]]: "2" });
    assert.ok(first.ok && first.data.kind === "clarification");
    const second = answer({ [RATE_IDS[1]]: "3 dollars" }, (first.data as Clarification).pending!, ["6 dollars", "not sure", "2"]);
    const draft = draftOf(second);
    assert.equal(draft.total, 64);
    assert.deepEqual(draft.confirmations, []);
  });

  test("a tampered pending draft or unknown answer id is rejected, not applied", () => {
    const pending = firstRound().pending!;
    const tampered = answer({ [RATE_IDS[0]]: "6" }, { ...pending, status: "PAID" });
    assert.ok(!tampered.ok);
    assert.deepEqual(tampered.errors.map((e) => e.field), ["status"]);
    const unknown = answer({ "lineItems[9].rate": "6" });
    assert.ok(!unknown.ok);
    assert.match(unknown.errors[0].message, /no longer match/);
    const complete = answer({ "lineItems[0].rate": "6" }, raw());
    assert.ok(!complete.ok);
  });

  test("general answers are kept as explicit question/answer pairs", () => {
    const text = appendGeneralAnswers("Design work", [
      { question: "How many hours?", answer: "10" },
      { question: "What rate?", answer: "$50/hr" },
    ]);
    assert.match(text, /- Question: How many hours\?\n {2}Answer: 10\n- Question: What rate\?\n {2}Answer: \$50\/hr$/);
  });
});

describe("POST /api/ai/invoice-draft with clarification answers", () => {
  async function post(body: unknown) {
    return POST(new Request("http://localhost/api/ai/invoice-draft", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await ownerCookie() },
      body: JSON.stringify(body),
    }));
  }

  test("answers are applied server-side without Gemini (even with no API key)", async (t) => {
    const mock = mockGemini(t, raw());
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const res = await post({
        request: BROWSER_REQUEST,
        clarification: {
          pending: firstRound().pending,
          answers: [
            { id: RATE_IDS[1], answer: "3 dollars" },
            { id: RATE_IDS[0], answer: "6 dollars" },
            { id: RATE_IDS[2], answer: "2" },
          ],
        },
      });
      assert.equal(res.status, 200);
      const draft = draftOf(((await res.json()) as { data: DraftOutcome }).data);
      assert.equal(draft.total, 64);
      assert.equal(mock.mock.callCount(), 0);
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    }
  });

  test("malformed clarification payloads → 422", async () => {
    for (const clarification of [
      { pending: null, answers: [{ id: RATE_IDS[0], answer: "6" }] },
      { pending: {}, answers: [] },
      { pending: {}, answers: [{ id: RATE_IDS[0] }] },
      { pending: {}, answers: [{ id: RATE_IDS[0], answer: "x".repeat(501) }] },
      "6 dollars, 3 dollars, 2",
    ]) {
      assert.equal((await post({ request: BROWSER_REQUEST, clarification })).status, 422, JSON.stringify(clarification));
    }
  });
});
