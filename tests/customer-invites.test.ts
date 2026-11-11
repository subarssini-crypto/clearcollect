/**
 * Customer onboarding / invitation workflow tests.
 *
 * Real route handlers and MySQL, test-owned rows only (clients "Invite Test …",
 * invoices INV-TEST-CI-<stamp>-…, customers ci-…-<stamp>@example.invalid),
 * removed afterwards. Zapier is never contacted: route tests run with
 * ZAPIER_INVITE_WEBHOOK_URL unset (or deliberately invalid), and delivery
 * outcomes are tested through sendInviteEmail with a fake fetch.
 */

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { customerThrottles } from "@/lib/customer-auth";
import { INVITE_TTL_MS, createInvite, hashInviteToken, inviteUrl } from "@/lib/customer-invites";
import { INVITE_WEBHOOK_URL_VAR, composeInviteEmail, sendInviteEmail } from "@/lib/customer-invite-email";
import { GET as listRoute, POST as createRoute } from "@/app/api/clients/[id]/invites/route";
import { DELETE as revokeRoute } from "@/app/api/clients/[id]/invites/[inviteId]/route";
import { GET as clientsRoute } from "@/app/api/clients/route";
import { POST as signupRoute } from "@/app/api/customer/auth/signup/route";
import { POST as loginRoute } from "@/app/api/customer/auth/login/route";
import { GET as previewRoute } from "@/app/api/customer/auth/invite/route";
import { POST as acceptRoute } from "@/app/api/customer/invite/route";
import { GET as invoicesRoute } from "@/app/api/customer/invoices/route";
import { GET as paymentsRoute } from "@/app/api/customer/payments/route";
import { proxy } from "@/proxy";
import { ownerCookie } from "./auth-helpers";
import { cleanupTestRecords } from "./cleanup";

const BASE = "http://localhost:3000";
const STAMP = `${Date.now()}`;
const PASSWORD = "invite-test-password-1";
const SECRET = "test-zapier-secret-0123456789";
const ZAP_URL = "https://hooks.zapier.com/hooks/catch/000/invite-test/";
const created = { clientIds: [] as number[], invoiceIds: [] as number[] };
let owner = "";

// ── Helpers ───────────────────────────────────────────────────────────────────

const emailFor = (label: string) => `ci-${label}-${STAMP}@example.invalid`;
const idCtx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) }) as never;
const inviteCtx = (id: number | string, inviteId: number | string) => ({ params: Promise.resolve({ id: String(id), inviteId: String(inviteId) }) }) as never;

function json(path: string, method: string, body: unknown, cookie?: string): Request {
  return new Request(`${BASE}${path}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
}
const get = (path: string, cookie?: string) => new NextRequest(`${BASE}${path}`, { headers: cookie ? { cookie } : {} });
const cookieFrom = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

type CreateBody = { invite: { id: number; status: string; email: string }; url: string; email: { result: string; detail: string } };
const create = (clientId: number, body: unknown, cookie = owner) => createRoute(json(`/api/clients/${clientId}/invites`, "POST", body, cookie), idCtx(clientId));
const list = (clientId: number, cookie = owner) => listRoute(get(`/api/clients/${clientId}/invites`, cookie), idCtx(clientId));
const revoke = (clientId: number, inviteId: number, cookie = owner) =>
  revokeRoute(new Request(`${BASE}/api/clients/${clientId}/invites/${inviteId}`, { method: "DELETE", headers: { cookie } }), inviteCtx(clientId, inviteId));
const tokenOf = (url: string) => new URL(url).searchParams.get("token")!;

async function customer(label: string): Promise<string> {
  const signup = await signupRoute(json("/api/customer/auth/signup", "POST", { name: `Invitee ${label}`, email: emailFor(label), password: PASSWORD }));
  assert.equal(signup.status, 200);
  const login = await loginRoute(json("/api/customer/auth/login", "POST", { email: emailFor(label), password: PASSWORD }));
  assert.equal(login.status, 200);
  return cookieFrom(login);
}
const accept = (token: string, cookie: string) => acceptRoute(json("/api/customer/invite", "POST", { token }, cookie));

async function testClient(label: string, data: Record<string, unknown> = {}) {
  const client = await prisma.client.create({ data: { name: `Invite Test ${label} ${STAMP}`, email: emailFor(`client-${label}`), company: null, ...data } });
  created.clientIds.push(client.id);
  return client;
}

async function testInvoice(clientId: number, suffix: string, data: Record<string, unknown> = {}) {
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: `INV-TEST-CI-${STAMP}-${suffix}`,
      clientId,
      description: "TEST ONLY - invite workflow test",
      amount: "40.00",
      currency: "USD",
      issueDate: new Date("2026-10-01T00:00:00Z"),
      dueDate: new Date("2099-01-01T00:00:00Z"),
      status: "SENT",
      ...data,
    },
  });
  created.invoiceIds.push(invoice.id);
  return invoice;
}

/** Runs `fn` with env overrides, restoring the previous values afterwards. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
/** Route tests never reach Zapier: the invite hook is unset. */
const noZapier = <T>(fn: () => Promise<T>) => withEnv({ [INVITE_WEBHOOK_URL_VAR]: undefined }, fn);

function fakeFetch(respond: () => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond();
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const ZAP_ENV = { [INVITE_WEBHOOK_URL_VAR]: ZAP_URL, ZAPIER_WEBHOOK_SECRET: SECRET };

// ── Fixtures ──────────────────────────────────────────────────────────────────

before(async () => {
  owner = await ownerCookie();
});
beforeEach(() => customerThrottles.reset());

after(async () => {
  let ids: number[] = [];
  await cleanupTestRecords(
    async () => {
      const customers = await prisma.customer.findMany({ where: { email: { startsWith: "ci-", endsWith: `-${STAMP}@example.invalid` } }, select: { id: true } });
      ids = customers.map((c) => c.id);
    },
    () => prisma.customerInvite.deleteMany({ where: { OR: [{ clientId: { in: created.clientIds } }, { usedByCustomerId: { in: ids } }] } }),
    () => prisma.customer.deleteMany({ where: { id: { in: ids } } }),
    () => prisma.invoice.deleteMany({ where: { id: { in: created.invoiceIds }, invoiceNumber: { startsWith: `INV-TEST-CI-${STAMP}-` } } }),
    () => prisma.client.deleteMany({ where: { id: { in: created.clientIds }, name: { startsWith: "Invite Test" } } }),
    () => customerThrottles.reset(),
  );
});

// ── Creation and authorization ────────────────────────────────────────────────

describe("creating invitations (owner)", () => {
  test("creates a 7-day, hashed, single pending invite and returns the link once", () =>
    noZapier(async () => {
      const client = await testClient("create");
      const res = await create(client.id, { send: false });
      assert.equal(res.status, 201);
      const body = ((await res.json()) as { data: CreateBody }).data;
      assert.equal(body.invite.status, "pending");
      assert.equal(body.invite.email, "not_sent");
      assert.equal(body.email.result, "not_requested");
      assert.equal(new URL(body.url).pathname, "/portal/invite");

      const token = tokenOf(body.url);
      const row = await prisma.customerInvite.findUniqueOrThrow({ where: { tokenHash: hashInviteToken(token) } });
      assert.equal(row.clientId, client.id);
      assert.equal(row.activeForClientId, client.id);
      assert.ok(Math.abs(row.expiresAt.getTime() - row.createdAt.getTime() - INVITE_TTL_MS) < 5_000);
      assert.equal(await prisma.customerInvite.count({ where: { tokenHash: token } }), 0, "raw token never stored");

      // The list never contains the token or URL again.
      const listed = await (await list(client.id)).text();
      assert.ok(!listed.includes(token) && !listed.includes("tokenHash"));
      assert.match(listed, /"status":"pending"/);
    }));

  test("only the owner can list, create, or revoke invitations", () =>
    noZapier(async () => {
      const client = await testClient("authz");
      const cust = await customer("authz");
      assert.equal((await create(client.id, { send: false }, "")).status, 401);
      assert.equal((await create(client.id, { send: false }, cust)).status, 401, "customer session is not an owner session");
      assert.equal((await list(client.id, "")).status, 401);
      assert.equal((await list(client.id, cust)).status, 401);
      assert.equal((await proxy(get(`/api/clients/${client.id}/invites`))).status, 401);
      assert.equal(await prisma.customerInvite.count({ where: { clientId: client.id } }), 0);

      const res = await create(client.id, { send: false });
      const { invite } = ((await res.json()) as { data: CreateBody }).data;
      assert.equal((await revoke(client.id, invite.id, cust)).status, 401);
      assert.equal((await revoke(client.id, invite.id, "")).status, 401);

      const crossSite = await createRoute(
        new Request(`${BASE}/api/clients/${client.id}/invites`, { method: "POST", headers: { "content-type": "application/json", cookie: owner, "sec-fetch-site": "cross-site" }, body: "{\"send\":false}" }),
        idCtx(client.id)
      );
      assert.equal(crossSite.status, 403);
    }));

  test("validates input; unknown and archived clients are refused", () =>
    noZapier(async () => {
      const client = await testClient("validate");
      assert.equal((await create(client.id, {})).status, 422);
      assert.equal((await create(client.id, { send: "yes" })).status, 422);
      assert.equal((await create(99999999, { send: false })).status, 404);
      const archived = await testClient("archived", { archivedAt: new Date() });
      assert.equal((await create(archived.id, { send: false })).status, 409);
      assert.equal(await prisma.customerInvite.count({ where: { clientId: { in: [client.id, archived.id] } } }), 0);
    }));

  test("repeated and concurrent clicks create exactly one pending invite", () =>
    noZapier(async () => {
      const client = await testClient("double");
      const results = await Promise.all(Array.from({ length: 5 }, () => create(client.id, { send: false })));
      const statuses = results.map((r) => r.status).sort();
      assert.deepEqual(statuses, [201, 409, 409, 409, 409]);
      const again = await create(client.id, { send: false });
      assert.equal(again.status, 409);
      assert.equal(((await again.json()) as { code: string }).code, "pending_exists");
      assert.equal(await prisma.customerInvite.count({ where: { clientId: client.id } }), 1);
    }));

  test("regenerate revokes the old link and issues a new one", () =>
    noZapier(async () => {
      const client = await testClient("regen");
      const first = ((await (await create(client.id, { send: false })).json()) as { data: CreateBody }).data;
      const second = ((await (await create(client.id, { send: false, regenerate: true })).json()) as { data: CreateBody }).data;
      assert.notEqual(tokenOf(first.url), tokenOf(second.url));
      assert.equal((await previewRoute(get(`/api/customer/auth/invite?token=${tokenOf(first.url)}`))).status, 404, "old link is dead");
      assert.equal((await previewRoute(get(`/api/customer/auth/invite?token=${tokenOf(second.url)}`))).status, 200);
      const cust = await customer("regen");
      assert.equal((await accept(tokenOf(first.url), cust)).status, 400);
      const statuses = ((await (await list(client.id)).json()) as { data: { invites: { status: string }[] } }).data.invites.map((i) => i.status);
      assert.deepEqual(statuses, ["pending", "revoked"]);
    }));

  test("expired invites free the slot and show as Expired", () =>
    noZapier(async () => {
      const client = await testClient("expire");
      await createInvite(client.id, { now: new Date(Date.now() - INVITE_TTL_MS - 60_000) });
      assert.equal((await create(client.id, { send: false })).status, 201, "an expired invite does not block a new one");
      const statuses = ((await (await list(client.id)).json()) as { data: { invites: { status: string }[] } }).data.invites.map((i) => i.status);
      assert.deepEqual(statuses, ["pending", "expired"]);
    }));

  test("revoke: kills the link, is idempotent-safe, and is scoped to the client in the path (no IDOR)", () =>
    noZapier(async () => {
      const a = await testClient("revoke-a");
      const b = await testClient("revoke-b");
      const invA = ((await (await create(a.id, { send: false })).json()) as { data: CreateBody }).data;
      assert.equal((await revoke(b.id, invA.invite.id)).status, 404, "client B's path cannot revoke client A's invite");
      assert.equal((await revoke(a.id, invA.invite.id)).status, 200);
      assert.equal((await revoke(a.id, invA.invite.id)).status, 409, "already revoked");
      assert.equal((await previewRoute(get(`/api/customer/auth/invite?token=${tokenOf(invA.url)}`))).status, 404);
      assert.equal((await create(a.id, { send: false })).status, 201, "a revoked invite frees the slot");
    }));

  test("an accepted invite cannot be revoked", () =>
    noZapier(async () => {
      const client = await testClient("accepted-revoke");
      const inv = ((await (await create(client.id, { send: false })).json()) as { data: CreateBody }).data;
      assert.equal((await accept(tokenOf(inv.url), await customer("accepted-revoke"))).status, 200);
      assert.equal((await revoke(client.id, inv.invite.id)).status, 409);
    }));
});

// ── Email delivery ────────────────────────────────────────────────────────────

describe("invitation email via Zapier", () => {
  test("without ZAPIER_INVITE_WEBHOOK_URL: no request, honest explanation, link still returned", () =>
    noZapier(async () => {
      const client = await testClient("demo");
      const res = await create(client.id, { send: true });
      assert.equal(res.status, 201);
      const body = ((await res.json()) as { data: CreateBody }).data;
      assert.equal(body.email.result, "demo");
      assert.match(body.email.detail, /ZAPIER_INVITE_WEBHOOK_URL is not configured/);
      assert.match(body.email.detail, /Copy the link/);
      assert.equal(body.invite.email, "not_sent");
      assert.ok(body.url);
      const delivery = ((await (await list(client.id)).json()) as { data: { delivery: { mode: string } } }).data.delivery;
      assert.equal(delivery.mode, "demo");
    }));

  test("a misconfigured hook (not https) sends nothing and says so", () =>
    withEnv({ [INVITE_WEBHOOK_URL_VAR]: "http://hooks.zapier.com/insecure", ZAPIER_WEBHOOK_SECRET: SECRET }, async () => {
      const client = await testClient("misconfig");
      const body = ((await (await create(client.id, { send: true })).json()) as { data: CreateBody }).data;
      assert.equal(body.email.result, "misconfigured");
      assert.equal(body.invite.email, "not_sent");
    }));

  test("accepted by Zapier: one request to the stored client email, recorded as ACCEPTED, never 'delivered'", async () => {
    const client = await testClient("zap-ok");
    const { invite, token } = await createInvite(client.id);
    const url = inviteUrl(BASE, token);
    const f = fakeFetch(async () => new Response("{}"));
    const outcome = await sendInviteEmail(invite, { name: client.name, email: client.email }, url, { env: ZAP_ENV, fetchImpl: f.impl });

    assert.equal(outcome.result, "accepted");
    assert.match(outcome.detail, /Accepted by Zapier/);
    assert.match(outcome.detail, /check its history to confirm delivery/);
    assert.doesNotMatch(outcome.detail, /\bdelivered\b|email (was )?sent/i);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, ZAP_URL);
    const payload = JSON.parse(String(f.calls[0].init.body));
    assert.equal(payload.recipient_email, client.email);
    assert.equal(payload.auth_token, SECRET);
    assert.equal(payload.invite_url, url);
    assert.ok(payload.message.includes(url));
    assert.match(payload.message, /Accept invitation/);
    const row = await prisma.customerInvite.findUniqueOrThrow({ where: { id: invite.id } });
    assert.equal(row.emailState, "ACCEPTED");
    assert.equal(row.emailRecipient, client.email);

    // The same invite is never emailed twice.
    const again = await sendInviteEmail(invite, { name: client.name, email: client.email }, url, { env: ZAP_ENV, fetchImpl: f.impl });
    assert.equal(again.result, "failed");
    assert.equal(f.calls.length, 1);
  });

  test("rejected / unreachable → FAILED; timeout → UNKNOWN; no client email → nothing sent", async () => {
    const cases: [string, () => Promise<Response>, string, string][] = [
      ["rejected", async () => new Response("no", { status: 500 }), "failed", "FAILED"],
      ["unreachable", async () => { throw new TypeError("fetch failed"); }, "failed", "FAILED"],
      ["timeout", async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }, "unknown", "UNKNOWN"],
    ];
    for (const [label, respond, result, state] of cases) {
      const client = await testClient(`zap-${label}`);
      const { invite, token } = await createInvite(client.id);
      const outcome = await sendInviteEmail(invite, client, inviteUrl(BASE, token), { env: ZAP_ENV, fetchImpl: fakeFetch(respond).impl });
      assert.equal(outcome.result, result, label);
      assert.equal((await prisma.customerInvite.findUniqueOrThrow({ where: { id: invite.id } })).emailState, state, label);
    }

    const noEmail = await testClient("zap-noemail", { email: null });
    const { invite, token } = await createInvite(noEmail.id);
    const f = fakeFetch(async () => new Response("{}"));
    const outcome = await sendInviteEmail(invite, noEmail, inviteUrl(BASE, token), { env: ZAP_ENV, fetchImpl: f.impl });
    assert.equal(outcome.result, "no_recipient");
    assert.equal(f.calls.length, 0);
  });

  test("the email text explains acceptance and expiry without promising anything else", () => {
    const { subject, message } = composeInviteEmail({ clientName: "Acme", url: "https://app.example/portal/invite?token=x", expiresAt: new Date("2026-11-01T00:00:00Z") });
    assert.match(subject, /invited/i);
    assert.match(message, /Hi Acme,/);
    assert.match(message, /works once and expires on November 1, 2026/);
    assert.doesNotMatch(message, /attach|pdf|password/i);
  });

  test("the Clients list shows each client's portal state", () =>
    noZapier(async () => {
      const client = await testClient("summary");
      await create(client.id, { send: false });
      const { data } = (await (await clientsRoute(get("/api/clients", owner))).json()) as { data: { id: number; portal: unknown }[] };
      assert.deepEqual(data.find((c) => c.id === client.id)?.portal, { linkedAccounts: 0, latestInvite: { status: "pending", email: "not_sent" } });
    }));
});

// ── Customer acceptance ───────────────────────────────────────────────────────

describe("customer acceptance", () => {
  test("full journey: owner invites → customer signs up, signs in, accepts → sees exactly that client's invoices", () =>
    noZapier(async () => {
      const client = await testClient("journey");
      const other = await testClient("journey-other");
      const sent = await testInvoice(client.id, "j-sent");
      const paid = await testInvoice(client.id, "j-paid", {
        status: "PAID",
        paypalOrderId: `CITESTORDER${STAMP}`,
        paypalCaptureId: `CITESTCAPTURE${STAMP}`,
        paidAt: new Date("2026-10-05T00:00:00Z"),
      });
      await testInvoice(client.id, "j-draft", { status: "DRAFT" });
      await testInvoice(other.id, "j-other");

      const { url } = ((await (await create(client.id, { send: true })).json()) as { data: CreateBody }).data;
      const token = tokenOf(url);

      // Signed out: the invite page is public; the portal is not.
      assert.equal((await proxy(get(`/portal/invite?token=${token}`))).headers.get("x-middleware-next"), "1");
      assert.equal(((await (await previewRoute(get(`/api/customer/auth/invite?token=${token}`))).json()) as { data: { clientName: string } }).data.clientName, client.name);

      const cust = await customer("journey");
      // Before accepting: nothing is visible.
      assert.deepEqual(((await (await invoicesRoute(get("/api/customer/invoices", cust))).json()) as { data: unknown[] }).data, []);
      // A signed-in customer following a login link with the invite goes to the acceptance step.
      const redirect = new URL((await proxy(get(`/portal/login?invite=${token}`, cust))).headers.get("location")!);
      assert.equal(`${redirect.pathname}?token=${redirect.searchParams.get("token")}`, `/portal/invite?token=${token}`);

      const res = await accept(token, cust);
      assert.equal(res.status, 200);
      const row = await prisma.customer.findUniqueOrThrow({ where: { email: emailFor("journey") } });
      assert.equal(row.clientId, client.id);

      const visible = ((await (await invoicesRoute(get("/api/customer/invoices", cust))).json()) as { data: { invoiceNumber: string }[] }).data
        .map((i) => i.invoiceNumber)
        .sort();
      assert.deepEqual(visible, [paid.invoiceNumber, sent.invoiceNumber].sort());
      const history = ((await (await paymentsRoute(get("/api/customer/payments", cust))).json()) as { data: { invoiceNumber: string }[] }).data;
      assert.deepEqual(history.map((p) => p.invoiceNumber), [paid.invoiceNumber]);

      // Owner view reflects it.
      const overview = ((await (await list(client.id)).json()) as { data: { invites: { status: string; acceptedBy: { email: string } }[]; linkedAccounts: { email: string }[] } }).data;
      assert.equal(overview.invites[0].status, "accepted");
      assert.equal(overview.invites[0].acceptedBy.email, emailFor("journey"));
      assert.deepEqual(overview.linkedAccounts.map((a) => a.email), [emailFor("journey")]);

      // Reuse is refused, for this account and any other.
      assert.equal((await accept(token, cust)).status, 400);
      assert.equal((await accept(token, await customer("journey-2"))).status, 400);
    }));

  test("an account linked to another client is never reassigned; the invite stays usable", () =>
    noZapier(async () => {
      const first = await testClient("reassign-1");
      const second = await testClient("reassign-2");
      const cust = await customer("reassign");
      assert.equal((await accept(tokenOf(((await (await create(first.id, { send: false })).json()) as { data: CreateBody }).data.url), cust)).status, 200);

      const inv2 = ((await (await create(second.id, { send: false })).json()) as { data: CreateBody }).data;
      const res = await accept(tokenOf(inv2.url), cust);
      assert.equal(res.status, 409);
      assert.match(((await res.json()) as { error: string }).error, /already linked to a different client/);
      assert.equal((await prisma.customer.findUniqueOrThrow({ where: { email: emailFor("reassign") } })).clientId, first.id);
      assert.equal((await previewRoute(get(`/api/customer/auth/invite?token=${tokenOf(inv2.url)}`))).status, 200, "invite not consumed");
    }));

  test("expired, revoked, malformed, and signed-out acceptance attempts are refused", () =>
    noZapier(async () => {
      const client = await testClient("refuse");
      const cust = await customer("refuse");
      const expired = await createInvite(client.id, { now: new Date(Date.now() - INVITE_TTL_MS - 60_000) });
      assert.equal((await accept(expired.token, cust)).status, 400);

      const live = ((await (await create(client.id, { send: false })).json()) as { data: CreateBody }).data;
      assert.equal((await acceptRoute(json("/api/customer/invite", "POST", { token: tokenOf(live.url) }))).status, 401, "needs a customer session");
      assert.equal((await acceptRoute(json("/api/customer/invite", "POST", { token: tokenOf(live.url) }, owner))).status, 401, "owner session is not a customer");
      assert.equal((await revoke(client.id, live.invite.id)).status, 200);
      assert.equal((await accept(tokenOf(live.url), cust)).status, 400, "revoked");
      for (const bad of ["", "x", "a".repeat(43), null]) assert.equal((await accept(bad as string, cust)).status, 400);
      assert.equal((await prisma.customer.findUniqueOrThrow({ where: { email: emailFor("refuse") } })).clientId, null);
    }));
});
