/**
 * Draft invoice deletion, client archiving, and reminder draft deletion.
 *
 * Unit tests run the eligibility rules against in-memory stores with the
 * same conditional semantics as the Prisma stores (no database, no Zapier).
 *
 * Integration tests go through the real route handlers and MySQL, but only
 * touch records this file creates: a dedicated test client and INV-TEST-DM-…
 * invoices (a format automatic numbering ignores). They are removed in
 * after(). Existing data is never read for writing, changed, or deleted.
 * No Zapier, Gemini, or PayPal calls are made.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  InvoiceDeletionError,
  deleteDraftInvoice,
  deletionBlocker,
  type DeletionCandidate,
  type InvoiceDeletionStore,
} from "@/lib/invoice-deletion";
import {
  deleteReminderDraft,
  reminderAudit,
  saveReminderDraft,
  DraftValidationError,
  type ReminderDraft,
  type ReminderStatus,
  type ReminderStore,
  type SendingFields,
} from "@/lib/reminder-drafts";
import { FollowUpError, ReminderSendGuard, deliverReminder, type ReminderInvoice } from "@/lib/follow-up";
import { DELETE as deleteInvoiceRoute } from "@/app/api/invoices/[id]/route";
import { POST as createInvoiceRoute } from "@/app/api/invoices/route";
import { GET as listClientsRoute } from "@/app/api/clients/route";
import { PATCH as archiveClientRoute } from "@/app/api/clients/[id]/route";
import { GET as listDraftsRoute, POST as saveDraftRoute } from "@/app/api/follow-ups/drafts/route";
import { DELETE as deleteDraftRoute } from "@/app/api/follow-ups/drafts/[id]/route";
import { POST as sendReminderRoute } from "@/app/api/follow-ups/send/route";
import { ownerCookie } from "./auth-helpers";

// ── Unit: draft invoice deletion ──────────────────────────────────────────────

const eligible = (overrides: Partial<DeletionCandidate> = {}): DeletionCandidate => ({
  invoiceNumber: "INV-2026-050",
  status: "DRAFT",
  paypalOrderId: null,
  paypalCaptureId: null,
  paidAt: null,
  emailState: null,
  reminderCount: 0,
  ...overrides,
});

class MemoryDeletionStore implements InvoiceDeletionStore {
  deletes = 0;
  constructor(public row: DeletionCandidate | null, private onDelete?: () => void) {}
  async load() {
    return this.row ? { ...this.row } : null;
  }
  async deleteIfEligible() {
    this.onDelete?.(); // lets a test change the row between the check and the delete
    if (!this.row || deletionBlocker(this.row)) return 0;
    this.row = null;
    this.deletes++;
    return 1;
  }
}

function expectStatus(status: number, pattern?: RegExp) {
  return (err: unknown) => {
    assert.ok(err instanceof InvoiceDeletionError || err instanceof FollowUpError, `unexpected error ${err}`);
    assert.equal(err.status, status);
    if (pattern) assert.match(err.message, pattern);
    return true;
  };
}

describe("deleteDraftInvoice (rules)", () => {
  test("deletes an untouched draft", async () => {
    const store = new MemoryDeletionStore(eligible());
    assert.deepEqual(await deleteDraftInvoice(50, store), { invoiceNumber: "INV-2026-050" });
    assert.equal(store.deletes, 1);
  });

  test("refuses sent, paid, cancelled, PayPal-linked, emailed, and reminded invoices", async () => {
    const cases: [Partial<DeletionCandidate>, RegExp][] = [
      [{ status: "SENT" }, /Only draft invoices/],
      [{ status: "OVERDUE" }, /Only draft invoices/],
      [{ status: "CANCELLED" }, /Only draft invoices/],
      [{ status: "PAID", paypalCaptureId: "CAP" }, /recorded payment/],
      [{ paidAt: new Date() }, /recorded payment/],
      [{ paypalOrderId: "ORDER" }, /PayPal payment started/],
      [{ emailState: "SENDING" }, /being emailed/],
      [{ emailState: "UNKNOWN" }, /already been emailed/],
      [{ emailState: "ACCEPTED" }, /already been emailed/],
      [{ reminderCount: 1 }, /reminder history/],
    ];
    for (const [overrides, message] of cases) {
      const store = new MemoryDeletionStore(eligible(overrides));
      await assert.rejects(deleteDraftInvoice(50, store), expectStatus(409, message), JSON.stringify(overrides));
      assert.equal(store.deletes, 0);
    }
  });

  test("unknown invoice → 404", async () => {
    await assert.rejects(deleteDraftInvoice(50, new MemoryDeletionStore(null)), expectStatus(404));
  });

  test("a change between the check and the delete is reported, not ignored", async () => {
    const store: MemoryDeletionStore = new MemoryDeletionStore(eligible(), () => {
      store.row = { ...store.row!, emailState: "SENDING" }; // an email send claimed it first
    });
    await assert.rejects(deleteDraftInvoice(50, store), expectStatus(409, /being emailed/));
    const gone: MemoryDeletionStore = new MemoryDeletionStore(eligible(), () => {
      gone.row = null; // deleted by another request first
    });
    await assert.rejects(deleteDraftInvoice(50, gone), expectStatus(404, /already deleted/));
  });
});

// ── Unit: reminder drafts and send history ────────────────────────────────────

type Row = { id: number; invoiceId: number; status: ReminderStatus; subject: string; message: string; recipient: string | null; sentAt: Date | null };

class MemoryReminderStore implements ReminderStore {
  rows: Row[] = [];
  private nextId = 1;
  add(row: Partial<Row> & { invoiceId: number }): Row {
    const r: Row = { id: this.nextId++, status: "DRAFT", subject: "S", message: "M", recipient: null, sentAt: null, ...row };
    this.rows.push(r);
    return r;
  }
  get(id: number) {
    return this.rows.find((r) => r.id === id);
  }
  async findLatestDraft(invoiceId: number) {
    const drafts = this.rows.filter((r) => r.invoiceId === invoiceId && r.status === "DRAFT");
    return drafts.length ? { id: drafts[drafts.length - 1].id } : null;
  }
  async createDraft(invoiceId: number, subject: string, message: string) {
    return { id: this.add({ invoiceId, subject, message }).id };
  }
  async updateDraft(id: number, invoiceId: number, subject: string, message: string) {
    const r = this.get(id);
    if (!r || r.invoiceId !== invoiceId || r.status !== "DRAFT") return false;
    Object.assign(r, { subject, message });
    return true;
  }
  async listDrafts(): Promise<ReminderDraft[]> {
    return this.rows.filter((r) => r.status === "DRAFT").map((r) => ({ id: r.id, invoiceId: r.invoiceId, subject: r.subject, message: r.message, updatedAt: "" }));
  }
  async deleteDraft(id: number) {
    const i = this.rows.findIndex((r) => r.id === id && r.status === "DRAFT");
    if (i < 0) return 0;
    this.rows.splice(i, 1);
    return 1;
  }
  async status(id: number) {
    return this.get(id)?.status ?? null;
  }
  async claimDraft(id: number, invoiceId: number, fields: SendingFields) {
    const r = this.get(id);
    if (!r || r.invoiceId !== invoiceId || r.status !== "DRAFT") return false;
    Object.assign(r, { status: "SENDING", subject: fields.subject, message: fields.message, recipient: fields.recipient });
    return true;
  }
  async createSending(invoiceId: number, fields: SendingFields) {
    return { id: this.add({ invoiceId, status: "SENDING", subject: fields.subject, message: fields.message, recipient: fields.recipient }).id };
  }
  async finishSending(id: number, to: Exclude<ReminderStatus, "SENDING">, sentAt: Date | null) {
    const r = this.get(id);
    if (r?.status !== "SENDING") return;
    Object.assign(r, to === "DRAFT" ? { status: to, recipient: null } : { status: to, sentAt });
  }
}

const reminderInvoice = (): ReminderInvoice => ({
  id: 42,
  invoiceNumber: "INV-2026-042",
  amount: "100.00",
  currency: "USD",
  dueDate: new Date("2026-10-30T00:00:00Z"),
  status: "SENT",
  paypalCaptureId: null,
  client: { id: 1, name: "Acme", email: "billing@acme.test", company: null },
});
const input = { invoiceId: 42, subject: "Reminder: INV-2026-042", message: "Please pay INV-2026-042." };
const ZAPIER_ENV = { ZAPIER_WEBHOOK_URL: "https://hooks.zapier.com/hooks/catch/1/x/", ZAPIER_WEBHOOK_SECRET: "test-secret-0123456789abcdef" };
const noInvoiceCheck = async () => undefined;

function fakeFetch(respond: () => Promise<Response>) {
  const calls: unknown[] = [];
  const impl = (async (...args: unknown[]) => {
    calls.push(args);
    return respond();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("reminder drafts (rules)", () => {
  test("save creates a draft, then updates the same draft", async () => {
    const store = new MemoryReminderStore();
    const { id } = await saveReminderDraft(input, store, noInvoiceCheck);
    const again = await saveReminderDraft({ ...input, message: "Updated INV-2026-042" }, store, noInvoiceCheck);
    assert.equal(again.id, id);
    assert.equal(store.rows.length, 1);
    assert.equal(store.rows[0].message, "Updated INV-2026-042");
  });

  test("save validates input and checks the invoice can receive reminders", async () => {
    const store = new MemoryReminderStore();
    await assert.rejects(saveReminderDraft({ invoiceId: "x", subject: "", message: "" }, store, noInvoiceCheck), DraftValidationError);
    await assert.rejects(saveReminderDraft({ ...input, draftId: -1 }, store, noInvoiceCheck), DraftValidationError);
    const refuse = async () => {
      throw new FollowUpError("Reminders can only be sent for SENT or OVERDUE invoices (this one is DRAFT)", 409);
    };
    await assert.rejects(saveReminderDraft(input, store, refuse), expectStatus(409));
    assert.equal(store.rows.length, 0);
  });

  test("saving over a draft that is no longer a draft is refused, not silently re-created", async () => {
    const store = new MemoryReminderStore();
    const sent = store.add({ invoiceId: 42, status: "SENT" });
    await assert.rejects(saveReminderDraft({ ...input, draftId: sent.id }, store, noInvoiceCheck), expectStatus(409, /no longer an unsent draft/));
    assert.equal(store.get(sent.id)!.subject, "S"); // history untouched
  });

  test("delete removes an unsent draft", async () => {
    const store = new MemoryReminderStore();
    const draft = store.add({ invoiceId: 42 });
    await deleteReminderDraft(draft.id, store);
    assert.equal(store.rows.length, 0);
  });

  test("delete refuses in-progress, uncertain, sent, and failed reminders and leaves them intact", async () => {
    const cases: [ReminderStatus, RegExp][] = [
      ["SENDING", /being sent right now/],
      ["UNKNOWN", /uncertain/],
      ["SENT", /send history cannot be deleted/],
      ["FAILED", /send history cannot be deleted/],
    ];
    for (const [status, message] of cases) {
      const store = new MemoryReminderStore();
      const row = store.add({ invoiceId: 42, status, subject: "kept" });
      await assert.rejects(deleteReminderDraft(row.id, store), expectStatus(409, message), status);
      assert.deepEqual(store.get(row.id), row);
    }
  });

  test("delete of a missing draft → 404", async () => {
    await assert.rejects(deleteReminderDraft(7, new MemoryReminderStore()), expectStatus(404));
  });
});

describe("reminder send history (with deliverReminder)", () => {
  const send = (store: MemoryReminderStore, draftId: number | null, respond: () => Promise<Response>, env: Record<string, string> = ZAPIER_ENV) => {
    const f = fakeFetch(respond);
    const result = deliverReminder(reminderInvoice(), input, Date.now(), {
      env,
      fetchImpl: f.impl,
      guard: new ReminderSendGuard(),
      audit: reminderAudit(42, input, draftId, store),
    });
    return { result, f };
  };

  test("an accepted send turns the draft into SENT history with the sent text and recipient", async () => {
    const store = new MemoryReminderStore();
    const draft = store.add({ invoiceId: 42, subject: "old" });
    assert.equal((await send(store, draft.id, async () => new Response("ok")).result).delivered, true);
    assert.equal(store.get(draft.id)!.status, "SENT");
    assert.equal(store.get(draft.id)!.subject, input.subject);
    assert.equal(store.get(draft.id)!.recipient, "billing@acme.test");
    await assert.rejects(deleteReminderDraft(draft.id, store), expectStatus(409));
  });

  test("unsaved text is recorded as history too", async () => {
    const store = new MemoryReminderStore();
    await send(store, null, async () => new Response("ok")).result;
    assert.equal(store.rows.length, 1);
    assert.equal(store.rows[0].status, "SENT");
  });

  test("while the send is in flight the draft cannot be deleted", async () => {
    const store = new MemoryReminderStore();
    const draft = store.add({ invoiceId: 42 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { result } = send(store, draft.id, async () => {
      await gate;
      return new Response("ok");
    });
    await new Promise((r) => setImmediate(r));
    await assert.rejects(deleteReminderDraft(draft.id, store), expectStatus(409, /being sent/));
    release();
    await result;
  });

  test("a timeout leaves UNKNOWN history that cannot be deleted", async () => {
    const store = new MemoryReminderStore();
    const draft = store.add({ invoiceId: 42 });
    const { result } = send(store, draft.id, async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    });
    await assert.rejects(result, expectStatus(504));
    assert.equal(store.get(draft.id)!.status, "UNKNOWN");
    await assert.rejects(deleteReminderDraft(draft.id, store), expectStatus(409, /uncertain/));
  });

  test("a definite failure returns a draft to DRAFT (deletable) and records unsaved text as FAILED", async () => {
    const store = new MemoryReminderStore();
    const draft = store.add({ invoiceId: 42 });
    await assert.rejects(send(store, draft.id, async () => new Response("no", { status: 500 })).result, expectStatus(502));
    assert.equal(store.get(draft.id)!.status, "DRAFT");
    await deleteReminderDraft(draft.id, store);

    await assert.rejects(send(store, null, async () => new Response("no", { status: 500 })).result, expectStatus(502));
    assert.equal(store.rows.at(-1)!.status, "FAILED");
  });

  test("sending a draft deleted meanwhile is refused before any Zapier request", async () => {
    const store = new MemoryReminderStore();
    const { result, f } = send(store, 99, async () => new Response("ok"));
    await assert.rejects(result, expectStatus(409, /no longer an unsent draft/));
    assert.equal(f.calls.length, 0);
  });

  test("demo mode records nothing and leaves the draft as a draft", async () => {
    const store = new MemoryReminderStore();
    const draft = store.add({ invoiceId: 42 });
    const { result, f } = send(store, draft.id, async () => new Response("ok"), {});
    assert.equal((await result).mode, "demo");
    assert.equal(f.calls.length, 0);
    assert.equal(store.get(draft.id)!.status, "DRAFT");
  });
});

// ── Integration: real routes and MySQL, test-owned records only ──────────────

const STAMP = `${Date.now()}`;
const created = { clientId: 0, invoiceIds: [] as number[] };
let cookie = "";

const idCtx = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) }) as never;
const json = (path: string, method: string, body: unknown, c = cookie) =>
  new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json", ...(c ? { cookie: c } : {}) }, body: JSON.stringify(body) });
const bare = (path: string, method: string, c = cookie) => new NextRequest(`http://localhost${path}`, { method, headers: c ? { cookie: c } : {} });

async function testInvoice(suffix: string, data: Record<string, unknown> = {}) {
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: `INV-TEST-DM-${STAMP}-${suffix}`,
      clientId: created.clientId,
      description: "TEST ONLY - data management test",
      amount: "10.00",
      currency: "USD",
      issueDate: new Date("2026-10-20T00:00:00Z"),
      dueDate: new Date("2026-10-28T00:00:00Z"),
      status: "DRAFT",
      ...data,
    },
  });
  created.invoiceIds.push(invoice.id);
  return invoice;
}

before(async () => {
  cookie = await ownerCookie();
  const client = await prisma.client.create({
    data: { name: `Data Mgmt Test ${STAMP} (TEST ONLY)`, email: "dm-test@example.invalid", company: "TEST ONLY" },
  });
  created.clientId = client.id;
});

after(async () => {
  // Removes only what this file created.
  await prisma.followUpReminder.deleteMany({ where: { invoiceId: { in: created.invoiceIds } } });
  await prisma.invoice.deleteMany({ where: { id: { in: created.invoiceIds }, invoiceNumber: { startsWith: `INV-TEST-DM-${STAMP}-` } } });
  await prisma.client.deleteMany({ where: { id: created.clientId, name: { startsWith: "Data Mgmt Test" } } });
});

describe("DELETE /api/invoices/[id] (integration)", () => {
  test("requires a session", async () => {
    const draft = await testInvoice("noauth");
    assert.equal((await deleteInvoiceRoute(bare(`/api/invoices/${draft.id}`, "DELETE", ""), idCtx(draft.id))).status, 401);
    assert.ok(await prisma.invoice.findUnique({ where: { id: draft.id } }));
  });

  test("rejects malformed ids", async () => {
    for (const id of ["abc", "12abc", "1.5", "0", "-3"]) {
      assert.equal((await deleteInvoiceRoute(bare(`/api/invoices/${id}`, "DELETE"), idCtx(id))).status, 400, id);
    }
  });

  test("deletes an eligible draft; a second delete is 404", async () => {
    const draft = await testInvoice("ok");
    const res = await deleteInvoiceRoute(bare(`/api/invoices/${draft.id}`, "DELETE"), idCtx(draft.id));
    assert.equal(res.status, 200);
    assert.match(((await res.json()) as { message: string }).message, new RegExp(`${draft.invoiceNumber} deleted`));
    assert.equal(await prisma.invoice.findUnique({ where: { id: draft.id } }), null);
    assert.equal((await deleteInvoiceRoute(bare(`/api/invoices/${draft.id}`, "DELETE"), idCtx(draft.id))).status, 404);
  });

  test("concurrent deletes: exactly one succeeds", async () => {
    const draft = await testInvoice("race");
    const results = await Promise.all([1, 2, 3, 4].map(() => deleteInvoiceRoute(bare(`/api/invoices/${draft.id}`, "DELETE"), idCtx(draft.id))));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 404, 404, 404]);
  });

  test("refuses sent, paid, PayPal-linked, emailed, and reminded invoices — and keeps them", async () => {
    const cases = [
      await testInvoice("sent", { status: "SENT" }),
      await testInvoice("paid", { status: "PAID", paypalCaptureId: `TEST-DM-CAP-${STAMP}`, paidAt: new Date() }),
      await testInvoice("order", { paypalOrderId: `TEST-DM-ORD-${STAMP}` }),
      await testInvoice("emailed", { emailState: "ACCEPTED", emailStateAt: new Date() }),
      await testInvoice("cancelled", { status: "CANCELLED" }),
    ];
    const reminded = await testInvoice("reminded");
    await prisma.followUpReminder.create({ data: { invoiceId: reminded.id, status: "SENT", subject: "s", message: "m", sentAt: new Date() } });
    cases.push(reminded);

    for (const invoice of cases) {
      const res = await deleteInvoiceRoute(bare(`/api/invoices/${invoice.id}`, "DELETE"), idCtx(invoice.id));
      assert.equal(res.status, 409, invoice.invoiceNumber);
      assert.ok(((await res.json()) as { error: string }).error.includes(invoice.invoiceNumber));
      assert.ok(await prisma.invoice.findUnique({ where: { id: invoice.id } }), `${invoice.invoiceNumber} must still exist`);
    }
    assert.equal(await prisma.followUpReminder.count({ where: { invoiceId: reminded.id } }), 1);
  });

  test("cross-site browser requests are refused", async () => {
    const draft = await testInvoice("xsite");
    const req = new NextRequest(`http://localhost/api/invoices/${draft.id}`, { method: "DELETE", headers: { cookie, "sec-fetch-site": "cross-site" } });
    assert.equal((await deleteInvoiceRoute(req, idCtx(draft.id))).status, 403);
    assert.ok(await prisma.invoice.findUnique({ where: { id: draft.id } }));
  });
});

describe("client archiving (integration)", () => {
  const listIds = async (query = "") => {
    const res = await listClientsRoute(bare(`/api/clients${query}`, "GET"));
    assert.equal(res.status, 200);
    return ((await res.json()) as { data: { id: number }[] }).data.map((c) => c.id);
  };
  const patch = (id: number | string, body: unknown, c = cookie) => archiveClientRoute(json(`/api/clients/${id}`, "PATCH", body, c), idCtx(id));

  test("rejects unauthenticated, malformed, and unknown requests", async () => {
    assert.equal((await patch(created.clientId, { archived: true }, "")).status, 401);
    assert.equal((await patch("abc", { archived: true })).status, 400);
    assert.equal((await patch(created.clientId, { archived: "yes" })).status, 422);
    assert.equal((await patch(99_999_999, { archived: true })).status, 404);
    assert.equal((await listClientsRoute(bare("/api/clients?archived=maybe", "GET"))).status, 400);
    const client = await prisma.client.findUnique({ where: { id: created.clientId } });
    assert.equal(client?.archivedAt, null);
  });

  test("archive hides the client from selection and new invoices, keeps its invoices, and restore brings it back", async () => {
    const history = await testInvoice("history", { status: "SENT" });
    const before = await prisma.invoice.findMany({ where: { clientId: created.clientId }, orderBy: { id: "asc" } });

    // Concurrent archive requests are harmless.
    const [a, b] = await Promise.all([patch(created.clientId, { archived: true }), patch(created.clientId, { archived: true })]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    const messages = [((await a.json()) as { message: string }).message, ((await b.json()) as { message: string }).message].sort();
    assert.match(messages.join(" | "), /archived\..*already archived|already archived.*archived\./);

    assert.ok(!(await listIds()).includes(created.clientId), "archived client must not be offered for selection");
    assert.ok((await listIds("?archived=true")).includes(created.clientId));

    const res = await createInvoiceRoute(
      json("/api/invoices", "POST", { clientId: created.clientId, description: "x", amount: 5, currency: "USD", issueDate: "2026-10-24", dueDate: "2026-11-07" })
    );
    assert.equal(res.status, 422);
    assert.match(JSON.stringify(await res.json()), /is archived/);

    // Invoices and their relationship are unchanged.
    const afterArchive = await prisma.invoice.findMany({ where: { clientId: created.clientId }, orderBy: { id: "asc" } });
    assert.deepEqual(afterArchive.map((i) => [i.id, i.status, i.updatedAt.getTime()]), before.map((i) => [i.id, i.status, i.updatedAt.getTime()]));
    assert.ok(afterArchive.some((i) => i.id === history.id));

    const restore = await patch(created.clientId, { archived: false });
    assert.equal(restore.status, 200);
    assert.ok((await listIds()).includes(created.clientId));
    assert.ok(!(await listIds("?archived=true")).includes(created.clientId));
  });
});

describe("reminder drafts (integration)", () => {
  test("save, list, and delete an unsent draft for a remindable invoice", async () => {
    const invoice = await testInvoice("remind", { status: "SENT" });
    const save = await saveDraftRoute(json("/api/follow-ups/drafts", "POST", { invoiceId: invoice.id, subject: `Reminder ${invoice.invoiceNumber}`, message: `Please pay ${invoice.invoiceNumber}.` }));
    assert.equal(save.status, 200);
    const { data } = (await save.json()) as { data: { id: number } };

    const list = (await (await listDraftsRoute(bare("/api/follow-ups/drafts", "GET"))).json()) as { data: { id: number; invoiceId: number }[] };
    assert.ok(list.data.some((d) => d.id === data.id && d.invoiceId === invoice.id));

    const del = await deleteDraftRoute(bare(`/api/follow-ups/drafts/${data.id}`, "DELETE"), idCtx(data.id));
    assert.equal(del.status, 200);
    assert.equal(await prisma.followUpReminder.findUnique({ where: { id: data.id } }), null);
    assert.equal((await deleteDraftRoute(bare(`/api/follow-ups/drafts/${data.id}`, "DELETE"), idCtx(data.id))).status, 404);
    assert.ok(await prisma.invoice.findUnique({ where: { id: invoice.id } }), "the invoice is never touched");
  });

  test("never deletes sent, in-progress, uncertain, or failed reminders", async () => {
    const invoice = await testInvoice("history-r", { status: "SENT" });
    for (const status of ["SENDING", "UNKNOWN", "SENT", "FAILED"] as const) {
      const row = await prisma.followUpReminder.create({ data: { invoiceId: invoice.id, status, subject: "s", message: "m" } });
      const res = await deleteDraftRoute(bare(`/api/follow-ups/drafts/${row.id}`, "DELETE"), idCtx(row.id));
      assert.equal(res.status, 409, status);
      assert.deepEqual(await prisma.followUpReminder.findUnique({ where: { id: row.id } }), row);
    }
  });

  test("drafts only for invoices that can receive reminders; ids and auth are validated", async () => {
    const draftInvoice = await testInvoice("not-remindable");
    const res = await saveDraftRoute(json("/api/follow-ups/drafts", "POST", { invoiceId: draftInvoice.id, subject: "s", message: `m ${draftInvoice.invoiceNumber}` }));
    assert.equal(res.status, 409);
    assert.equal(await prisma.followUpReminder.count({ where: { invoiceId: draftInvoice.id } }), 0);

    assert.equal((await deleteDraftRoute(bare("/api/follow-ups/drafts/abc", "DELETE"), idCtx("abc"))).status, 400);
    assert.equal((await deleteDraftRoute(bare("/api/follow-ups/drafts/1", "DELETE", ""), idCtx(1))).status, 401);
    assert.equal((await saveDraftRoute(json("/api/follow-ups/drafts", "POST", { invoiceId: 1, subject: "s", message: "m", draftId: "x" }))).status, 422);
    // The send route validates draftId before any lookup or Zapier call.
    assert.equal((await sendReminderRoute(json("/api/follow-ups/send", "POST", { invoiceId: 1, subject: "s", message: "m", draftId: 0 }))).status, 422);
  });
});

// ── UI wiring (source checks; client components are not rendered in Node) ───

describe("data-management UI", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

  test("Invoices: Delete only on DRAFT rows, confirmed by a dialog naming the invoice, then the list reloads", () => {
    const page = read("src/app/invoices/page.tsx");
    assert.match(page, /\{invoice\.status === "DRAFT" && \(\s*<button[\s\S]*?id=\{`delete-invoice-\$\{invoice\.id\}`\}/);
    assert.match(page, /title=\{`Delete draft \$\{deleteTarget\.invoiceNumber\}\?`\}/);
    assert.match(page, /fetch\(`\/api\/invoices\/\$\{deleteTarget\.id\}`, \{ method: "DELETE" \}\)/);
    assert.match(page, /fetchInvoices\(\)\.catch/);
  });

  test("Clients: archive is confirmed, archived clients are labelled and listed separately with Restore", () => {
    const page = read("src/app/clients/page.tsx");
    assert.match(page, /"\/api\/clients\?archived=true"/);
    assert.match(page, /title=\{`Archive \$\{archiveTarget\.name\}\?`\}/);
    assert.match(page, /Archived\s*<\/span>/);
    assert.match(page, /id=\{`restore-client-\$\{client\.id\}`\}/);
  });

  test("Create Invoice uses the default (active-only) client list", () => {
    assert.match(read("src/app/create-invoice/page.tsx"), /fetch\("\/api\/clients"\)/);
  });

  test("Follow-ups: drafts are saved and deleted through the server with confirmation; sends reference the draft", () => {
    const page = read("src/app/follow-ups/page.tsx");
    assert.match(page, /fetch\(`\/api\/follow-ups\/drafts\/\$\{draftId\}`, \{ method: "DELETE" \}\)/);
    assert.match(page, /id="delete-reminder-draft"/);
    assert.match(page, /\.\.\.\(draftIds\[id\] \? \{ draftId: draftIds\[id\] \} : \{\}\)/);
    assert.match(page, /\{draftIds\[id\] && !sent && \(\s*<button\s+id=\{`delete-draft-\$\{id\}`\}/);
  });

  test("the confirmation dialog is accessible and safe by default", () => {
    const dialog = read("src/components/ConfirmDialog.tsx");
    assert.match(dialog, /role="alertdialog"/);
    assert.match(dialog, /aria-modal="true"/);
    assert.match(dialog, /cancelRef\.current\?\.focus\(\)/);
    assert.match(dialog, /createPortal\(/);
  });
});
