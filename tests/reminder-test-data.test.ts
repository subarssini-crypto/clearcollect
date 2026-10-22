/**
 * Offline tests for the development-only reminder test-data helpers.
 * No database, Gemini or Zapier access.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { FollowUpError, assertRemindable } from "@/lib/follow-up";
import { nextInvoiceNumber } from "@/lib/invoice-number";
import {
  TEST_CLIENT_COMPANY,
  TEST_CLIENT_NAME,
  TestDataError,
  assertDevEnvironment,
  assertSafeTestEmail,
  assertWouldBeEligible,
  buildTestInvoice,
  findExistingClientForEmail,
  isDisposableTestInvoice,
  isTestInvoiceNumber,
  maskEmail,
  parseArgs,
  testInvoiceShape,
} from "../scripts/lib/reminder-test-data";

const NOW = Date.parse("2026-10-20T14:30:05Z");
const LOCAL_DB = "mysql://user:pass@localhost:3306/clearcollect";

describe("parseArgs", () => {
  test("create mode requires an email", () => {
    assert.deepEqual(parseArgs(["--email", " me@mine.dev "]), { mode: "create", email: "me@mine.dev", useExistingClient: false });
    assert.throws(() => parseArgs([]), TestDataError);
    assert.throws(() => parseArgs(["--email"]), TestDataError);
    assert.throws(() => parseArgs(["--email", "--cleanup"]), TestDataError);
    assert.throws(() => parseArgs(["--email", "a@b.co", "--extra"]), TestDataError);
  });

  test("--use-existing-client is an explicit opt-in, in any position", () => {
    const expected = { mode: "create", email: "me@mine.dev", useExistingClient: true };
    assert.deepEqual(parseArgs(["--email", "me@mine.dev", "--use-existing-client"]), expected);
    assert.deepEqual(parseArgs(["--use-existing-client", "--email", "me@mine.dev"]), expected);
    assert.throws(() => parseArgs(["--use-existing-client"]), TestDataError);
    assert.throws(() => parseArgs(["--email", "me@mine.dev", "--use-existing-client", "--use-existing-client"]), TestDataError);
  });

  test("cleanup mode takes no other arguments", () => {
    assert.deepEqual(parseArgs(["--cleanup"]), { mode: "cleanup" });
    assert.throws(() => parseArgs(["--cleanup", "--email", "a@b.co"]), TestDataError);
  });
});

describe("assertDevEnvironment", () => {
  test("allows a local database outside production", () => {
    assert.doesNotThrow(() => assertDevEnvironment({ DATABASE_URL: LOCAL_DB }));
    assert.doesNotThrow(() => assertDevEnvironment({ DATABASE_URL: LOCAL_DB.replace("localhost", "127.0.0.1"), NODE_ENV: "development" }));
  });

  test("refuses production, remote, or missing databases", () => {
    assert.throws(() => assertDevEnvironment({ DATABASE_URL: LOCAL_DB, NODE_ENV: "production" }), TestDataError);
    assert.throws(() => assertDevEnvironment({ DATABASE_URL: LOCAL_DB.replace("localhost", "db.example.com") }), TestDataError);
    assert.throws(() => assertDevEnvironment({}), TestDataError);
  });
});

describe("assertSafeTestEmail", () => {
  test("accepts a valid address not used by any client", () => {
    assert.equal(assertSafeTestEmail("me@mine.dev", ["billing@acme.test", null]), "me@mine.dev");
  });

  test("rejects an existing client's email (case-insensitive) and points to the opt-in flag", () => {
    assert.throws(
      () => assertSafeTestEmail("Billing@Acme.test", ["billing@acme.test"]),
      (err: unknown) => err instanceof TestDataError && /--use-existing-client/.test(err.message)
    );
  });

  test("rejects invalid addresses using the production email check", () => {
    for (const email of ["", "not-an-email", "a@b"]) {
      assert.throws(() => assertSafeTestEmail(email, []), (err: unknown) => err instanceof FollowUpError && err.status === 422);
    }
  });
});

describe("findExistingClientForEmail (opt-in)", () => {
  const clients = [
    { id: 1, email: "billing@acme.test" },
    { id: 2, email: "Owner@Mine.dev" },
    { id: 3, email: null },
  ];

  test("returns the single matching client (case-insensitive, trimmed)", () => {
    assert.equal(findExistingClientForEmail(" owner@mine.dev ", clients), 2);
  });

  test("refuses when no client or more than one client matches", () => {
    assert.throws(() => findExistingClientForEmail("nobody@mine.dev", clients), TestDataError);
    assert.throws(
      () => findExistingClientForEmail("dup@mine.dev", [{ id: 1, email: "dup@mine.dev" }, { id: 2, email: "DUP@mine.dev" }]),
      TestDataError
    );
  });

  test("still applies the production email check", () => {
    assert.throws(() => findExistingClientForEmail("not-an-email", clients), (err: unknown) => err instanceof FollowUpError && err.status === 422);
  });
});

describe("isDisposableTestInvoice", () => {
  test("requires both the test prefix and the TEST ONLY description", () => {
    const data = buildTestInvoice(2, NOW);
    assert.ok(isDisposableTestInvoice(data));
    assert.ok(!isDisposableTestInvoice({ ...data, invoiceNumber: "INV-2026-008" }));
    assert.ok(!isDisposableTestInvoice({ ...data, description: "Web design" }));
    assert.ok(!isDisposableTestInvoice({ invoiceNumber: "INV-TEST-1001", description: "Real work" }));
  });
});

describe("test invoice data", () => {
  const data = buildTestInvoice(7, NOW);

  test("is clearly labelled and uses a test-only invoice number", () => {
    assert.equal(data.invoiceNumber, "INV-TEST-REMINDER-20261020-143005");
    assert.ok(isTestInvoiceNumber(data.invoiceNumber));
    assert.match(data.description, /^TEST ONLY/);
    assert.equal(data.clientId, 7);
    assert.equal(data.amount, "1.00");
    assert.equal(data.currency, "USD");
  });

  test("does not affect automatic INV-YYYY-NNN numbering", () => {
    assert.equal(nextInvoiceNumber(["INV-2026-008", data.invoiceNumber], 2026), "INV-2026-009");
  });

  test("is SENT and due within the Follow-ups 7-day window", () => {
    assert.equal(data.status, "SENT");
    assert.equal(data.issueDate.toISOString(), "2026-10-20T00:00:00.000Z");
    assert.equal(data.dueDate.toISOString(), "2026-10-23T00:00:00.000Z");
  });

  test("meets the real reminder eligibility rules", () => {
    assert.doesNotThrow(() => assertWouldBeEligible("me@mine.dev", NOW));
    const shape = testInvoiceShape("me@mine.dev", NOW);
    assert.equal(shape.client.name, TEST_CLIENT_NAME);
    assert.equal(shape.client.company, TEST_CLIENT_COMPANY);
    assert.doesNotThrow(() => assertRemindable(shape));
  });

  test("would be rejected if it were paid (eligibility is not bypassed)", () => {
    const shape = testInvoiceShape("me@mine.dev", NOW);
    assert.throws(() => assertRemindable({ ...shape, status: "PAID" }), FollowUpError);
    assert.throws(() => assertRemindable({ ...shape, paypalCaptureId: "CAP" }), FollowUpError);
  });
});

test("maskEmail hides most of the local part", () => {
  assert.equal(maskEmail("someone@mine.dev"), "s***@mine.dev");
});
