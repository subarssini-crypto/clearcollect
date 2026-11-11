// Test-only module hooks: resolves the "@/..." tsconfig alias and the
// extensionless relative imports used by src/ and the generated Prisma client.
//
// Under the test runner (every test-file process `node --test` spawns), this
// also enforces the test database guard before the test file loads, so an
// unsafe configuration fails every file without running any test code; see
// tests/db-guard.mjs. Scripts that only need the alias hooks (auth:setup,
// test-data:reminder) are unaffected.
import { register } from "node:module";
import { enforceTestDatabase } from "./db-guard.mjs";

register("./alias-loader.mjs", import.meta.url);

if (process.env.NODE_TEST_CONTEXT || process.execArgv.includes("--test")) {
  await enforceTestDatabase();
}
