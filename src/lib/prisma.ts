/**
 * Prisma Client singleton for Next.js
 *
 * In development, Next.js hot-reloads the module graph on every file save,
 * which would create a new PrismaClient instance on each reload and quickly
 * exhaust the MySQL connection pool. We work around this by caching the
 * instance on the global object (which survives hot-reloads) and only in
 * the development environment.
 *
 * In production there is no hot-reload, so a module-level singleton is fine.
 *
 * Usage:
 *   import { prisma } from '@/lib/prisma'
 *   const invoices = await prisma.invoice.findMany()
 */

import { PrismaClient } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "warn", "error"]
        : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
