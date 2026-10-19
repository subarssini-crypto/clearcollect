/**
 * Offline tests for invoice-number allocation — no database writes. An
 * in-memory store with a unique constraint stands in for MySQL.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  InvoiceNumberExhaustedError,
  MAX_ALLOCATION_ATTEMPTS,
  createWithInvoiceNumber,
  isInvoiceNumberConflict,
  nextInvoiceNumber,
} from "@/lib/invoice-number";
import { validateCreateInvoice } from "@/lib/validation";

/** Mimics Prisma's P2002 error shape for the MySQL unique index. */
function uniqueViolation(target: unknown = "Invoice_invoiceNumber_key") {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta: { target } });
}

/** In-memory table with a unique invoiceNumber; inserts yield first so requests interleave. */
function fakeTable(initial: string[] = []) {
  const numbers = new Set(initial);
  return {
    numbers,
    list: async (year: number) => [...numbers].filter((n) => n.startsWith(`INV-${year}-`)),
    insert: async (n: string) => {
      await new Promise((resolve) => setImmediate(resolve));
      if (numbers.has(n)) throw uniqueViolation();
      numbers.add(n);
      return { invoiceNumber: n };
    },
  };
}

describe("nextInvoiceNumber", () => {
  test("starts at 001 for a year with no invoices", () => {
    assert.equal(nextInvoiceNumber([], 2026), "INV-2026-001");
  });

  test("continues after the highest number for the year, ignoring other years and formats", () => {
    const existing = ["INV-2024-001", "INV-2026-006", "INV-2026-002", "INV-TEST-1001", "INV-PAYPAL-TEST-002", "INV-2027-050"];
    assert.equal(nextInvoiceNumber(existing, 2026), "INV-2026-007");
  });

  test("keeps counting past 999", () => {
    assert.equal(nextInvoiceNumber(["INV-2026-999"], 2026), "INV-2026-1000");
  });
});

describe("isInvoiceNumberConflict", () => {
  test("detects invoiceNumber unique violations (index name or field list)", () => {
    assert.ok(isInvoiceNumberConflict(uniqueViolation()));
    assert.ok(isInvoiceNumberConflict(uniqueViolation(["invoiceNumber"])));
  });

  test("ignores other unique violations and other errors", () => {
    assert.ok(!isInvoiceNumberConflict(uniqueViolation("Invoice_paypalOrderId_key")));
    assert.ok(!isInvoiceNumberConflict(new Error("boom")));
    assert.ok(!isInvoiceNumberConflict(null));
  });
});

describe("createWithInvoiceNumber", () => {
  test("never reuses an existing number (the INV-2026-006 duplicate)", async () => {
    const table = fakeTable(["INV-2026-006"]);
    const created = await createWithInvoiceNumber(2026, table.insert, table.list);
    assert.equal(created.invoiceNumber, "INV-2026-007");
    assert.ok(table.numbers.has("INV-2026-006"), "existing invoice untouched");
  });

  test("retries with a fresh number after a conflict", async () => {
    const table = fakeTable(["INV-2026-001"]);
    const attempts: string[] = [];
    let first = true;
    const created = await createWithInvoiceNumber(
      2026,
      async (n) => {
        attempts.push(n);
        if (first) {
          // Another request takes this number between our read and insert.
          first = false;
          table.numbers.add(n);
          throw uniqueViolation();
        }
        return table.insert(n);
      },
      table.list
    );
    assert.deepEqual(attempts, ["INV-2026-002", "INV-2026-003"]);
    assert.equal(created.invoiceNumber, "INV-2026-003");
  });

  test("concurrent requests all get distinct sequential numbers", async () => {
    const table = fakeTable(["INV-2026-006"]);
    const results = await Promise.all(
      Array.from({ length: 3 }, () => createWithInvoiceNumber(2026, table.insert, table.list))
    );
    assert.deepEqual(results.map((r) => r.invoiceNumber).sort(), ["INV-2026-007", "INV-2026-008", "INV-2026-009"]);
  });

  test("gives up after the maximum attempts", async () => {
    let calls = 0;
    await assert.rejects(
      createWithInvoiceNumber(
        2026,
        async () => {
          calls++;
          throw uniqueViolation();
        },
        async () => []
      ),
      InvoiceNumberExhaustedError
    );
    assert.equal(calls, MAX_ALLOCATION_ATTEMPTS);
  });

  test("does not retry on unrelated errors", async () => {
    let calls = 0;
    await assert.rejects(
      createWithInvoiceNumber(
        2026,
        async () => {
          calls++;
          throw new Error("database down");
        },
        async () => []
      ),
      /database down/
    );
    assert.equal(calls, 1);
  });
});

describe("validateCreateInvoice invoiceNumber", () => {
  const base = {
    clientId: 1,
    description: "Work",
    amount: 10,
    currency: "USD",
    issueDate: "2026-10-19",
    dueDate: "2026-11-02",
  };

  test("omitted or blank invoiceNumber means auto-assign", () => {
    for (const invoiceNumber of [undefined, null, "", "   "]) {
      const result = validateCreateInvoice({ ...base, invoiceNumber });
      assert.ok(result.ok);
      assert.equal(result.data.invoiceNumber, null);
    }
  });

  test("a provided invoiceNumber is kept (trimmed)", () => {
    const result = validateCreateInvoice({ ...base, invoiceNumber: "  INV-2026-050 " });
    assert.ok(result.ok);
    assert.equal(result.data.invoiceNumber, "INV-2026-050");
  });

  test("a non-string invoiceNumber is rejected", () => {
    const result = validateCreateInvoice({ ...base, invoiceNumber: 42 });
    assert.ok(!result.ok);
    assert.deepEqual(result.errors.map((e) => e.field), ["invoiceNumber"]);
  });
});
