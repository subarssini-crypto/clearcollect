/**
 * Transactions: verified payment metadata and listing.
 * No PayPal calls and no database writes — payment recording runs against an
 * in-memory store with the same conditional semantics as prismaPaymentStore;
 * the route test only reads.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Environment } from "@paypal/paypal-server-sdk";
import {
  PaymentError,
  recordVerifiedPayment,
  verifiedPaymentRecord,
  type PaymentStore,
  type VerifiedPaymentRecord,
} from "@/lib/paypal";
import { toTransaction, type TransactionRow } from "@/lib/transactions";
import { prisma } from "@/lib/prisma";
import { GET as transactionsRoute } from "@/app/api/transactions/route";
import { NextRequest } from "next/server";
import { ownerCookie } from "./auth-helpers";

const VERIFIED_AT = new Date("2026-10-24T10:00:00Z");

describe("verifiedPaymentRecord", () => {
  test("uses PayPal's capture time and the server's environment", () => {
    const record = verifiedPaymentRecord({ id: "CAP123", createTime: "2026-10-24T09:58:12Z" }, Environment.Sandbox, VERIFIED_AT);
    assert.deepEqual(record, { captureId: "CAP123", paidAt: new Date("2026-10-24T09:58:12Z"), environment: "SANDBOX" });
    assert.equal(verifiedPaymentRecord({ id: "CAP123" }, Environment.Production, VERIFIED_AT).environment, "LIVE");
  });

  test("falls back to the verification time when PayPal omits or garbles create_time", () => {
    assert.equal(verifiedPaymentRecord({ id: "CAP1" }, Environment.Sandbox, VERIFIED_AT).paidAt, VERIFIED_AT);
    assert.equal(verifiedPaymentRecord({ id: "CAP1", createTime: "not a date" }, Environment.Sandbox, VERIFIED_AT).paidAt, VERIFIED_AT);
  });
});

type Row = {
  id: number;
  status: string;
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
  paidAt: Date | null;
  paypalEnvironment: string | null;
};

/** Same conditions as prismaPaymentStore.markPaid, plus the unique capture ID. */
class MemoryPaymentStore implements PaymentStore {
  writes = 0;
  constructor(public rows: Row[]) {}
  async markPaid(invoiceId: number, orderId: string, record: VerifiedPaymentRecord) {
    const row = this.rows.find(
      (r) => r.id === invoiceId && r.paypalOrderId === orderId && r.paypalCaptureId === null && (r.status === "SENT" || r.status === "OVERDUE")
    );
    if (!row) return false;
    if (this.rows.some((r) => r.paypalCaptureId === record.captureId)) throw new Error("Unique constraint failed on paypalCaptureId");
    Object.assign(row, { status: "PAID", paypalCaptureId: record.captureId, paidAt: record.paidAt, paypalEnvironment: record.environment });
    this.writes++;
    return true;
  }
  async current(invoiceId: number) {
    const row = this.rows.find((r) => r.id === invoiceId);
    return row ? { status: row.status, paypalCaptureId: row.paypalCaptureId } : null;
  }
}

const sentInvoice = (): Row => ({ id: 1, status: "SENT", paypalOrderId: "ORDER1", paypalCaptureId: null, paidAt: null, paypalEnvironment: null });
const record = (overrides: Partial<VerifiedPaymentRecord> = {}): VerifiedPaymentRecord => ({
  captureId: "CAP1",
  paidAt: new Date("2026-10-24T09:58:12Z"),
  environment: "SANDBOX",
  ...overrides,
});

describe("recordVerifiedPayment", () => {
  test("a verified capture marks the invoice PAID with capture ID, time, and environment", async () => {
    const store = new MemoryPaymentStore([sentInvoice()]);
    assert.equal(await recordVerifiedPayment(1, "ORDER1", record(), store), "recorded");
    assert.deepEqual(store.rows[0], {
      id: 1,
      status: "PAID",
      paypalOrderId: "ORDER1",
      paypalCaptureId: "CAP1",
      paidAt: new Date("2026-10-24T09:58:12Z"),
      paypalEnvironment: "SANDBOX",
    });
  });

  test("duplicate webhook/return for the same capture is a no-op and keeps the first record", async () => {
    const store = new MemoryPaymentStore([sentInvoice()]);
    await recordVerifiedPayment(1, "ORDER1", record(), store);
    // The same capture processed again later (webhook retry, or return after webhook).
    const again = await recordVerifiedPayment(1, "ORDER1", record({ paidAt: new Date("2026-10-25T00:00:00Z") }), store);
    assert.equal(again, "already_recorded");
    assert.equal(store.writes, 1);
    assert.equal(store.rows.length, 1);
    assert.deepEqual(store.rows[0].paidAt, new Date("2026-10-24T09:58:12Z"));
  });

  test("concurrent deliveries of the same event record it once", async () => {
    const store = new MemoryPaymentStore([sentInvoice()]);
    const results = await Promise.all([1, 2, 3].map(() => recordVerifiedPayment(1, "ORDER1", record(), store)));
    assert.deepEqual(results.sort(), ["already_recorded", "already_recorded", "recorded"]);
    assert.equal(store.writes, 1);
  });

  test("a different capture for an already-paid invoice is refused for review", async () => {
    const store = new MemoryPaymentStore([sentInvoice()]);
    await recordVerifiedPayment(1, "ORDER1", record(), store);
    await assert.rejects(recordVerifiedPayment(1, "ORDER1", record({ captureId: "CAP2" }), store), (err: unknown) => err instanceof PaymentError && err.status === 409);
    assert.equal(store.rows[0].paypalCaptureId, "CAP1");
  });

  test("drafts, cancelled invoices, and invoices tied to another order are never marked paid", async () => {
    for (const row of [
      { ...sentInvoice(), status: "DRAFT" },
      { ...sentInvoice(), status: "CANCELLED" },
      { ...sentInvoice(), paypalOrderId: "OTHER" },
    ]) {
      const store = new MemoryPaymentStore([row]);
      await assert.rejects(recordVerifiedPayment(1, "ORDER1", record(), store), PaymentError);
      assert.equal(store.rows[0].paidAt, null);
      assert.notEqual(store.rows[0].status, "PAID");
    }
  });
});

describe("toTransaction", () => {
  const row = (overrides: Partial<TransactionRow> = {}): TransactionRow => ({
    id: 9,
    invoiceNumber: "INV-2026-009",
    amount: "1830.5",
    currency: "EUR",
    paypalCaptureId: "CAP9",
    paidAt: new Date("2026-10-24T09:58:12.000Z"),
    paypalEnvironment: "SANDBOX",
    client: { name: "Acme Corp" },
    ...overrides,
  });

  test("maps a verified payment with full metadata", () => {
    assert.deepEqual(toTransaction(row()), {
      invoiceId: 9,
      invoiceNumber: "INV-2026-009",
      clientName: "Acme Corp",
      amount: "1830.50",
      currency: "EUR",
      method: "PayPal",
      paidAt: "2026-10-24T09:58:12.000Z",
      captureId: "CAP9",
      environment: "SANDBOX",
    });
  });

  test("missing metadata stays null (shown as Unavailable), never invented", () => {
    const t = toTransaction(row({ paidAt: null, paypalEnvironment: null }));
    assert.equal(t.paidAt, null);
    assert.equal(t.environment, null);
    assert.equal(t.captureId, "CAP9");
    const noCapture = toTransaction(row({ paypalCaptureId: null, paidAt: null, paypalEnvironment: null }));
    assert.equal(noCapture.method, null);
    assert.equal(noCapture.captureId, null);
  });
});

describe("GET /api/transactions", () => {
  const get = async (query = "", cookie?: string) =>
    transactionsRoute(new NextRequest(`http://localhost/api/transactions${query}`, { headers: cookie ? { cookie } : {} }));

  test("requires a session", async () => {
    assert.equal((await get()).status, 401);
  });

  test("lists exactly the PAID invoices — no drafts, unpaid, or cancelled invoices", async () => {
    const res = await get("?limit=100", await ownerCookie());
    assert.equal(res.status, 200);
    const json = (await res.json()) as { ok: boolean; data: { invoiceId: number; method: string | null; captureId: string | null }[]; meta: { total: number } };
    assert.equal(json.ok, true);

    const paid = await prisma.invoice.findMany({ where: { status: "PAID" }, select: { id: true } });
    assert.equal(json.meta.total, paid.length);
    const listed = new Set(json.data.map((t) => t.invoiceId));
    if (paid.length <= 100) assert.deepEqual(listed, new Set(paid.map((p) => p.id)));

    const notPaid = await prisma.invoice.findMany({ where: { status: { not: "PAID" } }, select: { id: true } });
    for (const { id } of notPaid) assert.ok(!listed.has(id), `invoice ${id} is not PAID but was listed`);
    for (const t of json.data) assert.equal(t.method, t.captureId ? "PayPal" : null);
  });

  test("clamps pagination", async () => {
    const json = (await (await get("?limit=1000&page=-3", await ownerCookie())).json()) as { meta: { limit: number; page: number } };
    assert.equal(json.meta.limit, 100);
    assert.equal(json.meta.page, 1);
  });
});

describe("Transactions page and navigation", () => {
  const page = readFileSync(new URL("../src/app/transactions/page.tsx", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../src/components/AppShell.tsx", import.meta.url), "utf8");

  test("has loading, empty, and error states and shows Unavailable for missing fields", () => {
    assert.match(page, /Loading transactions…/);
    assert.match(page, /No transactions yet/);
    assert.match(page, /<Notice tone="error">\{error\}<\/Notice>/);
    assert.match(page, /t\.paidAt \? <time dateTime=\{t\.paidAt\}>\{localDateTime\(t\.paidAt\)\}<\/time> : <Unavailable \/>/);
    assert.match(page, /t\.captureId \?\? <Unavailable \/>/);
    assert.match(page, /if \(!environment\) return <Unavailable \/>/);
  });

  test("formats times in the viewer's local time zone, client-side", () => {
    assert.match(page, /toLocaleString\(undefined, \{[^}]*timeZoneName: "short"/);
    assert.match(page, /^"use client";/);
  });

  test("uses theme tokens only (light and dark)", () => {
    assert.doesNotMatch(page, /\bbg-white\b|#[0-9a-f]{3,8}\b/i);
  });

  test("Transactions is a sidebar item; the top navigation bar is unchanged", () => {
    assert.match(shell, /\{ href: "\/transactions", label: "Transactions", icon: ICONS\.transactions, sidebarOnly: true \}/);
    assert.match(shell, /NAV\.filter\(\(item\) => !item\.sidebarOnly\)\.map/);
  });
});
