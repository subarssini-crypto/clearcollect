/**
 * Test-owned client and invoice fixtures for files that only need a few rows.
 * Everything is named "Fixture Test <tag> <stamp>" / INV-TEST-<tag>-<stamp>-…
 * and removed by `cleanup()` (call it from `after`), children first.
 */

import { prisma } from "@/lib/prisma";
import { cleanupTestRecords } from "./cleanup";

export function testFixtures(tag: string) {
  const stamp = `${Date.now()}`;
  const clientName = `Fixture Test ${tag} ${stamp} (TEST ONLY)`;
  const numberPrefix = `INV-TEST-${tag}-${stamp}-`;
  const ids = { clients: [] as number[], invoices: [] as number[] };

  return {
    stamp,
    async client() {
      const client = await prisma.client.create({
        data: { name: clientName, email: `fixture-${tag.toLowerCase()}@example.invalid`, company: "TEST ONLY" },
      });
      ids.clients.push(client.id);
      return client;
    },
    async invoice(clientId: number, suffix: string, data: Record<string, unknown> = {}) {
      const invoice = await prisma.invoice.create({
        data: {
          invoiceNumber: `${numberPrefix}${suffix}`,
          clientId,
          description: `TEST ONLY - ${tag} fixture`,
          amount: "10.00",
          currency: "USD",
          issueDate: new Date("2026-10-20T00:00:00Z"),
          dueDate: new Date("2099-10-28T00:00:00Z"),
          status: "SENT",
          ...data,
        },
      });
      ids.invoices.push(invoice.id);
      return invoice;
    },
    cleanup: () =>
      cleanupTestRecords(
        () => prisma.followUpReminder.deleteMany({ where: { invoiceId: { in: ids.invoices } } }),
        () => prisma.paymentReview.deleteMany({ where: { invoiceId: { in: ids.invoices } } }),
        () => prisma.invoice.deleteMany({ where: { id: { in: ids.invoices }, invoiceNumber: { startsWith: numberPrefix } } }),
        () => prisma.client.deleteMany({ where: { id: { in: ids.clients }, name: clientName } }),
      ),
  };
}
