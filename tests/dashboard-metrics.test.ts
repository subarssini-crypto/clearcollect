/**
 * Offline tests for dashboard metrics — pure computation over invoice records.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { computeDashboard, displayStatus, type DashboardInvoice } from "@/lib/dashboard-metrics";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const acme = { id: 1, name: "Acme Corp", company: null };
const monish = { id: 2, name: "Monish", company: "Studio M" };

let nextId = 1;
function inv(overrides: Partial<DashboardInvoice>): DashboardInvoice {
  const id = nextId++;
  return {
    id,
    invoiceNumber: `INV-2026-${String(id).padStart(3, "0")}`,
    amount: "100.00",
    currency: "USD",
    issueDate: "2026-10-01T00:00:00.000Z",
    dueDate: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    status: "SENT",
    paypalCaptureId: null,
    client: acme,
    ...overrides,
  };
}

describe("displayStatus", () => {
  test("SENT past due is Overdue; due today or later is Pending", () => {
    assert.equal(displayStatus(inv({ dueDate: "2026-10-18T00:00:00.000Z" }), NOW), "Overdue");
    assert.equal(displayStatus(inv({ dueDate: "2026-10-19T00:00:00.000Z" }), NOW), "Pending");
    assert.equal(displayStatus(inv({ status: "PAID", dueDate: "2020-01-01T00:00:00.000Z" }), NOW), "Paid");
  });
});

describe("computeDashboard", () => {
  const invoices = [
    inv({ status: "PAID", amount: "1830.00", updatedAt: "2026-10-05T10:00:00.000Z", paypalCaptureId: "CAP1" }),
    inv({ status: "PAID", amount: "10.10", issueDate: "2026-08-10T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z", client: monish }),
    inv({ status: "SENT", amount: "200.20", dueDate: "2026-10-25T00:00:00.000Z" }),
    inv({ status: "SENT", amount: "300.30", dueDate: "2026-10-10T00:00:00.000Z", client: monish }),
    inv({ status: "OVERDUE", amount: "50.00", dueDate: "2026-09-01T00:00:00.000Z" }),
    inv({ status: "DRAFT", amount: "999.00" }),
    inv({ status: "CANCELLED", amount: "500.00" }),
    inv({ status: "SENT", amount: "70000", currency: "JPY" }),
  ];
  const m = computeDashboard(invoices, NOW);

  test("sums money exactly in the dominant currency and counts the rest separately", () => {
    assert.equal(m.currency, "USD");
    assert.equal(m.otherCurrencyCount, 1);
    assert.equal(m.collected, 1840.1);
    assert.equal(m.collectedCount, 2);
    assert.equal(m.collectedViaPaypalCount, 1);
    assert.equal(m.collectedThisMonth, 1830);
    assert.equal(m.outstanding, 550.5); // 200.20 + 300.30 + 50.00
    assert.equal(m.outstandingCount, 3);
    assert.equal(m.overdue, 350.3); // 300.30 (past due SENT) + 50.00 (OVERDUE)
    assert.equal(m.overdueCount, 2);
  });

  test("drafts and cancelled invoices are excluded from money totals", () => {
    assert.equal(m.draftCount, 1);
    assert.equal(m.statusCounts.Cancelled, 1);
    // 1830 + 10.10 + 200.20 + 300.30 + 50 — no 999 draft or 500 cancelled.
    const billed = m.topClients.reduce((s, c) => s + Math.round(c.billed * 100), 0) / 100;
    assert.equal(billed, 2390.6);
  });

  test("collection rate is collected / (collected + outstanding)", () => {
    assert.ok(m.collectionRate !== null);
    assert.equal(Math.round(m.collectionRate * 10000), Math.round((1840.1 / (1840.1 + 550.5)) * 10000));
  });

  test("monthly series covers the last 6 months with invoiced by issue date and collected by payment date", () => {
    assert.deepEqual(m.monthly.map((p) => p.key), ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    const byKey = Object.fromEntries(m.monthly.map((p) => [p.key, p]));
    assert.equal(byKey["2026-08"].invoiced, 10.1);
    assert.equal(byKey["2026-09"].collected, 10.1);
    assert.equal(byKey["2026-10"].invoiced, 1830 + 200.2 + 300.3 + 50);
    assert.equal(byKey["2026-10"].collected, 1830);
  });

  test("upcoming lists pending invoices soonest first; follow-ups list overdue most overdue first", () => {
    assert.deepEqual(m.upcoming.map((u) => [u.amount, u.days]), [[200.2, 6]]);
    assert.deepEqual(m.followUps.map((f) => [f.amount, f.days]), [[50, 48], [300.3, 9]]);
  });

  test("top clients are ranked by billed amount with paid share", () => {
    assert.deepEqual(
      m.topClients.map((c) => [c.name, c.billed, c.paid, c.invoiceCount]),
      [
        ["Acme Corp", 2080.2, 1830, 3],
        ["Monish", 310.4, 10.1, 2],
      ]
    );
  });

  test("recent invoices are newest first and limited to 6", () => {
    assert.equal(m.recent.length, 6);
    assert.equal(m.recent[0].invoice.issueDate.slice(0, 10), "2026-10-01");
    assert.ok(m.recent.every((r, i, a) => i === 0 || a[i - 1].invoice.issueDate >= r.invoice.issueDate));
  });

  test("empty data produces zeroed metrics without a collection rate", () => {
    const empty = computeDashboard([], NOW);
    assert.equal(empty.currency, "USD");
    assert.equal(empty.outstanding, 0);
    assert.equal(empty.collectionRate, null);
    assert.equal(empty.monthly.length, 6);
    assert.deepEqual(empty.recent, []);
  });
});
