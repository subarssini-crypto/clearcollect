/**
 * Test-only owner credentials. Importing this module replaces AUTH_SECRET and
 * OWNER_PASSWORD_HASH in this test process with throwaway values, so tests
 * never depend on (or reveal) the real ones in .env.
 */

import { hashPassword } from "@/lib/auth";
import { POST as login } from "@/app/api/auth/login/route";

export const TEST_OWNER_PASSWORD = "test-owner-password-not-real";
export const TEST_AUTH_SECRET = "test-auth-secret-0123456789-abcdefghijklmnop";

const configured = (async () => {
  process.env.AUTH_SECRET = TEST_AUTH_SECRET;
  process.env.OWNER_PASSWORD_HASH = await hashPassword(TEST_OWNER_PASSWORD);
})();

/** Signs in through the real login route and returns a `Cookie` header value. */
export async function ownerCookie(): Promise<string> {
  await configured;
  const res = await login(new Request("http://localhost:3000/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: TEST_OWNER_PASSWORD }),
  }));
  if (res.status !== 200) throw new Error(`test login failed with ${res.status}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
