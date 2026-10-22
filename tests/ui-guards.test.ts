/**
 * Regression tests for user-facing honesty and first-time setup:
 * - the Create Invoice reminder card is a preview that cannot claim delivery
 *   and points to the real Follow-ups flow (which is tested in follow-up.test.ts);
 * - the login page explains single-owner setup and that there is no public
 *   registration; no registration or browser-based password endpoint exists;
 * - GET /api/auth/status reveals only booleans and fails closed.
 *
 * Client components cannot be rendered by Node's test runner (no JSX
 * transform), so page checks read the component source.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { GET as authStatus } from "@/app/api/auth/status/route";
import { proxy } from "@/proxy";
import { ownerCookie } from "./auth-helpers";

const createInvoicePage = readFileSync(new URL("../src/app/create-invoice/page.tsx", import.meta.url), "utf8");
const loginPage = readFileSync(new URL("../src/app/login/page.tsx", import.meta.url), "utf8");
const cookie = await ownerCookie();

/** Text of every string literal and JSX text node, whitespace-collapsed. */
function visibleText(source: string): string {
  return source.replace(/\s+/g, " ");
}

describe("Create Invoice reminder card is a preview only", () => {
  test("no send action and no delivery claim", () => {
    for (const forbidden of [/Reminder Sent/i, /Send Reminder/i, /send-reminder-btn/, /handleSendReminder/, /Email sending is not connected yet/i]) {
      assert.doesNotMatch(createInvoicePage, forbidden);
    }
  });

  test("says clearly that no email is sent and links to Follow-ups", () => {
    const text = visibleText(createInvoicePage);
    assert.match(text, /Preview only/);
    assert.match(text, /No email is sent from this page/);
    assert.match(createInvoicePage, /href="\/follow-ups"/);
  });

  test("never calls the reminder delivery endpoint or Zapier itself", () => {
    assert.doesNotMatch(createInvoicePage, /\/api\/follow-ups\/send/);
    assert.doesNotMatch(createInvoicePage, /hooks\.zapier\.com/i);
  });

  test("sends the selected client and only user-typed dates as AI context", () => {
    assert.match(createInvoicePage, /selectedClientId: clientId \? Number\(clientId\) : null/);
    assert.match(createInvoicePage, /issueDate: issueSource === "user" \? issueDate : null/);
    assert.match(createInvoicePage, /dueDate: dueSource === "user" \? dueDate : null/);
  });

  test("answers clarification questions one box per question, sent by question id", () => {
    assert.match(visibleText(createInvoicePage), /Answers are matched to their question, never by order/);
    assert.match(createInvoicePage, /questions\.map\(\(q\) => \(\{ id: q\.id, answer:/);
    assert.doesNotMatch(createInvoicePage, /Additional details:/);
  });

  test("every AI draft shows quantities, rates, currency, and total and must be reviewed before saving", () => {
    const text = visibleText(createInvoicePage);
    assert.match(text, /Review before saving/);
    assert.match(text, /Currency \{currency\} · Total/);
    assert.match(text, /I have reviewed these quantities, rates, currency, and total/);
    assert.match(createInvoicePage, /if \(needsReview && !valuesConfirmed\) \{/);
    assert.match(createInvoicePage, /setNeedsReview\(true\);/);
  });

  test("labels the default due date as an app default", () => {
    assert.match(visibleText(createInvoicePage), /App default: \$\{DEFAULT_DUE_DAYS\} days after the issue date \(not from your request\)/);
  });
});

describe("login page explains first-time setup", () => {
  const text = visibleText(loginPage);

  test("states single-owner demo and no public registration", () => {
    assert.match(text, /single-owner demo/);
    assert.match(text, /no public registration/);
  });

  test("gives the setup command, password, restart, and sign-in steps", () => {
    assert.match(text, /npm run auth:setup/);
    assert.match(text, /strong owner password/);
    assert.match(text, /Restart the app/);
    assert.match(text, /sign in with that password/);
  });

  test("has a setup-required state for missing configuration", () => {
    assert.match(text, /Setup required/);
    assert.match(loginPage, /res\.status === 503/);
  });

  test("only talks to the login and status endpoints (no browser password creation)", () => {
    const endpoints = [...loginPage.matchAll(/fetch\("([^"]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(endpoints, ["/api/auth/login", "/api/auth/status"]);
  });

  test("no registration or setup endpoint exists", () => {
    const authRoutes = readdirSync(new URL("../src/app/api/auth", import.meta.url)).sort();
    assert.deepEqual(authRoutes, ["login", "logout", "status"]);
  });
});

describe("GET /api/auth/status", () => {
  function status(withCookie?: string) {
    return authStatus(new NextRequest("http://localhost:3000/api/auth/status", { headers: withCookie ? { cookie: withCookie } : {} }));
  }

  test("reports configuration and session as booleans only", async () => {
    const res = await status(cookie);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.deepEqual(JSON.parse(body), { ok: true, data: { configured: true, signedIn: true } });
    assert.ok(!body.includes(process.env.AUTH_SECRET!), "secret leaked");
    assert.ok(!body.includes(process.env.OWNER_PASSWORD_HASH!), "hash leaked");
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  test("signed out → signedIn false", async () => {
    assert.deepEqual(((await (await status()).json()) as { data: unknown }).data, { configured: true, signedIn: false });
  });

  test("missing configuration → configured false and nobody signed in (fails closed)", async () => {
    const saved = { secret: process.env.AUTH_SECRET, hash: process.env.OWNER_PASSWORD_HASH };
    delete process.env.AUTH_SECRET;
    delete process.env.OWNER_PASSWORD_HASH;
    try {
      assert.deepEqual(((await (await status(cookie)).json()) as { data: unknown }).data, { configured: false, signedIn: false });
    } finally {
      process.env.AUTH_SECRET = saved.secret;
      process.env.OWNER_PASSWORD_HASH = saved.hash;
    }
  });

  test("is reachable through the proxy without a session", async () => {
    const res = await proxy(new NextRequest("http://localhost:3000/api/auth/status"));
    assert.equal(res.headers.get("x-middleware-next"), "1");
  });
});
