/**
 * Test database maintenance, guarded by tests/db-guard.mjs.
 *
 *   npm run test:db:setup   apply all migrations to the test database (creates it if missing)
 *   npm run test:db:reset   drop and re-create the test database's tables (removes leftovers)
 *
 * Both read TEST_DATABASE_URL from .env.test and pass it to the Prisma CLI as
 * DATABASE_URL, which takes precedence over .env, so the development database
 * is never touched.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertTestDatabaseConfig, verifyConnectedDatabase } from "../tests/db-guard.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const commands = {
  setup: ["migrate", "deploy"],
  reset: ["migrate", "reset", "--force", "--skip-seed", "--skip-generate"],
};

const action = process.argv[2];
if (!(action in commands)) {
  console.error(`usage: node scripts/test-db.mjs <${Object.keys(commands).join("|")}>`);
  process.exit(2);
}

try {
  const config = assertTestDatabaseConfig();
  // reset is destructive: also confirm, on the live connection, which database it would hit.
  if (action === "reset") await verifyConnectedDatabase(config);
  console.log(`[test-db] ${action}: ${config.database}`);
  const result = spawnSync(process.execPath, [path.join(root, "node_modules/prisma/build/index.js"), ...commands[action]], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: config.url },
  });
  process.exit(result.status ?? 1);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
