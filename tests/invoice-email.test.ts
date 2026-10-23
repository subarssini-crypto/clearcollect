/**
 * Offline tests for invoice emails (src/lib/invoice-email.ts).
 * No Zapier calls and no database writes: Zapier is a fake fetch, and the
 * workflow runs against an in-memory store that applies the same conditional
 * updates as the Prisma store. Route tests only hit paths rejected before any
 * write (they may read existing invoices from MySQL).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  InvoiceEmailError,
  SEND_STALE_MS,
  composeInvoiceEmail,
  invoiceEmailDelivery,
  previewInvoiceEmail,
  sendInvoiceEmail,
  type EmailState,
  type InvoiceEmailRecord,
  type InvoiceEmailStore,
} from "@/lib/invoice-email";
import { validateCreateInvoice } from "@/lib/validation";
import { lineItemCents, validateLineItems } from "@/lib/line-items";
import { prisma } from "@/lib/prisma";
import { GET as previewRoute, POST as sendRoute } from "@/app/api/invoices/[id]/send/route";
import { ownerCookie } from "./auth-helpers";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const SECRET = "test-secret-0123456789abcdef";
const URL_ = "https://hooks.zapier.com/hooks/catch/123/invoice/";
const ENV = { ZAPIER_INVOICE_WEBHOOK_URL: URL_, ZAPIER_WEBHOOK_SECRET: SECRET };

function record(overrides: Partial<InvoiceEmailRecord> = {}): InvoiceEmailRecord {
  return {
    id: 7,
    invoiceNumber: "INV-2026-007",
    description: "Web Design; Frontend Development",
    amount: "1830.00",
    currency: "USD",
    issueDate: new Date("2026-10-23T00:00:00Z"),
    dueDate: new Date("2026-11-06T00:00:00Z"),
    status: "DRAFT",
    paypalCaptureId: null,
    lineItems: [
      { description: "Web Design", quantity: 10, rate: 95, unit: "hour" },
      { description: "Frontend Development", quantity: 8, rate: 110 },
    ],
    emailState: null,
    emailStateAt: null,
    client: { id: 1, name: "Acme Corp", email: " billing@acme.test ", company: "Acme Corporation" },
    ...overrides,
  };
}

/** In-memory store with the same conditional semantics as prismaInvoiceEmailStore. */
class MemoryStore implements InvoiceEmailStore {
  failAccept = false;
  claims = 0;
  constructor(public row: InvoiceEmailRecord) {}

  async load(id: number) {
    return id === this.row.id ? { ...this.row, client: { ...this.row.client } } : null;
  }
  async claim(id: number, at: Date, { allowResend, staleBefore }: { allowResend: boolean; staleBefore: Date }) {
    const r = this.row;
    if (id !== r.id || r.status !== "DRAFT" || r.paypalCaptureId) return false;
    const allowed =
      r.emailState === null ||
      (allowResend &&
        (r.emailState === "UNKNOWN" ||
          r.emailState === "ACCEPTED" ||
          (r.emailState === "SENDING" && r.emailStateAt! < staleBefore)));
    if (!allowed) return false;
    this.claims++;
    Object.assign(r, { emailState: "SENDING" as EmailState, emailStateAt: at });
    return true;
  }
  private holds(id: number, claimedAt: Date) {
    return id === this.row.id && this.row.emailState === "SENDING" && this.row.emailStateAt?.getTime() === claimedAt.getTime();
  }
  async markAccepted(id: number, claimedAt: Date, now: Date) {
    if (this.failAccept) throw new Error("database unavailable");
    if (!this.holds(id, claimedAt) || this.row.status !== "DRAFT") return false;
    Object.assign(this.row, { status: "SENT", emailState: "ACCEPTED" as EmailState, emailStateAt: now });
    return true;
  }
  async markUnknown(id: number, claimedAt: Date, now: Date) {
    if (this.holds(id, claimedAt)) Object.assign(this.row, { emailState: "UNKNOWN" as EmailState, emailStateAt: now });
  }
  async release(id: number, claimedAt: Date, previous: { state: EmailState | null; at: Date | null }) {
    if (this.holds(id, claimedAt)) Object.assign(this.row, { emailState: previous.state, emailStateAt: previous.at });
  }
}

function fakeFetch(respond: () => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ok = () => fakeFetch(async () => new Response(JSON.stringify({ status: "success" })));
const timeoutError = () => Object.assign(new Error("timed out"), { name: "TimeoutError" });

function expectError(status: number, code?: string) {
  return (err: unknown) => {
    assert.ok(err instanceof InvoiceEmailError, `expected InvoiceEmailError, got ${err}`);
    assert.equal(err.status, status);
    if (code) assert.equal(err.code, code);
    return true;
  };
}

function deps(store: InvoiceEmailStore, f: { impl: typeof fetch }, env: Record<string, string | undefined> = ENV) {
  return { store, env, fetchImpl: f.impl, now: () => NOW };
}

// ── Content ───────────────────────────────────────────────────────────────────

describe("composeInvoiceEmail", () => {
  test("includes number, amount with currency, issue and due dates, line items, and a payment instruction", () => {
    const email = composeInvoiceEmail(record());
    assert.equal(email.recipient, "billing@acme.test");
    assert.equal(email.subject, "Invoice INV-2026-007 — USD 1,830.00 due November 6, 2026");
    for (const expected of [
      "Hi Acme Corp,",
      "Invoice number: INV-2026-007",
      "Issue date: October 23, 2026",
      "Due date: November 6, 2026",
      "- Web Design: 10 hours × USD 95.00/hour = USD 950.00",
      "- Frontend Development: 8 × USD 110.00 = USD 880.00",
      "Total due: USD 1,830.00",
      "How to pay: please pay USD 1,830.00 by November 6, 2026 and include INV-2026-007 as the payment reference.",
    ]) {
      assert.ok(email.message.includes(expected), `message should include: ${expected}\n---\n${email.message}`);
    }
  });

  test("invents no payment link and claims no attachment", () => {
    const { message, subject } = composeInvoiceEmail(record());
    assert.doesNotMatch(`${subject}\n${message}`, /https?:\/\/|www\.|attach|pdf|paypal\.me/i);
  });

  test("other currencies keep their code; fixed-price lines read naturally", () => {
    const email = composeInvoiceEmail(
      record({ currency: "EUR", amount: "500.00", lineItems: [{ description: "Logo", quantity: 1, rate: 500, unit: "fixed" }] })
    );
    assert.match(email.message, /- Logo: fixed price EUR 500\.00 = EUR 500\.00/);
    assert.match(email.subject, /EUR 500\.00/);
  });

  test("invoices saved before line items were stored show the description and total", () => {
    const email = composeInvoiceEmail(record({ lineItems: null }));
    assert.match(email.message, /- Web Design; Frontend Development: USD 1,830\.00/);
  });

  test("line items that no longer add up to the amount are refused", () => {
    assert.throws(() => composeInvoiceEmail(record({ amount: "1000.00" })), expectError(422, "line_items_mismatch"));
    assert.throws(() => composeInvoiceEmail(record({ lineItems: [{ nonsense: true }] })), expectError(422, "line_items_mismatch"));
  });

  test("missing or invalid client email is refused", () => {
    for (const email of [null, "", "not-an-email"]) {
      assert.throws(() => composeInvoiceEmail(record({ client: { id: 1, name: "Acme", email, company: null } })), expectError(422, "no_recipient"));
    }
  });
});

// ── Workflow ──────────────────────────────────────────────────────────────────

describe("sendInvoiceEmail", () => {
  test("success: one Zapier request to the stored client email, then the invoice is SENT", async () => {
    const store = new MemoryStore(record());
    const f = ok();
    const result = await sendInvoiceEmail(7, {}, deps(store, f));

    assert.equal(result.mode, "zapier");
    assert.equal(result.accepted, true);
    assert.match(result.detail, /Accepted by Zapier/);
    assert.match(result.detail, /check its history to confirm delivery/);
    assert.doesNotMatch(result.detail, /delivered|email (was )?sent/i);
    assert.ok(!JSON.stringify(result).includes(SECRET));

    assert.equal(store.row.status, "SENT");
    assert.equal(store.row.emailState, "ACCEPTED");
    assert.equal(f.calls.length, 1);
    const { url, init } = f.calls[0];
    assert.equal(url, URL_);
    assert.equal((init.headers as Record<string, string>)["X-ClearCollect-Token"], SECRET);
    const body = JSON.parse(String(init.body));
    assert.equal(body.event, "invoice.email.approved");
    assert.equal(body.auth_token, SECRET);
    assert.equal(body.recipient_email, "billing@acme.test");
    assert.equal(body.invoice_number, "INV-2026-007");
    assert.equal(body.amount, "USD 1,830.00");
    assert.equal(body.amount_value, "1830.00");
    assert.equal(body.currency, "USD");
    assert.equal(body.issue_date, "October 23, 2026");
    assert.equal(body.due_date, "November 6, 2026");
    assert.match(body.line_items, /Web Design/);
    assert.equal(body.send_id, `7-${NOW}`);
    assert.ok(!Object.keys(body).some((k) => /paypal|capture|order/i.test(k)));
  });

  test("the invoice is not SENT while the Zapier request is still running", async () => {
    const store = new MemoryStore(record());
    let statusDuringRequest = "";
    const f = fakeFetch(async () => {
      statusDuringRequest = `${store.row.status}/${store.row.emailState}`;
      return new Response("ok");
    });
    await sendInvoiceEmail(7, {}, deps(store, f));
    assert.equal(statusDuringRequest, "DRAFT/SENDING");
  });

  test("demo mode: nothing sent, nothing changed", async () => {
    const store = new MemoryStore(record());
    const f = ok();
    const result = await sendInvoiceEmail(7, {}, deps(store, f, {}));
    assert.equal(result.mode, "demo");
    assert.equal(result.accepted, false);
    assert.match(result.detail, /nothing was sent/);
    assert.equal(f.calls.length, 0);
    assert.equal(store.row.status, "DRAFT");
    assert.equal(store.row.emailState, null);
  });

  test("the reminder secret alone is demo mode for invoices, not misconfigured", () => {
    assert.equal(invoiceEmailDelivery({ ZAPIER_WEBHOOK_SECRET: SECRET, ZAPIER_WEBHOOK_URL: "https://hooks.zapier.com/x" }).mode, "demo");
  });

  test("misconfigured: refused with 503 before any request or state change", async () => {
    for (const env of [
      { ZAPIER_INVOICE_WEBHOOK_URL: URL_ },
      { ZAPIER_INVOICE_WEBHOOK_URL: "http://hooks.zapier.com/x", ZAPIER_WEBHOOK_SECRET: SECRET },
      { ZAPIER_INVOICE_WEBHOOK_URL: URL_, ZAPIER_WEBHOOK_SECRET: "short" },
    ]) {
      const store = new MemoryStore(record());
      const f = ok();
      await assert.rejects(sendInvoiceEmail(7, {}, deps(store, f, env)), expectError(503, "misconfigured"));
      assert.equal(f.calls.length, 0);
      assert.equal(store.claims, 0);
    }
  });

  test("validation failures send nothing: not found, wrong status, paid, no recipient, bad line items", async () => {
    const cases: [InvoiceEmailRecord | null, number, string][] = [
      [null, 404, "not_found"],
      [record({ status: "SENT" }), 409, "not_draft"],
      [record({ status: "OVERDUE" }), 409, "not_draft"],
      [record({ status: "CANCELLED" }), 409, "not_draft"],
      [record({ status: "PAID" }), 409, "paid"],
      [record({ paypalCaptureId: "CAPTURE-1" }), 409, "paid"],
      [record({ client: { id: 1, name: "Acme", email: null, company: null } }), 422, "no_recipient"],
      [record({ amount: "1.00" }), 422, "line_items_mismatch"],
    ];
    for (const [row, status, code] of cases) {
      const store = new MemoryStore(row ?? record({ id: 999 }));
      const f = ok();
      await assert.rejects(sendInvoiceEmail(7, {}, deps(store, f)), expectError(status, code));
      assert.equal(f.calls.length, 0, code);
      assert.equal(store.claims, 0, code);
    }
  });

  test("Zapier HTTP error: not sent, invoice stays DRAFT, and a retry is allowed", async () => {
    const store = new MemoryStore(record());
    await assert.rejects(
      sendInvoiceEmail(7, {}, deps(store, fakeFetch(async () => new Response("bad", { status: 500 })))),
      (err: unknown) => expectError(502, "rejected")(err) && /not sent/.test((err as Error).message)
    );
    assert.equal(store.row.status, "DRAFT");
    assert.equal(store.row.emailState, null);
    assert.equal((await sendInvoiceEmail(7, {}, deps(store, ok()))).accepted, true);
  });

  test("connection failure: not sent and the claim is released", async () => {
    const store = new MemoryStore(record());
    const f = fakeFetch(async () => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(sendInvoiceEmail(7, {}, deps(store, f)), expectError(502, "unreachable"));
    assert.equal(store.row.status, "DRAFT");
    assert.equal(store.row.emailState, null);
  });

  test("timeout: outcome unknown (504), stays DRAFT, and a resend needs explicit confirmation", async () => {
    const store = new MemoryStore(record());
    const slow = fakeFetch(async () => {
      throw timeoutError();
    });
    await assert.rejects(
      sendInvoiceEmail(7, {}, deps(store, slow)),
      (err: unknown) =>
        expectError(504, "unknown_outcome")(err) &&
        /unknown whether/.test((err as Error).message) &&
        !/not sent/.test((err as Error).message)
    );
    assert.equal(store.row.status, "DRAFT");
    assert.equal(store.row.emailState, "UNKNOWN");

    // A plain retry is refused without contacting Zapier.
    const retry = ok();
    await assert.rejects(sendInvoiceEmail(7, {}, deps(store, retry)), expectError(409, "confirm_required"));
    assert.equal(retry.calls.length, 0);

    // The preview explains why.
    const preview = await previewInvoiceEmail(7, { store, env: ENV, now: NOW });
    assert.match(preview.resendWarning ?? "", /unknown whether the email went out/);

    // After checking the Zap history, the owner can confirm a resend.
    const confirmed = await sendInvoiceEmail(7, { confirmResend: true }, deps(store, retry));
    assert.equal(confirmed.accepted, true);
    assert.equal(retry.calls.length, 1);
    assert.equal(store.row.status, "SENT");
  });

  test("duplicate concurrent requests: only one reaches Zapier", async () => {
    const store = new MemoryStore(record());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = fakeFetch(async () => {
      await gate;
      return new Response("ok");
    });
    const first = sendInvoiceEmail(7, {}, deps(store, f));
    const second = sendInvoiceEmail(7, {}, deps(store, f));
    await assert.rejects(second, expectError(409, "claim_lost"));
    release();
    assert.equal((await first).accepted, true);
    assert.equal(f.calls.length, 1);
    assert.equal(store.claims, 1);
  });

  test("duplicate request while a send is in progress (separate load) is refused", async () => {
    const store = new MemoryStore(record({ emailState: "SENDING", emailStateAt: new Date(NOW - 5_000) }));
    const f = ok();
    await assert.rejects(sendInvoiceEmail(7, { confirmResend: true }, deps(store, f)), expectError(409, "in_progress"));
    assert.equal(f.calls.length, 0);
  });

  test("duplicate request after success is refused because the invoice is no longer a DRAFT", async () => {
    const store = new MemoryStore(record());
    await sendInvoiceEmail(7, {}, deps(store, ok()));
    const again = ok();
    await assert.rejects(sendInvoiceEmail(7, {}, deps(store, again)), expectError(409, "not_draft"));
    assert.equal(again.calls.length, 0);
  });

  test("an interrupted send (stale SENDING) is treated as unknown and needs confirmation", async () => {
    const store = new MemoryStore(record({ emailState: "SENDING", emailStateAt: new Date(NOW - SEND_STALE_MS - 1) }));
    await assert.rejects(sendInvoiceEmail(7, {}, deps(store, ok())), expectError(409, "confirm_required"));
    assert.equal((await sendInvoiceEmail(7, { confirmResend: true }, deps(store, ok()))).accepted, true);
  });

  test("an invoice moved back to DRAFT after an accepted send needs confirmation to email again", async () => {
    const store = new MemoryStore(record({ emailState: "ACCEPTED", emailStateAt: new Date(NOW - 86_400_000) }));
    await assert.rejects(
      sendInvoiceEmail(7, {}, deps(store, ok())),
      (err: unknown) => expectError(409, "confirm_required")(err) && /second time/.test((err as Error).message)
    );
  });

  test("a failed resend restores the earlier state instead of clearing it", async () => {
    const at = new Date(NOW - 60_000);
    const store = new MemoryStore(record({ emailState: "UNKNOWN", emailStateAt: at }));
    await assert.rejects(
      sendInvoiceEmail(7, { confirmResend: true }, deps(store, fakeFetch(async () => new Response("bad", { status: 503 })))),
      expectError(502, "rejected")
    );
    assert.equal(store.row.emailState, "UNKNOWN");
    assert.equal(store.row.emailStateAt, at);
  });

  test("accepted by Zapier but not recorded: says not to send again", async () => {
    const store = new MemoryStore(record());
    store.failAccept = true;
    await assert.rejects(
      sendInvoiceEmail(7, {}, deps(store, ok())),
      (err: unknown) => expectError(500, "accepted_not_recorded")(err) && /Do not send it again/.test((err as Error).message)
    );
  });
});

// ── Saving line items ─────────────────────────────────────────────────────────

describe("line items on invoice creation", () => {
  const base = {
    clientId: 1,
    description: "Web Design; Frontend Development",
    amount: 1830,
    currency: "USD",
    issueDate: "2026-10-23",
    dueDate: "2026-11-06",
  };
  const items = [
    { description: " Web Design ", quantity: 10, rate: 95, unit: "hour" },
    { description: "Frontend Development", quantity: 8, rate: 110 },
  ];

  test("valid line items are stored (trimmed) when they add up to the amount", () => {
    const result = validateCreateInvoice({ ...base, lineItems: items });
    assert.ok(result.ok);
    assert.deepEqual(result.data.lineItems, [
      { description: "Web Design", quantity: 10, rate: 95, unit: "hour" },
      { description: "Frontend Development", quantity: 8, rate: 110 },
    ]);
  });

  test("line items are optional", () => {
    const result = validateCreateInvoice(base);
    assert.ok(result.ok);
    assert.equal(result.data.lineItems, null);
  });

  test("line items that do not add up to the amount are rejected", () => {
    const result = validateCreateInvoice({ ...base, amount: 1800, lineItems: items });
    assert.ok(!result.ok);
    assert.ok(result.errors.some((e) => e.field === "lineItems"));
  });

  test("malformed line items are rejected", () => {
    for (const bad of [[], "x", [{ description: "", quantity: 1, rate: 1 }], [{ description: "A", quantity: -1, rate: 1 }], [{ description: "A", quantity: 1, rate: 1, unit: "year" }]]) {
      assert.equal(validateLineItems(bad).ok, false, JSON.stringify(bad));
    }
  });

  test("cents rounding matches the Create Invoice page (quantity and rate rounded first)", () => {
    // 3 × 0.333 would be 0.999 → 100 cents; rounding the rate to 0.33 first gives 99.
    assert.equal(lineItemCents({ quantity: 3, rate: 0.333 }), 99);
    assert.equal(lineItemCents({ quantity: 10, rate: 95 }), 95000);
  });
});

// ── Route guards (no writes, no Zapier) ───────────────────────────────────────

describe("/api/invoices/[id]/send route (offline guards)", () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  async function post(id: string, body: string, contentType = "application/json") {
    const headers = { "content-type": contentType, cookie: await ownerCookie() };
    return sendRoute(new Request(`http://localhost/api/invoices/${id}/send`, { method: "POST", headers, body }), ctx(id));
  }

  test("requires a session", async () => {
    const res = await sendRoute(
      new Request("http://localhost/api/invoices/1/send", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      ctx("1")
    );
    assert.equal(res.status, 401);
  });

  test("rejects bad ids, non-JSON bodies, and a non-boolean confirmResend before any lookup", async () => {
    assert.equal((await post("abc", "{}")).status, 400);
    assert.equal((await post("1.5", "{}")).status, 400);
    assert.equal((await post("1", "{}", "text/plain")).status, 415);
    assert.equal((await post("1", "{")).status, 400);
    assert.equal((await post("1", JSON.stringify({ confirmResend: "yes" }))).status, 422);
  });

  test("ignores any recipient supplied by the browser (unknown invoice still 404s)", async () => {
    const res = await post("99999999", JSON.stringify({ recipient: "attacker@example.com" }));
    assert.equal(res.status, 404);
    const preview = await previewRoute(new Request("http://localhost/api/invoices/99999999/send", { headers: { cookie: await ownerCookie() } }), ctx("99999999"));
    assert.equal(preview.status, 404);
  });

  test("refuses non-DRAFT invoices server-side without contacting Zapier", async (t) => {
    const sent = await prisma.invoice.findFirst({ where: { status: { in: ["PAID", "SENT", "OVERDUE"] } }, select: { id: true } });
    if (!sent) return t.skip("no PAID/SENT/OVERDUE invoice in the database");
    const saved = { url: process.env.ZAPIER_INVOICE_WEBHOOK_URL, secret: process.env.ZAPIER_WEBHOOK_SECRET };
    // An unroutable host: if the status check were skipped, the test would fail instead of emailing anyone.
    process.env.ZAPIER_INVOICE_WEBHOOK_URL = "https://invalid.invalid/hook";
    process.env.ZAPIER_WEBHOOK_SECRET = SECRET;
    try {
      const res = await post(String(sent.id), "{}");
      assert.equal(res.status, 409);
    } finally {
      if (saved.url === undefined) delete process.env.ZAPIER_INVOICE_WEBHOOK_URL;
      else process.env.ZAPIER_INVOICE_WEBHOOK_URL = saved.url;
      if (saved.secret === undefined) delete process.env.ZAPIER_WEBHOOK_SECRET;
      else process.env.ZAPIER_WEBHOOK_SECRET = saved.secret;
    }
  });
});
