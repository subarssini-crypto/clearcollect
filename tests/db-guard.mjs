/**
 * Test database guard. Tests (and the test:db:* scripts) may only ever touch a
 * database that is explicitly configured and identified as a test database.
 *
 * Required (normally from .env.test — see .env.test.example):
 *   TEST_DATABASE_URL           mysql://user:pass@localhost:3306/<name>_test
 *   CLEARCOLLECT_TEST_DATABASE  <name>_test   (must repeat the database name)
 *
 * Refused, aborting before any test code runs:
 *   - TEST_DATABASE_URL missing or not a mysql:// URL
 *   - database name not ending in "_test", or not confirmed by CLEARCOLLECT_TEST_DATABASE
 *   - a non-local host (unless TEST_DATABASE_ALLOW_HOST names that exact host)
 *   - the same database as DATABASE_URL in .env (the development database)
 *   - any other DATABASE_URL already in the environment
 *   - NODE_ENV=production, or a live (non-sandbox) PAYPAL_BASE_URL
 *   - after connecting, the server reporting a different current database
 *
 * On success DATABASE_URL is set to TEST_DATABASE_URL, so Prisma (which
 * never overrides an existing variable from .env) can only reach the test DB.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const TEST_NAME = /^[A-Za-z0-9_]+_test$/;
const SETUP_HINT = "Copy .env.test.example to .env.test, then run: npm run test:db:setup";

export class TestDatabaseGuardError extends Error {
  constructor(reason) {
    super(`Refusing to run against this database: ${reason}\n  ${SETUP_HINT}`);
    this.name = "TestDatabaseGuardError";
  }
}

function parseMysqlUrl(raw, label) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new TestDatabaseGuardError(`${label} is not a valid URL`);
  }
  if (url.protocol !== "mysql:") throw new TestDatabaseGuardError(`${label} must be a mysql:// URL`);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const host = url.hostname.toLowerCase();
  return { database, host, port: url.port || "3306", local: LOCAL_HOSTS.has(host) };
}

/** DATABASE_URL as written in .env (the development database), if any. */
function developmentDatabaseUrl() {
  const file = path.join(ROOT, ".env");
  if (!existsSync(file)) return null;
  const line = readFileSync(file, "utf8").split(/\r?\n/).find((l) => /^\s*DATABASE_URL\s*=/.test(l));
  if (!line) return null;
  return line.replace(/^\s*DATABASE_URL\s*=\s*/, "").trim().replace(/^(["'])(.*)\1$/, "$2");
}

const sameServer = (a, b) => (a.host === b.host || (a.local && b.local)) && a.port === b.port;

/**
 * Validates the configuration (no connection) and points DATABASE_URL at the
 * test database. Returns { url, database }.
 */
export function assertTestDatabaseConfig(env = process.env) {
  if (env.NODE_ENV === "production") throw new TestDatabaseGuardError("NODE_ENV is production");

  const raw = env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new TestDatabaseGuardError("TEST_DATABASE_URL is not set");
  const target = parseMysqlUrl(raw, "TEST_DATABASE_URL");

  if (!TEST_NAME.test(target.database)) {
    throw new TestDatabaseGuardError(`database "${target.database}" is not named <name>_test`);
  }
  if (env.CLEARCOLLECT_TEST_DATABASE !== target.database) {
    throw new TestDatabaseGuardError(`CLEARCOLLECT_TEST_DATABASE must be set to "${target.database}" to confirm it is a test database`);
  }
  if (!target.local && env.TEST_DATABASE_ALLOW_HOST?.toLowerCase() !== target.host) {
    throw new TestDatabaseGuardError(`host "${target.host}" is not local (set TEST_DATABASE_ALLOW_HOST=${target.host} only for a dedicated test server)`);
  }

  const devRaw = developmentDatabaseUrl();
  if (devRaw) {
    let dev = null;
    try {
      dev = parseMysqlUrl(devRaw, ".env DATABASE_URL");
    } catch {
      // An unparseable .env URL cannot equal a valid test URL.
    }
    if (dev && sameServer(dev, target) && dev.database === target.database) {
      throw new TestDatabaseGuardError(`TEST_DATABASE_URL points at the development database from .env ("${dev.database}")`);
    }
  }

  const current = env.DATABASE_URL?.trim();
  if (current && current !== raw) {
    throw new TestDatabaseGuardError("an unexpected DATABASE_URL is set in the environment (tests must not load .env; unset it)");
  }

  const paypal = env.PAYPAL_BASE_URL?.trim();
  if (paypal && !paypal.includes("sandbox")) throw new TestDatabaseGuardError("PAYPAL_BASE_URL is not a Sandbox URL");

  env.DATABASE_URL = raw;
  return { url: raw, database: target.database };
}

/** Connects and confirms the server's current database is the configured test database. */
export async function verifyConnectedDatabase({ url, database }) {
  const { PrismaClient } = await import("../src/generated/prisma/client.ts");
  const client = new PrismaClient({ datasourceUrl: url, log: [] });
  try {
    const [row] = await client.$queryRawUnsafe("SELECT DATABASE() AS db");
    if (row?.db !== database) {
      throw new TestDatabaseGuardError(`connected database is "${row?.db}", expected "${database}"`);
    }
  } catch (err) {
    if (err instanceof TestDatabaseGuardError) throw err;
    throw new TestDatabaseGuardError(`could not verify the test database "${database}" (${err?.message?.split("\n").find(Boolean) ?? err})`);
  } finally {
    await client.$disconnect();
  }
}

export async function enforceTestDatabase() {
  await verifyConnectedDatabase(assertTestDatabaseConfig());
}
