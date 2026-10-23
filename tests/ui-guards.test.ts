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

  test("says clearly that the reminder preview sends nothing and links to Follow-ups", () => {
    const text = visibleText(createInvoicePage);
    assert.match(text, /Preview only/);
    assert.match(text, /This reminder preview never sends anything/);
    assert.match(createInvoicePage, /href="\/follow-ups"/);
  });

  test("Send Invoice emails only a saved draft, never unsaved form values or a browser-chosen recipient", () => {
    assert.doesNotMatch(createInvoicePage, /Send Invoice \(Demo\)|alert\(/);
    assert.match(createInvoicePage, /<SendInvoiceButton[\s\S]*?invoiceId=\{savedDraft\.id\}/);
    assert.match(createInvoicePage, /title="Save the draft first"/);
    const sendComponent = readFileSync(new URL("../src/components/SendInvoice.tsx", import.meta.url), "utf8");
    // The send request carries only the resend confirmation.
    assert.match(sendComponent, /body: JSON\.stringify\(\{ confirmResend \}\)/);
    assert.doesNotMatch(sendComponent, /JSON\.stringify\(\{[^}]*(recipient|email)/i);
    assert.doesNotMatch(sendComponent, /hooks\.zapier\.com/);
  });

  test("saving stores line items and stays separate from sending", () => {
    assert.match(createInvoicePage, /lineItems: lineItems\.map\(/);
    assert.match(createInvoicePage, /status: "DRAFT"/);
    assert.doesNotMatch(createInvoicePage, /\/api\/invoices\/\$\{[^}]+\}\/send/);
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

describe("Follow-ups page reports delivery honestly and blocks duplicate sends", () => {
  const page = readFileSync(new URL("../src/app/follow-ups/page.tsx", import.meta.url), "utf8");

  test("never assumes demo mode when the delivery status cannot be loaded", () => {
    assert.doesNotMatch(page, /setDelivery\("demo"\)/);
    assert.match(page, /setDelivery\("unknown"\)/);
    assert.match(page, /delivery === "demo" \? "Approve & Send \(Demo\)" : "Approve & Send"/);
  });

  test("a sent reminder cannot be sent again, and double clicks are guarded synchronously", () => {
    assert.match(page, /disabled=\{isBusy \|\| sent \|\| delivery === "misconfigured"\}/);
    assert.match(page, /if \(sendingRef\.current\.has\(id\) \|\| sentIds\.has\(id\)\) return;/);
  });

  test("non-JSON error responses become readable errors", () => {
    // The only direct res.json() call is inside the readJson helper.
    assert.equal(page.match(/res\.json\(\)/g)?.length, 1);
    assert.match(page, /return await res\.json\(\);\s*\} catch \{/);
    assert.match(page, /unexpected response \(HTTP \$\{res\.status\}\)/);
  });

  test("the default reminder states the amount with its currency code", () => {
    assert.match(page, /currencyDisplay: "code"/);
    assert.match(page, /const amount = reminderAmount\(invoice\.amount, invoice\.currency\)/);
  });
});

describe("light/dark theme", () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const layout = read("src/app/layout.tsx");
  const toggle = read("src/components/ThemeToggle.tsx");
  const shell = read("src/components/AppShell.tsx");
  const css = read("src/app/globals.css");

  test("the saved theme is applied by an inline <head> script before first paint", async () => {
    assert.match(layout, /<head>\s*<script dangerouslySetInnerHTML=\{\{ __html: THEME_INIT_SCRIPT \}\} \/>/);
    assert.match(layout, /suppressHydrationWarning/);
    const { THEME_INIT_SCRIPT, THEME_STORAGE_KEY } = await import("@/lib/theme");
    // Runs the script against a fake document: saved choice wins, else the OS preference.
    for (const [saved, prefersDark, expected] of [["dark", false, "dark"], ["light", true, "light"], [null, true, "dark"], ["bogus", false, "light"]] as const) {
      const attrs: Record<string, string> = {};
      const env = {
        localStorage: { getItem: (k: string) => (k === THEME_STORAGE_KEY ? saved : null) },
        window: { matchMedia: () => ({ matches: prefersDark }) },
        document: { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) } },
      };
      new Function("localStorage", "window", "document", THEME_INIT_SCRIPT)(env.localStorage, env.window, env.document);
      assert.equal(attrs["data-theme"], expected, `saved=${saved} prefersDark=${prefersDark}`);
    }
  });

  test("the toggle shows a moon in light mode and a sun in dark mode, with matching accessible labels", () => {
    assert.match(toggle, /Light mode: moon — offers dark \*\/\}\s*<svg className="h-\[18px\] w-\[18px\] dark:hidden"/);
    assert.match(toggle, /Dark mode: sun — offers light \*\/\}\s*<svg className="hidden h-\[18px\] w-\[18px\] dark:block"/);
    assert.match(toggle, /<span className="sr-only dark:hidden">Switch to dark theme<\/span>/);
    assert.match(toggle, /<span className="sr-only hidden dark:inline">Switch to light theme<\/span>/);
    // Re-applied after React's dev remount, and persisted on click.
    assert.match(toggle, /useLayoutEffect/);
    assert.match(toggle, /saveTheme\(currentTheme\(\) === "dark" \? "light" : "dark"\)/);
  });

  test("the toggle is in the top navigation and on the login page", () => {
    assert.equal(shell.match(/<ThemeToggle/g)?.length, 2);
  });

  test("dark mode is driven by data-theme, and the dark theme redefines the design tokens", () => {
    assert.match(css, /@custom-variant dark \(&:where\(\[data-theme="dark"\], \[data-theme="dark"\] \*\)\);/);
    const dark = css.slice(css.indexOf('[data-theme="dark"] {'));
    for (const token of ["--color-surface", "--color-canvas", "--color-navy", "--color-line", "--color-muted", "--color-brand", "color-scheme: dark"]) {
      assert.ok(dark.includes(token), `dark theme should set ${token}`);
    }
  });

  test("native selects and their options get theme colors (readable dropdowns in dark mode)", () => {
    const base = css.slice(css.indexOf("@layer base {"));
    assert.match(base, /select \{\s*background-color: var\(--color-surface\);\s*color: var\(--color-navy\);/);
    assert.match(base, /select option,\s*select optgroup \{\s*background-color: var\(--color-surface\);\s*color: var\(--color-navy\);/);
    // Dark values for both tokens exist, so options are light text on a dark surface.
    const dark = css.slice(css.indexOf('[data-theme="dark"] {'));
    assert.match(dark, /--color-surface: #111a2e;/);
    assert.match(dark, /--color-navy: #e6ebf5;/);
  });

  test("the send-invoice dialog is portaled and left-aligned regardless of where the button sits", () => {
    const send = read("src/components/SendInvoice.tsx");
    const invoices = read("src/app/invoices/page.tsx");
    // The Invoices page renders the button inside a right-aligned, nowrap cell…
    assert.match(invoices, /<td className="[^"]*text-right whitespace-nowrap[^"]*">\s*\{renderPayment\(invoice\)\}/);
    // …so the dialog must not live under it, and resets alignment and wrapping itself.
    assert.match(send, /\{open && createPortal\(/);
    assert.match(send, /document\.body\s*\)\}/);
    assert.match(send, /className="fixed inset-0 z-50 flex items-center justify-center [^"]*text-left whitespace-normal"/);
    assert.match(send, /<pre className="[^"]*whitespace-pre-wrap/);
  });

  test("no page or component hard-codes white surfaces or hex colors", () => {
    const files = [
      ...readdirSync(new URL("../src/app", import.meta.url), { recursive: true, encoding: "utf8" })
        .filter((f) => f.endsWith(".tsx"))
        .map((f) => `src/app/${f.replace(/\\/g, "/")}`),
      ...readdirSync(new URL("../src/components", import.meta.url)).map((f) => `src/components/${f}`),
    ];
    assert.ok(files.length >= 10);
    for (const file of files) {
      const source = read(file)
        // Switch knobs stay white on both the brand and the dark track.
        .replace(/rounded-full bg-white shadow transition-transform/g, "");
      assert.doesNotMatch(source, /\bbg-white\b/, `${file} uses bg-white; use bg-surface`);
      assert.doesNotMatch(source, /(fill|stroke|color|background)=["'{]+#[0-9a-f]{3,8}/i, `${file} hard-codes a hex color`);
      assert.doesNotMatch(source, /text-brand-dark/, `${file} uses text-brand-dark; use text-brand-ink`);
    }
  });
});

describe("expandable sidebar rail", () => {
  const shell = readFileSync(new URL("../src/components/AppShell.tsx", import.meta.url), "utf8");

  test("is collapsed (icon-only) by default", () => {
    assert.match(shell, /const \[railExpanded, setRailExpanded\] = useState\(false\);/);
    assert.match(shell, /railExpanded \? "w-52 items-stretch overflow-hidden px-2\.5" : "w-14 items-center"/);
  });

  test("has an accessible toggle at the top of the rail that flips the state", () => {
    // A native <button>: focusable and operable with Enter/Space.
    assert.match(shell, /<button\s+type="button"\s+id="sidebar-toggle"/);
    assert.match(shell, /const label = expanded \? "Collapse sidebar" : "Expand sidebar";/);
    assert.match(shell, /aria-label=\{label\}\s+aria-expanded=\{expanded\}\s+aria-controls="quick-navigation"/);
    assert.match(shell, /<aside\s+id="quick-navigation"/);
    // First child of the rail, before the links.
    assert.match(shell, /aria-label="Quick navigation"\s*>\s*<RailToggle expanded=\{railExpanded\} onToggle=\{\(\) => setRailExpanded\(\(open\) => !open\)\} \/>/);
    assert.match(shell, /focus-visible:ring-2/);
  });

  test("expanded shows labels next to icons; collapsed keeps tooltips and accessible names", () => {
    assert.match(shell, /\{expanded \? \(\s*<span className="truncate whitespace-nowrap text-\[13px\] font-semibold">\{item\.label\}<\/span>\s*\) : \(\s*<span className=\{railTooltip\}>\{item\.label\}<\/span>/);
    assert.match(shell, /title=\{expanded \? undefined : item\.label\}/);
    assert.match(shell, /aria-label=\{expanded \? undefined : item\.label\}/);
  });

  test("animates width without overlapping content, and respects reduced motion", () => {
    assert.match(shell, /transition-\[width\] duration-200 ease-out motion-reduce:transition-none/);
    // The rail is a flex sibling of main, which can shrink (no overlay, no overflow).
    assert.match(shell, /<main id="main-content" className="min-w-0 flex-1 overflow-y-auto">/);
    assert.doesNotMatch(shell, /<aside[^>]*\b(fixed|absolute)\b/);
  });

  test("navigation is preserved: every item, active highlighting, Settings at the bottom", () => {
    assert.match(shell, /\{NAV\.slice\(0, -1\)\.map\(\(item\) => \(\s*<RailLink key=\{item\.href\} item=\{item\} pathname=\{pathname\} expanded=\{railExpanded\} \/>/);
    assert.match(shell, /<RailLink item=\{NAV\[NAV\.length - 1\]\} pathname=\{pathname\} expanded=\{railExpanded\} \/>/);
    assert.match(shell, /aria-current=\{active \? "page" : undefined\}/);
    assert.match(shell, /active \? "bg-brand-50 text-brand" : "text-slate-400 hover:bg-canvas hover:text-navy"/);
    assert.match(shell, /return href === "\/" \? pathname === "\/" : pathname\.startsWith\(href\);/);
  });

  test("phones keep the header menu: the rail stays hidden below md", () => {
    assert.match(shell, /className=\{`hidden flex-shrink-0 flex-col[^`]*md:flex/);
    assert.match(shell, /id="mobile-menu-toggle"/);
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
