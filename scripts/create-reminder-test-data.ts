/**
 * DEVELOPMENT ONLY — creates a clearly labelled, disposable SENT test invoice
 * so the real Follow-ups -> Zapier -> Gmail flow can be exercised. Sends
 * nothing; you draft and approve the reminder in the UI.
 *
 *   npm run test-data:reminder -- --email you@your-own-domain.com
 *       Uses a dedicated "ClearCollect Reminder Test (TEST ONLY)" client.
 *   npm run test-data:reminder -- --email you@your-own-domain.com --use-existing-client
 *       Opt-in: attaches the test invoice to the one existing client with that
 *       email (only if you control that inbox). The client is not modified.
 *   npm run test-data:reminder -- --cleanup
 *
 * Safety:
 * - Refuses NODE_ENV=production and non-local databases.
 * - Never modifies existing clients or existing invoices.
 * - Without --use-existing-client, refuses any email that belongs to a client.
 * - Test invoices are identified by the INV-TEST-REMINDER- prefix AND the
 *   "TEST ONLY" description; cleanup deletes only those (never paid ones) and
 *   only ever deletes the dedicated test client, never a real client.
 * - Prints no secrets, URLs or full email addresses.
 */

import { prisma } from "@/lib/prisma";
import { loadRemindableInvoice } from "@/lib/follow-up";
import {
  TEST_CLIENT_COMPANY,
  TEST_CLIENT_NAME,
  TEST_DESCRIPTION_LABEL,
  TEST_INVOICE_PREFIX,
  TestDataError,
  assertDevEnvironment,
  assertSafeTestEmail,
  assertWouldBeEligible,
  buildTestInvoice,
  findExistingClientForEmail,
  isDisposableTestInvoice,
  maskEmail,
  parseArgs,
} from "./lib/reminder-test-data";

const testClientWhere = { name: TEST_CLIENT_NAME, company: TEST_CLIENT_COMPANY };
const testInvoiceWhere = {
  invoiceNumber: { startsWith: TEST_INVOICE_PREFIX },
  description: { startsWith: TEST_DESCRIPTION_LABEL },
};

async function create(email: string, useExistingClient: boolean) {
  const realClients = await prisma.client.findMany({
    where: { NOT: testClientWhere },
    select: { id: true, name: true, email: true },
  });

  let clientId: number;
  let recipient: string;
  let clientLabel: string;
  if (useExistingClient) {
    // Opt-in: read-only lookup of the single client with this email.
    clientId = findExistingClientForEmail(email, realClients);
    recipient = email.trim();
    assertWouldBeEligible(recipient);
    clientLabel = `${realClients.find((c) => c.id === clientId)!.name} (existing client, not modified)`;
  } else {
    recipient = assertSafeTestEmail(email, realClients.map((c) => c.email));
    assertWouldBeEligible(recipient);
    // Reuse the dedicated test client if it exists (only its email may change).
    const existing = await prisma.client.findFirst({ where: testClientWhere });
    const client = existing
      ? await prisma.client.update({ where: { id: existing.id }, data: { email: recipient } })
      : await prisma.client.create({ data: { ...testClientWhere, email: recipient } });
    clientId = client.id;
    clientLabel = client.name;
  }

  // Avoid duplicates: reuse an unpaid test invoice for this client that is still eligible.
  const existingInvoice = await prisma.invoice.findFirst({
    where: { ...testInvoiceWhere, clientId, status: { in: ["SENT", "OVERDUE"] }, paypalCaptureId: null },
    orderBy: { id: "desc" },
  });
  const invoice = existingInvoice ?? (await prisma.invoice.create({ data: buildTestInvoice(clientId, Date.now()) }));

  // Confirm with the exact production eligibility check used by the send API.
  const checked = await loadRemindableInvoice(invoice.id);

  console.log(existingInvoice ? "Reusing existing test invoice:" : "Created test invoice:");
  console.log(`  client   #${clientId}  ${clientLabel}  (recipient ${maskEmail(recipient)})`);
  console.log(
    `  invoice  #${checked.id}  ${checked.invoiceNumber}  ${checked.currency} ${checked.amount.toString()}  ` +
      `status ${checked.status}  due ${checked.dueDate.toISOString().slice(0, 10)}`
  );
  console.log("Eligibility: passes the production reminder checks. Nothing was sent.");
  console.log("Next: open /follow-ups, click Review Reminder -> Draft with AI -> Approve & Send.");
  console.log("Remove afterwards with: npm run test-data:reminder -- --cleanup");
}

async function cleanup() {
  // Test invoices may belong to the dedicated test client or (opt-in) a real client.
  const candidates = await prisma.invoice.findMany({
    where: testInvoiceWhere,
    select: { id: true, invoiceNumber: true, description: true, status: true, paypalCaptureId: true },
  });
  const testInvoices = candidates.filter(isDisposableTestInvoice);
  if (testInvoices.some((i) => i.status === "PAID" || i.paypalCaptureId)) {
    throw new TestDataError("A test invoice has been paid; leaving everything in place. Review it manually.");
  }

  const testClient = await prisma.client.findFirst({ where: testClientWhere });
  const result = await prisma.$transaction(async (tx) => {
    const { count } = await tx.invoice.deleteMany({
      where: { id: { in: testInvoices.map((i) => i.id) }, paypalCaptureId: null, NOT: { status: "PAID" } },
    });
    // Only the dedicated test client is ever deleted, and only once it has no invoices left.
    let clientRemoved = false;
    if (testClient && (await tx.invoice.count({ where: { clientId: testClient.id } })) === 0) {
      await tx.client.delete({ where: { id: testClient.id } });
      clientRemoved = true;
    }
    return { count, clientRemoved };
  });

  console.log(`Removed ${result.count} test invoice(s).`);
  if (testClient) {
    console.log(
      result.clientRemoved
        ? `Removed the dedicated test client #${testClient.id}.`
        : `Kept test client #${testClient.id} because it still has non-test invoices.`
    );
  }
  console.log("Existing clients were not modified.");
}

try {
  assertDevEnvironment(process.env);
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "create") await create(args.email, args.useExistingClient);
  else await cleanup();
} catch (err) {
  const message = err instanceof Error ? err.message : "Unknown error";
  console.error(`Not completed: ${message}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
