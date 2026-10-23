/**
 * Offline tests for AI follow-up reminders and Zapier delivery.
 * No Gemini or Zapier calls: Zapier is exercised with a fake fetch, and the
 * route tests only hit paths that are rejected before any external call
 * (they read existing PAID invoices from MySQL but never write).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  FollowUpError,
  RESEND_COOLDOWN_MS,
  ReminderSendGuard,
  assertReminderMatchesInvoice,
  assertRemindable,
  buildZapierPayload,
  deliverReminder,
  fillReminderTemplate,
  getZapierConfig,
  reminderFacts,
  reminderRecipient,
  validateSendReminder,
  type ReminderInvoice,
} from "@/lib/follow-up";
import { prisma } from "@/lib/prisma";
import { POST as sendRoute } from "@/app/api/follow-ups/send/route";
import { POST as draftRoute } from "@/app/api/follow-ups/draft/route";
import { ownerCookie } from "./auth-helpers";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const SECRET = "test-secret-0123456789abcdef";
const ZAPIER_ENV = { ZAPIER_WEBHOOK_URL: "https://hooks.zapier.com/hooks/catch/123/abc/", ZAPIER_WEBHOOK_SECRET: SECRET };

function invoice(overrides: Partial<ReminderInvoice> = {}): ReminderInvoice {
  return {
    id: 42,
    invoiceNumber: "INV-2026-042",
    amount: "1830.00",
    currency: "USD",
    dueDate: new Date("2026-10-09T00:00:00Z"),
    status: "SENT",
    paypalCaptureId: null,
    client: { id: 1, name: "Acme Corp", email: "billing@acme.test", company: "Acme Corporation" },
    ...overrides,
  };
}

const input = { invoiceId: 42, subject: "Reminder: INV-2026-042", message: "Please pay INV-2026-042." };

function expectFollowUpError(status: number) {
  return (err: unknown) => {
    assert.ok(err instanceof FollowUpError, `expected FollowUpError, got ${err}`);
    assert.equal(err.status, status);
    return true;
  };
}

describe("assertRemindable", () => {
  test("allows unpaid SENT and OVERDUE invoices", () => {
    assert.doesNotThrow(() => assertRemindable(invoice({ status: "SENT" })));
    assert.doesNotThrow(() => assertRemindable(invoice({ status: "OVERDUE" })));
  });

  test("rejects PAID invoices and invoices with a recorded capture", () => {
    assert.throws(() => assertRemindable(invoice({ status: "PAID" })), expectFollowUpError(409));
    assert.throws(() => assertRemindable(invoice({ status: "SENT", paypalCaptureId: "CAP123" })), expectFollowUpError(409));
  });

  test("rejects DRAFT and CANCELLED invoices", () => {
    assert.throws(() => assertRemindable(invoice({ status: "DRAFT" })), expectFollowUpError(409));
    assert.throws(() => assertRemindable(invoice({ status: "CANCELLED" })), expectFollowUpError(409));
  });
});

describe("reminderFacts and fillReminderTemplate", () => {
  const facts = reminderFacts(invoice(), NOW);

  test("facts come from the invoice: number, amount with currency, due date", () => {
    assert.equal(facts.invoiceNumber, "INV-2026-042");
    assert.equal(facts.amount, "USD 1,830.00");
    assert.equal(facts.dueDate, "October 9, 2026");
    assert.equal(facts.daysOverdue, 10);
    assert.equal(facts.daysUntilDue, 0);
  });

  test("placeholders are replaced with server-side facts", () => {
    const filled = fillReminderTemplate(
      { subject: "Reminder for {{invoice_number}}", message: "Hi Acme Corp, invoice {{invoice_number}} for {{amount}} was due {{due_date}}." },
      facts
    );
    assert.equal(filled.subject, "Reminder for INV-2026-042");
    assert.equal(filled.message, "Hi Acme Corp, invoice INV-2026-042 for USD 1,830.00 was due October 9, 2026.");
  });

  test("rejects drafts missing a required placeholder", () => {
    assert.throws(
      () => fillReminderTemplate({ subject: "Hi", message: "Invoice {{invoice_number}} for {{amount}} is late." }, facts),
      expectFollowUpError(502)
    );
  });

  test("rejects drafts that mention a different invoice number", () => {
    assert.throws(
      () =>
        fillReminderTemplate(
          { subject: "Hi", message: "{{invoice_number}} ({{amount}}, due {{due_date}}) and also INV-2026-999." },
          facts
        ),
      expectFollowUpError(502)
    );
  });
});

describe("reminderRecipient", () => {
  test("returns the trimmed client email", () => {
    assert.equal(reminderRecipient(invoice({ client: { id: 1, name: "Acme", email: " a@b.co ", company: null } })), "a@b.co");
    // Regression: addresses containing "s" must be accepted (e.g. gmail.com, business.com).
    for (const email of ["sales@business.com", "zapier-test@example.com", "someone.s@gmail.com"]) {
      assert.equal(reminderRecipient(invoice({ client: { id: 1, name: "Acme", email, company: null } })), email);
    }
  });

  test("rejects missing or invalid client emails with 422", () => {
    for (const email of [null, "", "   ", "not-an-email", "a@b", "a@bxcom", "a b@c.com"]) {
      assert.throws(() => reminderRecipient(invoice({ client: { id: 1, name: "Acme", email, company: null } })), expectFollowUpError(422));
    }
  });
});

describe("validateSendReminder", () => {
  test("accepts and trims a valid request", () => {
    const result = validateSendReminder({ invoiceId: 3, subject: "  Hello ", message: " Body " });
    assert.ok(result.ok);
    assert.deepEqual(result.data, { invoiceId: 3, subject: "Hello", message: "Body" });
  });

  test("rejects bad ids, empty or oversized text, and non-objects", () => {
    const fields = (body: unknown) => {
      const r = validateSendReminder(body);
      return r.ok ? [] : r.errors.map((e) => e.field);
    };
    assert.deepEqual(fields({ invoiceId: 0, subject: "s", message: "m" }), ["invoiceId"]);
    assert.deepEqual(fields({ invoiceId: "1", subject: "s", message: "m" }), ["invoiceId"]);
    assert.deepEqual(fields({ invoiceId: 1, subject: "  ", message: "m" }), ["subject"]);
    assert.deepEqual(fields({ invoiceId: 1, subject: "x".repeat(201), message: "m" }), ["subject"]);
    assert.deepEqual(fields({ invoiceId: 1, subject: "s", message: "x".repeat(5001) }), ["message"]);
    assert.deepEqual(fields([]), ["body"]);
  });
});

describe("getZapierConfig", () => {
  test("demo mode when nothing is configured", () => {
    assert.deepEqual(getZapierConfig({}), { state: "demo" });
  });

  test("misconfigured when only one value is set, URL is not https, or secret is short", () => {
    assert.equal(getZapierConfig({ ZAPIER_WEBHOOK_URL: ZAPIER_ENV.ZAPIER_WEBHOOK_URL }).state, "misconfigured");
    assert.equal(getZapierConfig({ ZAPIER_WEBHOOK_SECRET: SECRET }).state, "misconfigured");
    assert.equal(getZapierConfig({ ...ZAPIER_ENV, ZAPIER_WEBHOOK_URL: "http://hooks.zapier.com/x" }).state, "misconfigured");
    assert.equal(getZapierConfig({ ...ZAPIER_ENV, ZAPIER_WEBHOOK_URL: "not a url" }).state, "misconfigured");
    assert.equal(getZapierConfig({ ...ZAPIER_ENV, ZAPIER_WEBHOOK_SECRET: "short" }).state, "misconfigured");
  });

  test("configured with an https URL and a long secret", () => {
    assert.equal(getZapierConfig(ZAPIER_ENV).state, "configured");
  });
});

describe("deliverReminder", () => {
  function fakeFetch(respond: () => Promise<Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond();
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  test("demo mode: nothing is sent and delivered is false", async () => {
    const f = fakeFetch(async () => new Response("ok"));
    const result = await deliverReminder(invoice(), input, NOW, { env: {}, fetchImpl: f.impl });
    assert.equal(result.mode, "demo");
    assert.equal(result.delivered, false);
    assert.equal(f.calls.length, 0);
  });

  test("misconfigured: rejected with 503 and nothing is sent", async () => {
    const f = fakeFetch(async () => new Response("ok"));
    await assert.rejects(
      deliverReminder(invoice(), input, NOW, { env: { ZAPIER_WEBHOOK_URL: ZAPIER_ENV.ZAPIER_WEBHOOK_URL }, fetchImpl: f.impl }),
      expectFollowUpError(503)
    );
    assert.equal(f.calls.length, 0);
  });

  test("Zapier error response is reported as not sent", async () => {
    const f = fakeFetch(async () => new Response("bad", { status: 500 }));
    await assert.rejects(deliverReminder(invoice(), input, NOW, { env: ZAPIER_ENV, fetchImpl: f.impl, guard: new ReminderSendGuard() }), expectFollowUpError(502));
  });

  test("connection failure is reported as not sent", async () => {
    const f = fakeFetch(async () => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(
      deliverReminder(invoice(), input, NOW, { env: ZAPIER_ENV, fetchImpl: f.impl, guard: new ReminderSendGuard() }),
      (err: unknown) => expectFollowUpError(502)(err) && /not sent/.test((err as Error).message)
    );
  });

  test("timeout is reported as unknown (504), never as not sent", async () => {
    const f = fakeFetch(async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    });
    await assert.rejects(
      deliverReminder(invoice(), input, NOW, { env: ZAPIER_ENV, fetchImpl: f.impl, guard: new ReminderSendGuard() }),
      (err: unknown) =>
        expectFollowUpError(504)(err) &&
        /unknown whether/.test((err as Error).message) &&
        !/not sent/.test((err as Error).message)
    );
  });

  test("success only when Zapier confirms; sends the token and invoice facts", async () => {
    const f = fakeFetch(async () => new Response(JSON.stringify({ status: "success" }), { status: 200 }));
    const result = await deliverReminder(invoice(), input, NOW, { env: ZAPIER_ENV, fetchImpl: f.impl, guard: new ReminderSendGuard() });
    assert.equal(result.mode, "zapier");
    assert.equal(result.delivered, true);
    assert.ok(!JSON.stringify(result).includes(SECRET), "result must not expose the secret");

    assert.equal(f.calls.length, 1);
    const { url, init } = f.calls[0];
    assert.equal(url, ZAPIER_ENV.ZAPIER_WEBHOOK_URL);
    assert.equal((init.headers as Record<string, string>)["X-ClearCollect-Token"], SECRET);
    const body = JSON.parse(String(init.body));
    assert.equal(body.auth_token, SECRET);
    assert.equal(body.invoice_number, "INV-2026-042");
    assert.equal(body.amount, "USD 1,830.00");
    assert.equal(body.due_date, "October 9, 2026");
    assert.equal(body.client_email, "billing@acme.test");
    assert.equal(body.recipient_email, "billing@acme.test");
    assert.match(result.detail, /Accepted by Zapier/);
    assert.doesNotMatch(result.detail, /email (was )?sent/i);
    assert.equal(body.subject, input.subject);
    assert.equal(body.message, input.message);
  });

  test("missing recipient email: rejected before any request, even when configured", async () => {
    const f = fakeFetch(async () => new Response("ok"));
    const noEmail = invoice({ client: { id: 1, name: "Acme", email: null, company: null } });
    await assert.rejects(deliverReminder(noEmail, input, NOW, { env: ZAPIER_ENV, fetchImpl: f.impl, guard: new ReminderSendGuard() }), expectFollowUpError(422));
    await assert.rejects(deliverReminder(noEmail, input, NOW, { env: {}, fetchImpl: f.impl }), expectFollowUpError(422));
    assert.equal(f.calls.length, 0);
  });

  test("approved text must name this invoice and no other; checked before any request", async () => {
    const f = fakeFetch(async () => new Response("ok"));
    const opts = { env: ZAPIER_ENV, fetchImpl: f.impl, guard: new ReminderSendGuard() };
    const missing = { ...input, subject: "Payment reminder", message: "Please pay soon." };
    await assert.rejects(deliverReminder(invoice(), missing, NOW, opts), expectFollowUpError(422));
    const wrong = { ...input, message: "Please pay INV-2026-042 and INV-2026-041." };
    await assert.rejects(deliverReminder(invoice(), wrong, NOW, opts), expectFollowUpError(422));
    // Also enforced in demo mode, so a demo run shows the same error.
    await assert.rejects(deliverReminder(invoice(), missing, NOW, { ...opts, env: {} }), expectFollowUpError(422));
    assert.equal(f.calls.length, 0);
  });

  test("invoice number in the subject only is enough, and matching is case-insensitive", () => {
    assert.doesNotThrow(() =>
      assertReminderMatchesInvoice(invoice(), { ...input, subject: "Reminder: inv-2026-042", message: "Please pay." })
    );
    assert.doesNotThrow(() =>
      assertReminderMatchesInvoice(invoice(), { ...input, message: "Invoice INV-2026-042, due soon. Thanks!" })
    );
  });

  test("duplicate sends: a concurrent second send is refused while the first is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = fakeFetch(async () => {
      await gate;
      return new Response("ok");
    });
    const opts = { env: ZAPIER_ENV, fetchImpl: f.impl, guard: new ReminderSendGuard() };
    const first = deliverReminder(invoice(), input, NOW, opts);
    await assert.rejects(deliverReminder(invoice(), input, NOW, opts), expectFollowUpError(409));
    release();
    assert.equal((await first).delivered, true);
    assert.equal(f.calls.length, 1);
  });

  test("duplicate sends: refused within the cooldown after success or timeout, allowed after", async () => {
    const ok = fakeFetch(async () => new Response("ok"));
    const guard = new ReminderSendGuard();
    const opts = { env: ZAPIER_ENV, fetchImpl: ok.impl, guard };
    await deliverReminder(invoice(), input, NOW, opts);
    await assert.rejects(deliverReminder(invoice(), input, NOW + 60_000, opts), expectFollowUpError(409));
    // Other invoices are unaffected.
    const other = invoice({ id: 43, invoiceNumber: "INV-2026-043" });
    await deliverReminder(other, { ...input, invoiceId: 43, subject: "Reminder: INV-2026-043", message: "Please pay." }, NOW, opts);
    assert.equal((await deliverReminder(invoice(), input, NOW + RESEND_COOLDOWN_MS, opts)).delivered, true);
    assert.equal(ok.calls.length, 3);

    const timeout = fakeFetch(async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    });
    const tGuard = new ReminderSendGuard();
    await assert.rejects(deliverReminder(invoice(), input, NOW, { ...opts, fetchImpl: timeout.impl, guard: tGuard }), expectFollowUpError(504));
    await assert.rejects(deliverReminder(invoice(), input, NOW + 1000, { ...opts, guard: tGuard }), expectFollowUpError(409));
  });

  test("duplicate guard does not block a retry after a definite failure", async () => {
    const guard = new ReminderSendGuard();
    const bad = fakeFetch(async () => new Response("bad", { status: 500 }));
    await assert.rejects(deliverReminder(invoice(), input, NOW, { env: ZAPIER_ENV, fetchImpl: bad.impl, guard }), expectFollowUpError(502));
    const ok = fakeFetch(async () => new Response("ok"));
    assert.equal((await deliverReminder(invoice(), input, NOW + 1000, { env: ZAPIER_ENV, fetchImpl: ok.impl, guard })).delivered, true);
  });

  test("demo mode is never blocked by the duplicate guard", async () => {
    const guard = new ReminderSendGuard();
    for (let i = 0; i < 2; i++) {
      assert.equal((await deliverReminder(invoice(), input, NOW, { env: {}, guard })).mode, "demo");
    }
  });

  test("payload never includes payment identifiers", () => {
    const payload = buildZapierPayload(invoice({ paypalCaptureId: null }), input, reminderFacts(invoice(), NOW), SECRET, NOW, "billing@acme.test");
    assert.ok(!Object.keys(payload).some((k) => /paypal|capture|order/i.test(k)));
  });
});

describe("follow-up routes (offline guards)", () => {
  async function post(handler: (r: Request) => Promise<Response>, body: string) {
    const headers = { "content-type": "application/json", cookie: await ownerCookie() };
    return handler(new Request("http://localhost/api/follow-ups", { method: "POST", headers, body }));
  }

  test("send rejects invalid JSON and invalid fields before any lookup", async () => {
    assert.equal((await post(sendRoute, "{")).status, 400);
    assert.equal((await post(sendRoute, JSON.stringify({ invoiceId: -1, subject: "", message: "" }))).status, 422);
  });

  test("draft rejects invalid invoice ids", async () => {
    assert.equal((await post(draftRoute, JSON.stringify({ invoiceId: "1" }))).status, 422);
  });

  test("send and draft refuse PAID invoices server-side (no Zapier or Gemini call)", async (t) => {
    const paid = await prisma.invoice.findFirst({ where: { status: "PAID" }, select: { id: true } });
    if (!paid) return t.skip("no PAID invoice in the database");
    const saved = { url: process.env.ZAPIER_WEBHOOK_URL, secret: process.env.ZAPIER_WEBHOOK_SECRET };
    process.env.ZAPIER_WEBHOOK_URL = ZAPIER_ENV.ZAPIER_WEBHOOK_URL;
    process.env.ZAPIER_WEBHOOK_SECRET = SECRET;
    try {
      const send = await post(sendRoute, JSON.stringify({ invoiceId: paid.id, subject: "Hi", message: "Please pay" }));
      assert.equal(send.status, 409);
      const draft = await post(draftRoute, JSON.stringify({ invoiceId: paid.id }));
      assert.equal(draft.status, 409);
    } finally {
      if (saved.url === undefined) delete process.env.ZAPIER_WEBHOOK_URL;
      else process.env.ZAPIER_WEBHOOK_URL = saved.url;
      if (saved.secret === undefined) delete process.env.ZAPIER_WEBHOOK_SECRET;
      else process.env.ZAPIER_WEBHOOK_SECRET = saved.secret;
    }
  });

  test("unknown invoice returns 404", async () => {
    const send = await post(sendRoute, JSON.stringify({ invoiceId: 99_999_999, subject: "Hi", message: "Please pay" }));
    assert.equal(send.status, 404);
  });
});
