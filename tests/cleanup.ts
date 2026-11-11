/**
 * Test-record cleanup that always runs to completion.
 *
 * node:test runs `after` hooks even when tests or `before` hooks fail; this
 * makes the hook itself robust: every step runs even if an earlier one
 * throws, Prisma is always disconnected, and any failures are reported
 * together afterwards. List steps children-first (FK order).
 */

import { prisma } from "@/lib/prisma";

type Step = () => Promise<unknown> | unknown;

export async function cleanupTestRecords(...steps: Step[]): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      errors.push(err);
    }
  }
  try {
    await prisma.$disconnect();
  } catch (err) {
    errors.push(err);
  }
  if (errors.length > 0) throw new AggregateError(errors, `test cleanup: ${errors.length} step(s) failed; leftovers can be removed with npm run test:db:reset`);
}
