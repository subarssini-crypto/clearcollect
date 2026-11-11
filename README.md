# ClearCollect

**AI-assisted invoicing, verified PayPal payments, and payment follow-up for freelancers and small businesses.**

> Built for the [PayPal AI Hackathon](https://developer.paypal.com/). ClearCollect stores clients and invoices in **MySQL via Prisma**, accepts payments through **PayPal Sandbox Checkout** (Orders v2, server-side), and uses **Google Gemini** to draft invoices and payment reminders. The owner reviews every draft before anything is saved or sent. Payments that fail deterministic checks are **held for owner review** instead of being marked paid. The business side uses a **single-owner login** (not multi-tenant). Clients get a separate, invite-only **Customer Portal** and per-invoice **secure payment links**.

Repository: <https://github.com/subarssini-crypto/clearcollect>

---

## Table of Contents

- [Problem Statement](#problem-statement)
- [Key Features](#key-features)
- [Security Features at a Glance](#security-features-at-a-glance)
- [Technology Stack](#technology-stack)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Installation and Local Setup](#installation-and-local-setup)
- [Environment Variables](#environment-variables)
- [Database Setup (MySQL + Prisma)](#database-setup-mysql--prisma)
- [Running the Application](#running-the-application)
- [Running Tests](#running-tests)
- [Demo Guide for Judges](#demo-guide-for-judges)
- [Authentication and Authorization](#authentication-and-authorization)
- [AI Invoice Generator](#ai-invoice-generator)
- [Payment Reminders (Follow-ups)](#payment-reminders-follow-ups)
- [Zapier Email Automation](#zapier-email-automation)
- [Customer Portal and Payment Links](#customer-portal-and-payment-links)
- [PayPal Sandbox Checkout](#paypal-sandbox-checkout)
- [Payment Security, Reconciliation, and Risk Review](#payment-security-reconciliation-and-risk-review)
- [API Reference](#api-reference)
- [Light/Dark Theme](#lightdark-theme)
- [Current Limitations](#current-limitations)
- [Future Enhancements](#future-enhancements)
- [License](#license)

---

## Problem Statement

Freelancers and small business owners spend a lot of time creating invoices and chasing unpaid ones. Follow-up emails need to be polite but firm, and writing them is repetitive, awkward, and easy to forget. Late payments disrupt cash flow and strain client relationships. When a payment does arrive, the owner still needs to know that the right amount was paid for the right invoice, exactly once.

**ClearCollect** combines:

- AI-assisted drafting of invoices and reminders, always reviewed and approved by the owner;
- PayPal payment from the owner's app, a secure payment link, or a client portal;
- server-side payment verification that marks an invoice paid only after PayPal confirms a matching capture, and holds anything suspicious for the owner to review.

---

## Key Features

Everything in this table is implemented in the current codebase. Planned work is listed separately under [Future Enhancements](#future-enhancements).

| Feature | What it does |
|---|---|
| **AI-assisted invoice drafting** | Gemini turns a plain-language description into an editable draft (client, currency, dates, line items). Missing quantities or rates become questions instead of guesses. The server recomputes totals, and nothing is saved until the owner reviews the draft and clicks **Save Draft**. |
| **AI-assisted payment follow-ups** | Gemini drafts reminder wording for unpaid `SENT`/`OVERDUE` invoices. The server fills in the invoice number, amount, and due date from MySQL. The owner edits and approves each reminder before it is sent. |
| **Client management** | Add clients, view totals per client, and archive or restore clients. Archived clients keep their history but are hidden when creating new invoices. |
| **Invoice management** | Create, edit, filter (All / Paid / Pending / Overdue / Draft), and delete invoices. Invoice numbers are assigned automatically (`INV-YYYY-NNN`). Only drafts with no payment, email, or reminder history can be deleted. Paid invoices are read-only. |
| **Owner dashboard and transactions** | Summary metrics computed from invoice records, plus a **Transactions** page listing verified PayPal payments with capture ID, capture time, and environment. |
| **PayPal Sandbox payments** | Server-side order creation and capture via `@paypal/paypal-server-sdk`. The amount and currency always come from MySQL, never from the browser. |
| **PayPal webhook signature verification** | Every webhook delivery is checked with PayPal's `verify-webhook-signature` API before the app acts on it. The order is then re-fetched from PayPal and verified again. |
| **Duplicate transaction and event protection** | An invoice is marked `PAID` exactly once, by a conditional update tied to a unique capture ID. Webhook redeliveries, repeated return-page visits, and double clicks change nothing. Order creation and capture send idempotency keys to PayPal. |
| **Suspicious payment detection and manual review** | Deterministic rules compare PayPal-verified data with the invoice in MySQL. If any rule fails, the payment is **held**: the invoice stays unpaid and a review item appears on **Payment Reviews** for the owner. |
| **Customer Portal** | Clients get an account linked to their client record only by redeeming a single-use, expiring invite from the owner. They can view their own invoices, pay through PayPal, see their payment history, and reset a forgotten password. |
| **Secure invoice payment links** | Each payable invoice can have an unguessable `/pay/<token>` link. A client can view and pay that one invoice without an account. |
| **Zapier email automation** | Invoice emails, approved reminders, portal invitations, and password-reset emails go out through separate Zapier Catch Hook → Gmail Zaps. Each request carries a shared secret, and each Zap checks it. Without Zapier, the app runs in a clearly labelled demo mode. |
| **Payment-risk demo** | An owner-only demo runs the real risk rules against **mock invoices in memory**. It makes no database writes, PayPal calls, or emails. |
| **Single-owner authentication** | One owner password (scrypt hash) and an encrypted session cookie protect all business pages and APIs. |
| **Light/Dark theme** | The theme toggle is saved in the browser and applied before the first paint. |
| **Settings** | UI only. Preferences are **not** saved, and the page is labelled as demo mode. |

### What the AI does and does not do

- Gemini **drafts text only**: invoice line items and reminder wording. The owner reviews everything before it is saved or sent.
- Gemini **cannot** set invoice status, mark an invoice paid, call PayPal, choose an email recipient, or make payment decisions.
- **Payment-risk decisions are not made by AI.** They come from a fixed set of deterministic comparisons in `src/lib/payment-risk.ts`. The rules never approve or refund a payment on their own, and there is no autonomous or machine-learning fraud detection. A rule can only **hold** a payment and **flag** it. The owner decides what to do in PayPal.

---

## Security Features at a Glance

Each item links to the detailed section and is covered by the test suites listed under [Running Tests](#running-tests).

| Area | Implementation |
|---|---|
| **Webhook authenticity** | `POST /api/paypal/webhook` rejects deliveries with missing headers, malformed or oversized bodies (256 KB limit), or a failed PayPal signature check (`401`). Verified events are still re-checked against PayPal's order API. See [Webhooks](#webhooks). |
| **Server-side payment and amount validation** | Orders are priced from the invoice stored in MySQL, and request bodies are ignored. Before an invoice becomes `PAID`, the order ID, intent, invoice reference, amount and currency (compared in integer cents), line-item total, capture status, and invoice state are all verified. See [Verification before an invoice is paid](#verification-before-an-invoice-is-paid). |
| **Duplicate transaction and event protection** | The `PAID` update is conditional and `paypalCaptureId` is unique. PayPal calls use `PayPal-Request-Id` idempotency keys, and review rows use a unique `dedupeKey`. See [Reconciliation](#reconciliation-and-duplicate-event-handling). |
| **Suspicious payment detection and manual review** | 11 deterministic rules. A failed rule holds the payment and creates a `PaymentReview`. Marking a review as reviewed never changes the invoice. See [Risk rules](#risk-rules-and-the-owner-review-workflow). |
| **Authentication** | The owner password is stored as a scrypt hash and checked in constant time, with login throttling. Sessions use encrypted `HttpOnly` cookies with an 8-hour lifetime. The app fails closed (`503`) when auth is not configured. |
| **Authorization** | Every protected route handler checks the session itself. `src/proxy.ts` adds route-level redirects and `401`s. Owner and customer cookies are sealed with different keys, so neither can be used as the other. Payment reviews are owner-only. |
| **Customer data isolation** | Portal queries are scoped to the client linked to the signed-in customer, as read from MySQL. Customers see only their own `SENT`/`OVERDUE`/`PAID` invoices. Internal IDs, PayPal IDs, and payment tokens are never returned. Cross-customer (IDOR) attempts are tested. |
| **Secure invitations** | Invites are single-use and expire after 7 days. Only a SHA-256 hash of the token is stored. Invites are revocable, and each client can have one pending invite at a time. Accounts are never linked by email address. |
| **Password reset** | Reset links are HMAC-signed, expire after 1 hour, and are single-use (bound to the current password hash). Reset requests are rate-limited and never reveal whether an account exists. |
| **Request hardening** | Cross-site (CSRF) request rejection on state-changing endpoints, request-size limits, anti-framing headers, and links built from `APP_URL` rather than the request's Host header. |
| **Secrets** | PayPal, Gemini, and Zapier credentials are used only on the server. `.env` and `.env.test` are git-ignored. |

---

## Technology Stack

| Layer | Technology | Version (from `package.json`) |
|---|---|---|
| Framework | [Next.js](https://nextjs.org/) (App Router, Route Handlers, `proxy.ts`) | 16.4.2 |
| Language | TypeScript | ^5 |
| UI | React / Tailwind CSS v4 | 19.3.0 / ^4 |
| Database | MySQL | 8.x recommended |
| ORM | [Prisma](https://www.prisma.io/) (`prisma-client` generator) | ^6.19.3 |
| Payments | [`@paypal/paypal-server-sdk`](https://www.npmjs.com/package/@paypal/paypal-server-sdk) (Orders v2) | ^2.5.0 |
| AI | [`@google/genai`](https://www.npmjs.com/package/@google/genai), model `gemini-3.5-flash-lite` (used for both invoice drafts and reminder drafts) | ^2.30.0 |
| Sessions | [`iron-session`](https://github.com/vvo/iron-session) | ^9.0.1 |
| Email delivery | Zapier "Webhooks by Zapier → Catch Hook" → Gmail (configured in Zapier) | — |
| Testing | Node.js built-in test runner (`node --test`) | — |
| Linting | ESLint + eslint-config-next | ^9 / 16.4.2 |

---

## Architecture

ClearCollect is a single Next.js application. Pages and Route Handlers run in one server process, and all business logic lives in `src/lib/`. The browser never talks to PayPal's server APIs, Gemini, or Zapier directly.

```
 Owner browser ──┐                            ┌──► MySQL (Prisma)
 Customer portal ┼─► src/proxy.ts ─► Route ───┤
 /pay/<token> ───┘   (access control) Handlers├──► PayPal Orders v2 + webhook verification
                                     (src/app ├──► Google Gemini (draft text only)
 PayPal servers ─► /api/paypal/webhook  /api) └──► Zapier Catch Hooks ──► Gmail
```

**Payment path (simplified):**

```
Pay button ─► create order (amount/currency from MySQL, idempotency key)
          ─► payer approves on PayPal
          ─► /api/paypal/return  or  signed webhook (verified with PayPal)
          ─► captureOrderForInvoice()  ── re-fetch order, capture, verify
                 ├─ all checks pass ─► recordVerifiedPayment(): conditional PAID update, unique capture ID
                 └─ any rule fails  ─► holdPayment(): PaymentReview row, invoice stays unpaid
```

Key modules:

- `src/lib/paypal.ts`: order creation, capture, verification. It is the **only** code path that sets `PAID`.
- `src/lib/paypal-webhook.ts`: routing for signature-verified webhook events (capture, reversal, unknown order).
- `src/lib/payment-risk.ts`: the deterministic risk rules and the deduplicated review records.
- `src/lib/auth.ts`, `src/lib/customer-auth.ts`, `src/proxy.ts`: owner and customer authentication and route protection.

---

## Project Structure

```
clearcollect/
├── prisma/
│   ├── schema.prisma                  # Client, Invoice, FollowUpReminder, Customer,
│   │                                  # CustomerInvite, PaymentReview (+ enums)
│   └── migrations/                    # See "Database Setup"
├── prisma.config.ts                   # Prisma CLI config (loads .env)
├── .env.example                       # Template for the app's .env
├── .env.test.example                  # Template for the test-only .env.test
├── scripts/
│   ├── auth-setup.ts                  # npm run auth:setup: owner password + session secret
│   ├── create-reminder-test-data.ts   # npm run test-data:reminder: disposable dev data
│   └── test-db.mjs                    # npm run test:db:setup / test:db:reset (guarded)
├── src/
│   ├── proxy.ts                       # Route-level access control (public / portal / owner)
│   ├── app/
│   │   ├── page.tsx                   # / : public landing page
│   │   ├── login/                     # /login : owner sign-in
│   │   ├── dashboard/                 # /dashboard : metrics and recent invoices
│   │   ├── invoices/                  # /invoices : list, filters, send, pay link, PayPal
│   │   ├── create-invoice/            # /create-invoice : AI draft + review
│   │   ├── clients/                   # /clients : clients, archive, portal invites
│   │   ├── follow-ups/                # /follow-ups : AI reminders, drafts, history
│   │   ├── transactions/              # /transactions : verified payments
│   │   ├── payment-reviews/           # /payment-reviews : held payments + risk demo
│   │   ├── settings/                  # /settings : UI only
│   │   ├── pay/[token]/               # /pay/<token> : public invoice payment page
│   │   ├── portal/                    # /portal : Customer Portal (login, signup, invite,
│   │   │                              #   forgot/reset password, dashboard)
│   │   └── api/                       # Route Handlers (see API Reference)
│   ├── components/                    # AppShell, dialogs, forms, theme toggle, UI helpers
│   ├── lib/
│   │   ├── auth.ts                    # Owner password + session checks
│   │   ├── customer-auth.ts           # Customer Portal accounts, sessions, throttles
│   │   ├── customer-invites.ts        # Single-use, hashed, expiring invites
│   │   ├── customer-password-reset.ts # Stateless signed reset links
│   │   ├── customer-portal.ts         # Customer-scoped invoice queries
│   │   ├── paypal.ts                  # Orders, capture, verification, recordVerifiedPayment
│   │   ├── paypal-webhook.ts          # Handling of signature-verified webhook events
│   │   ├── payment-risk.ts            # Deterministic risk rules + review records
│   │   ├── payment-demo.ts            # In-memory risk demo (mock data only)
│   │   ├── payment-link.ts            # /pay/<token> links
│   │   ├── transactions.ts            # Verified payments listing
│   │   ├── ai-invoice.ts, invoice-draft.ts   # Gemini drafting + strict validation
│   │   ├── follow-up.ts, reminder-drafts.ts  # Reminders, drafts, send history
│   │   ├── invoice-email.ts, customer-invite-email.ts, zapier.ts  # Zapier delivery
│   │   ├── invoice-number.ts, invoice-deletion.ts, line-items.ts
│   │   ├── rate-limit.ts, request.ts, safe-redirect.ts, validation.ts
│   │   └── prisma.ts                  # Prisma Client singleton
│   └── generated/prisma/              # Generated Prisma Client
├── tests/
│   ├── *.test.ts                      # node:test suites (see "Running Tests")
│   ├── register.mjs                   # Module hooks + enforces the test DB guard
│   ├── db-guard.mjs                   # Refuses any non-test database
│   ├── fixtures.ts, cleanup.ts        # Test-owned rows and guaranteed cleanup
│   └── auth-helpers.ts, alias-loader.mjs
└── package.json
```

---

## Prerequisites

- **Node.js** and **npm**. The test and helper scripts use `node --experimental-transform-types`, which needs a recent Node.js release. Node 22.x or later is recommended, and the project has been run on Node 24.
- **MySQL** server where you can create databases and users (one database for development, one separate `*_test` database for tests).
- **PayPal Developer account** with a Sandbox REST app and a Sandbox **personal** (buyer) account: [developer.paypal.com](https://developer.paypal.com/).
- **Google AI Studio API key** for Gemini. This is optional: the app works without AI drafting.
- **Zapier account** with Gmail. This is optional: without it, email features run in demo mode.

---

## Installation and Local Setup

```bash
git clone https://github.com/subarssini-crypto/clearcollect.git
cd clearcollect
npm install
```

Then:

1. **Configure the app.** Copy `.env.example` to `.env` and fill in your own values (see [Environment Variables](#environment-variables)).
2. **Create the owner login.** Run `npm run auth:setup`. It writes `AUTH_SECRET` and `OWNER_PASSWORD_HASH` into `.env`.
3. **Create the development database and apply migrations:**
   ```bash
   npx prisma migrate deploy
   npx prisma generate
   ```
   (Details: [Database Setup](#database-setup-mysql--prisma).)
4. **Start the app** with `npm run dev` and open <http://localhost:3000>. Sign in at **/login** with the password you chose in step 2.
5. **Optional, for tests:** set up the separate test database as described in [Running Tests](#running-tests).

---

## Environment Variables

Only variable **names** are listed here. Commented templates with placeholder values are in `.env.example` (app) and `.env.test.example` (tests). Real `.env` and `.env.test` files are git-ignored and must **never be committed**. Secrets are used only on the server and are never sent to the browser.

### Application (`.env`)

`.env` is used by both Next.js and the Prisma CLI.

| Variable | Required | Purpose |
|---|---|---|
| `AUTH_SECRET` | Yes | Encrypts owner and customer session cookies and signs password reset links (32+ characters). Generated by `npm run auth:setup`. |
| `OWNER_PASSWORD_HASH` | Yes | scrypt hash of the owner password (never the password itself). Generated by `npm run auth:setup`. |
| `DATABASE_URL` | Yes | MySQL connection string for the development database. |
| `PAYPAL_CLIENT_ID` | For payments | PayPal Sandbox REST app client ID. |
| `PAYPAL_CLIENT_SECRET` | For payments | PayPal Sandbox REST app secret. |
| `PAYPAL_BASE_URL` | Optional | Selects the PayPal environment. If it is unset or contains `sandbox`, Sandbox is used. |
| `PAYPAL_WEBHOOK_ID` | For webhooks | Webhook ID from the PayPal Developer Dashboard, used for signature verification. |
| `APP_URL` | Optional on localhost | Trusted public base URL for PayPal return/cancel links, payment links, invite links, and reset links. Required when the app is reached through a tunnel or deployment. Links are never built from the request's Host header. |
| `GEMINI_API_KEY` | For AI drafting | Google Gemini API key. Without it, AI endpoints return `503` and manual entry still works. |
| `ZAPIER_WEBHOOK_SECRET` | For Zapier | Shared secret (16+ characters) sent with every Zapier request. Each Zap's Filter step must check it. |
| `ZAPIER_WEBHOOK_URL` | Optional | Catch Hook URL for approved payment reminders. |
| `ZAPIER_INVOICE_WEBHOOK_URL` | Optional | Catch Hook URL for invoice emails. |
| `ZAPIER_INVITE_WEBHOOK_URL` | Optional | Catch Hook URL for Customer Portal invitation emails. Without it, the owner copies the invite link from the dialog. |
| `ZAPIER_PASSWORD_RESET_WEBHOOK_URL` | Optional | Catch Hook URL for Customer Portal password reset emails. Without it, no reset email is sent; in development, the link is printed to the server console. |

### Tests (`.env.test`)

`npm test` and the `test:db:*` scripts load **only** `.env.test`, never `.env`.

| Variable | Required | Purpose |
|---|---|---|
| `TEST_DATABASE_URL` | Yes | `mysql://` URL on localhost whose database name ends in `_test`. |
| `CLEARCOLLECT_TEST_DATABASE` | Yes | Must repeat the test database name exactly, to confirm that it is a test database. |
| `TEST_DATABASE_ALLOW_HOST` | Optional | Allows one specific non-local host, for a dedicated test server only. |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | For Sandbox-backed tests | **Sandbox** credentials only. `tests/paypal-webhook.test.ts` needs them; other Sandbox-backed tests skip without them. |
| `PAYPAL_BASE_URL` | Optional | Must be a Sandbox URL. A live URL aborts the run. |
| `PAYPAL_WEBHOOK_ID` | Optional | If unset, an unregistered placeholder is used, which the invalid-signature tests expect PayPal to reject. |

Do **not** set `DATABASE_URL` in `.env.test`; the guard sets it from `TEST_DATABASE_URL`. No Zapier or Gemini settings are needed, because the tests supply their own fakes.

---

## Database Setup (MySQL + Prisma)

1. Create an empty development database, for example `CREATE DATABASE clearcollect;`, and point `DATABASE_URL` at it.
2. Apply the migrations and generate the Prisma Client:

   ```bash
   npx prisma migrate deploy   # apply all existing migrations
   npx prisma generate         # generate the client into src/generated/prisma
   ```

   For local schema development, use `npx prisma migrate dev` instead.

**Migrations** (in order):

| Migration | Adds |
|---|---|
| `init_client_invoice` | `Client`, `Invoice`, `InvoiceStatus` |
| `add_paypal_payment_tracking` | `paypalOrderId`, `paypalCaptureId` (both unique) |
| `add_invoice_email` | Line items and invoice email state |
| `add_payment_metadata` | `paidAt`, `paypalEnvironment` |
| `client_archive_followup_reminders` | Client archiving, `FollowUpReminder` (drafts and send history) |
| `add_invoice_payment_token` | `paymentToken` for `/pay/<token>` links |
| `customer_portal` | `Customer`, `CustomerInvite` |
| `customer_invite_management` | Invite revocation, one pending invite per client, invite email state |
| `add_payment_reviews` | `PaymentReview`, `PaymentReviewStatus` |

**Schema overview** (`prisma/schema.prisma`):

| Model | Purpose |
|---|---|
| `Client` | Billing contact (`name`, `email?`, `company?`, `archivedAt?`) |
| `Invoice` | `invoiceNumber` (unique), amount (`Decimal(10,2)`), currency, dates, `status`, `lineItems` (JSON), email state, PayPal order/capture IDs, `paidAt`, `paypalEnvironment`, `paymentToken` |
| `FollowUpReminder` | Saved reminder drafts and send history (`DRAFT`, `SENDING`, `UNKNOWN`, `SENT`, `FAILED`) |
| `Customer` | Customer Portal account (scrypt password hash, optional link to one `Client`) |
| `CustomerInvite` | Single-use invite. Only a SHA-256 hash of the token is stored. |
| `PaymentReview` | Payment held for owner review (`code`, `reason`, `recommendedAction`, expected/observed values, unique `dedupeKey`, `OPEN`/`REVIEWED`) |

Prisma CLI configuration lives in `prisma.config.ts`, and the client singleton is in `src/lib/prisma.ts`.

---

## Running the Application

```bash
npm run dev
```

Open <http://localhost:3000>. The landing page is public. Sign in at **/login** to reach the owner dashboard at **/dashboard**. Clients use **/portal** or a **/pay/&lt;token&gt;** link.

| Script | Command | Description |
|---|---|---|
| Development server | `npm run dev` | Next.js dev server |
| Production build | `npm run build` | Build for production |
| Production server | `npm run start` | Serve the production build |
| Lint | `npm run lint` | ESLint |
| Type check | `npx tsc --noEmit` | TypeScript check |
| Auth setup | `npm run auth:setup` | Writes `AUTH_SECRET` and `OWNER_PASSWORD_HASH` into `.env` |
| Test DB setup | `npm run test:db:setup` | Applies all migrations to the guarded test database |
| Test DB reset | `npm run test:db:reset` | Drops and re-creates the test database's tables (removes leftovers) |
| Tests | `npm test` | All suites in `tests/`, one file at a time, against the test database |
| Reminder test data | `npm run test-data:reminder` | Creates or cleans up disposable reminder test data in the **development** database (local only) |

---

## Running Tests

Tests use Node's built-in test runner. Several suites call the real route handlers against MySQL, so they run against a **dedicated test database** that is separate from the development database.

### 1. One-time test database setup

Create a local database whose name ends in `_test`, plus a MySQL user that can access only that database:

```sql
CREATE DATABASE clearcollect_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'clearcollect_test'@'localhost' IDENTIFIED BY '<choose-a-password>';
GRANT ALL PRIVILEGES ON clearcollect_test.* TO 'clearcollect_test'@'localhost';
```

Because this user can reach only the test database, even a misconfigured run cannot read or write development data.

Then:

```bash
cp .env.test.example .env.test   # fill in TEST_DATABASE_URL, CLEARCOLLECT_TEST_DATABASE, Sandbox creds
npm run test:db:setup            # apply migrations to the test database
```

### 2. Run the tests

```bash
npm test                         # every suite, one file at a time (--test-concurrency=1)
npm run test:db:reset            # optional: wipe leftovers after an interrupted run
```

To run a single suite, use the same flags as `npm test` with one file:

```bash
node --env-file=.env.test --experimental-transform-types --no-warnings --import ./tests/register.mjs --test tests/payment-risk.test.ts
```

### Test database safety guard

`tests/register.mjs` runs `tests/db-guard.mjs` in every test process **before any test file loads**. `scripts/test-db.mjs` runs the same guard before calling the Prisma CLI. The run aborts if any of the following is true:

- `TEST_DATABASE_URL` is missing or is not a `mysql://` URL;
- the database name does not end in `_test`, or does not match `CLEARCOLLECT_TEST_DATABASE`;
- the host is not local (unless `TEST_DATABASE_ALLOW_HOST` names that exact host);
- it is the same database as `DATABASE_URL` in `.env`;
- any other `DATABASE_URL` is already set in the environment;
- `NODE_ENV=production`, or `PAYPAL_BASE_URL` is not a Sandbox URL;
- after connecting, the server reports a different current database (`SELECT DATABASE()`).

On success, the guard sets `DATABASE_URL` to `TEST_DATABASE_URL`, so Prisma can reach only the test database. `test:db:reset` is destructive, so it also verifies the live connection before running.

### Test isolation requirements

Every suite is expected to follow these rules:

- **Use only test-owned rows.** Records are clearly named (for example `INV-TEST-<tag>-<stamp>-…` invoices, `… (TEST ONLY)` clients, and `@example.invalid` customers). Suites never select or modify other rows.
- **Always clean up.** Cleanup runs in `after` hooks, children first, through `tests/cleanup.ts`. Every step runs even if an earlier one fails, and failures are reported together. `tests/fixtures.ts` provides shared, self-cleaning client and invoice fixtures.
- **Run serially.** `npm test` uses `--test-concurrency=1` because suites share one database and in-memory throttles.
- **Contact no real email or payment services.** No test sends a real email or captures a real payment. Zapier and Gemini are always faked. PayPal is either mocked or used only in Sandbox, where orders are never approved or captured.

### Test suites

| Suite | Coverage | External services |
|---|---|---|
| `auth.test.ts` | Owner auth: `401`/`503` on every protected route, forged or expired cookies, throttling, proxy redirects | Test DB |
| `request-guards.test.ts` | CSRF, request-size limits, trusted PayPal return origin, anti-framing headers | Test DB (no writes) |
| `invoice-draft.test.ts` | AI draft validation, recomputed totals, clarification questions, client resolution | Gemini mocked |
| `invoice-number.test.ts` | Concurrent invoice-number allocation | In-memory |
| `invoice-email.test.ts` | Invoice email composition and Zapier outcomes | Fake `fetch`, in-memory store |
| `follow-up.test.ts` | Reminder validation, placeholder filling, Zapier errors and timeouts | Fake `fetch` |
| `data-management.test.ts` | Draft deletion, client archiving, reminder draft deletion | Test DB (test-owned rows) |
| `dashboard-metrics.test.ts` | Dashboard calculations | Offline |
| `transactions.test.ts` | Verified payment metadata, exactly-once recording | In-memory store; route test reads only |
| `payment-risk.test.ts` | Every risk rule, review deduplication, verified-webhook decisions, the demo route | In-memory dependencies, no PayPal |
| `payment-workflow.test.ts` | End to end: owner creates invoice → linked customer sees it → payment link / portal order → verified webhook marks it `PAID` once; forged webhooks refused; IDOR blocked; amount mismatch, order mismatch, and unknown order held for review | Test DB; **PayPal fully mocked**; any other outbound request fails the test |
| `paypal-webhook.test.ts` | Unsigned, forged, malformed, and oversized webhooks rejected; duplicate deliveries | **Real PayPal Sandbox** + test DB |
| `payment-link.test.ts` | `/pay/<token>` exposure rules, order creation, amount tampering | Test DB; PayPal Sandbox (skipped without credentials; orders are never captured) |
| `customer-portal.test.ts` | Landing page, portal auth, customer-scoped invoices, owner-only payment reviews, portal payment | Test DB; PayPal Sandbox (skipped without credentials) |
| `customer-invites.test.ts` | Invite creation, revocation, redemption, invitation email outcomes | Test DB; Zapier never contacted |
| `customer-password-reset.test.ts` | Reset link signing, expiry, single use, no account enumeration | Test DB; fake `fetch` |
| `reminder-test-data.test.ts` | Safety checks of the reminder test-data script | Offline |
| `ui-guards.test.ts` | Honest UI copy (no false delivery claims), login setup state, no registration endpoint | Reads source files |

Only PayPal can produce real webhook signatures. The signed happy path is therefore covered in two ways: by `payment-workflow.test.ts` with a mocked PayPal verifier, and by manual testing with real Sandbox deliveries (see [Webhooks](#webhooks)).

---

## Demo Guide for Judges

Every scenario below uses **PayPal Sandbox** or **in-memory mock data**, so no real money moves. Emails are sent only if you configure your own Zapier Zaps; otherwise the app runs in labelled demo mode and sends nothing.

### Scenario 1: AI invoice drafting (needs `GEMINI_API_KEY`)

1. Sign in at **/login**, add a client on **/clients** (use an email address you control).
2. On **/create-invoice**, enter something like *"12 hours of UX research at $85/hr, due in 30 days"* and click **Generate with AI**.
3. Note that the server recomputes the totals and labels where each date came from. Try *"3 days of frontend work"* without a rate: the app asks a clarification question instead of guessing.
4. Confirm the review and click **Save Draft**.

### Scenario 2: PayPal Sandbox payment (needs Sandbox credentials)

1. Send the draft (or set it to `SENT`), then click **Pay with PayPal** on **/invoices**.
2. Sign in with your Sandbox **personal** account and approve the payment.
3. The invoice shows **Paid** and appears on **/transactions** with its capture ID and environment.
4. Reload the return URL: nothing is captured a second time.
5. Repeat with **Cancel and return**: the invoice stays unpaid.

### Scenario 3: Customer Portal and payment link

1. On **/clients**, invite the client to the portal and copy the invite link (or email it via Zapier).
2. In a private browser window, open the link, sign up, and view only that client's invoices at **/portal**.
3. On **/invoices**, copy a `/pay/<token>` link for an unpaid invoice and open it signed out: only that one invoice is visible and payable.

### Scenario 4: Suspicious payment detection (no external services)

1. Open **/payment-reviews** and click **Run demo** in the *Fraud-check demo* panel.
2. The real deterministic rules run against mock invoices `DEMO-001` to `DEMO-003`, held in memory. The results cover a valid payment, a wrong amount, a duplicate webhook delivery, and a capture reused for another invoice.
3. Every result is labelled **DEMO**. The demo writes nothing to the database, calls no PayPal API, and sends no email.

Real held payments, for example from a signed webhook whose amount does not match, appear in the same page's review list. Mark one **Reviewed** after acting in PayPal; doing so never changes the invoice.

### Scenario 5: AI payment reminder

1. On **/follow-ups**, pick an unpaid invoice that is overdue or due within 7 days and click **Draft with AI**.
2. Edit the text, then **Approve & Send**. Without Zapier configured, the app shows demo mode and sends nothing.

### Other demo-mode behaviour

- **Email demo mode:** when a Zapier URL is not configured, invoice emails and reminders are **not sent**, and the UI says so. Invoices stay `DRAFT`.
- **Settings page** is UI only and saves nothing.
- **Reminder preview** on Create Invoice is sample wording only and never sends anything.
- **Disposable reminder data:** `npm run test-data:reminder -- --email <an inbox you control>` creates a test client and a `SENT` test invoice in the local development database. `--cleanup` removes them. The script refuses `NODE_ENV=production` and non-local databases, rejects emails that belong to existing clients, and only deletes the data it created.

---

## Authentication and Authorization

### Owner (single-owner, not multi-tenant)

> **Single owner only.** One owner password unlocks the business side of the app, and every owner session sees **all** clients and invoices. There are no owner accounts, roles, or per-business isolation.

**Setup:**

1. Run `npm run auth:setup`. It asks for the password twice (12+ characters) and writes `AUTH_SECRET` and `OWNER_PASSWORD_HASH` into `.env`. The password itself is never stored or printed.
2. Restart `npm run dev`.
3. Sign in at **/login**. If sign-in is not configured, the page shows a **Setup required** state. There is no browser-based registration.

Running the script again changes the password and signs out every existing session. Rotating `AUTH_SECRET` also signs everyone out.

**How it works:**

- **Password:** scrypt hash, checked in constant time. After 10 wrong passwords in 15 minutes, sign-in is refused (`429`) until the window passes. The counter is kept in memory.
- **Session:** encrypted `iron-session` cookie (`cc_session`): `HttpOnly`, `SameSite=Lax`, 8-hour lifetime, and `Secure` on every host except localhost.
- **Enforcement:** every protected route handler checks the session itself (`requireOwner`). `src/proxy.ts` also redirects signed-out page visits to `/login` and returns `401` for signed-out API calls. Hidden UI is never relied on for security.
- **Fails closed:** if `AUTH_SECRET` or `OWNER_PASSWORD_HASH` is missing or invalid, protected routes return `503`.
- **CSRF:** state-changing endpoints, including login and logout, reject cross-site requests.

### Customer Portal accounts

Customer accounts are completely separate from the owner login. They use their own cookie (`cc_customer`), sealed with a key derived from `AUTH_SECRET` for this purpose only, so neither cookie can be used as the other. See [Customer Portal](#customer-portal).

### Public endpoints (no session)

| Endpoint | Caller | Protection |
|---|---|---|
| `/` | Anyone | Static landing page, no data |
| `POST /api/paypal/webhook` | PayPal servers | PayPal signature verification; order re-fetched and re-verified with PayPal |
| `GET /api/paypal/return` | Payer's browser | Capture verified server-side; the query string only identifies the order |
| `GET /api/paypal/cancel` | Payer's browser | Redirect only; no state change |
| `/pay/<token>`, `/api/pay/<token>[/order]` | Client with a payment link | Unguessable 32-byte token; request body ignored |
| `/portal/login`, `/portal/signup`, `/portal/invite`, `/portal/forgot-password`, `/portal/reset-password`, `/api/customer/auth/*` | Customers | Rate limiting, no account enumeration |
| `POST /api/auth/login`, `POST /api/auth/logout` | Owner's browser | Cross-site and content-type guards, throttling |
| `GET /api/auth/status` | Login page | Returns only `configured` and `signedIn` booleans |

---

## AI Invoice Generator

On **/create-invoice**, describe the work (for example *"12 hours of UX research for Acme at $85/hr, due in 30 days"*) and click **Generate with AI**.

1. The browser sends the text (max 2,000 characters), the selected client ID, and any dates already in the form to `POST /api/ai/invoice-draft`.
2. **Missing details become questions, not guesses.** If the rate is hourly but the work is described only in days, weeks, or months, the app asks a clarification question; it never assumes 8 hours per day. A missing quantity or rate also becomes an explicit question (for example *"Frontend: 3 hours at what hourly rate (USD/hour)?"*). Answers must be a single exact, positive number in the right unit and currency, and the server applies them without a second Gemini call.
3. Gemini receives only the request text and today's date. It returns structured JSON and never returns a client ID, status, or payment field.
4. The server strictly validates the result (`src/lib/invoice-draft.ts`):
   - status, payment, total, or client-ID fields are rejected;
   - the client is resolved against MySQL records, never guessed or created;
   - line amounts and the total are recomputed in integer cents;
   - any quantity or rate that does not appear in the request is flagged;
   - dates are labelled with their source (request, form, or app default).
5. The form shows a **Review before saving** panel. **Save Draft** stays disabled until the owner confirms the review. The AI cannot set `PAID` or touch PayPal.

**Invoice numbers:** if the field is left blank, the server assigns the next `INV-YYYY-NNN` number. Concurrent saves are retried safely against the unique constraint.

---

## Payment Reminders (Follow-ups)

**/follow-ups** lists unpaid invoices (`SENT`/`OVERDUE`, no recorded payment) that are overdue or due within 7 days.

1. Open the editor, which starts with a plain template, and optionally click **Draft with AI**.
2. Gemini writes only the wording. It must use the placeholders `{{invoice_number}}`, `{{amount}}`, and `{{due_date}}`, which the server fills in from the database. Drafts that leave out a placeholder or mention a different invoice number are rejected.
3. Edit the reminder, then either **save it as a draft** for later or click **Approve & Send**.
4. The server checks again that the invoice is still unpaid (`409` otherwise) and has a valid client email (`422` otherwise), then hands the reminder to Zapier.

Every send attempt is stored as a `FollowUpReminder` row (`SENDING` → `SENT` / `FAILED` / `UNKNOWN`), so the app keeps a reminder history. Only unsent drafts can be deleted. A new send soon after a recent send to the same invoice is refused (`409`) to avoid duplicate emails.

---

## Zapier Email Automation

ClearCollect sends email only through Zapier "Webhooks by Zapier → Catch Hook" Zaps that forward to Gmail. Each flow uses its **own** Zap and URL, so one Zap's filter cannot silently drop another flow's emails.

| Flow | Variable | Without it |
|---|---|---|
| Invoice emails | `ZAPIER_INVOICE_WEBHOOK_URL` | Demo mode: nothing is sent, and the invoice stays `DRAFT` |
| Approved payment reminders | `ZAPIER_WEBHOOK_URL` | Demo mode: nothing is sent, and the app says so |
| Customer Portal invitations | `ZAPIER_INVITE_WEBHOOK_URL` | The owner copies the invite link from the dialog |
| Customer password resets | `ZAPIER_PASSWORD_RESET_WEBHOOK_URL` | No email is sent; in development, the link is printed to the server console |

**Zap setup (one per flow):** Catch Hook trigger → **Filter** that continues only if `auth_token` exactly matches `ZAPIER_WEBHOOK_SECRET` → **Gmail → Send Email** with To = `recipient_email`, Subject = `subject`, Body = `message`.

**Invoice emails.** Send a saved **DRAFT** invoice from **Create Invoice** (after **Save Draft**) or with the **Send** action in **Invoices**.

- The dialog shows exactly what the server will send. The recipient is always the client email stored in MySQL; the browser cannot choose it.
- The body includes the invoice number, dates, line items, and total. When a trusted origin is available (`APP_URL`, or localhost in development), it also includes the client's **secure payment link**. No PDF is attached.
- The invoice becomes `SENT` **only after Zapier accepts the request**. A database claim prevents concurrent sends.

**Delivery outcomes** (invoice emails and reminders):

| Situation | Result |
|---|---|
| URL unset | **Demo mode**: nothing is sent |
| URL set without a valid secret, URL not https, or secret too short | **Misconfigured** (`503`), nothing sent |
| Zapier returns 2xx | "Accepted by Zapier" (Gmail delivery happens inside the Zap); an invoice is marked `SENT` |
| Zapier error or unreachable | Not sent (`502`); retry allowed |
| No response within 10 seconds | **Unknown** (`504`). Check Zap history before retrying or marking the email as sent. |
| Concurrent invoice send | Refused (`409`) |

ClearCollect only confirms that Zapier **accepted** a request, not that the email was delivered.

---

## Customer Portal and Payment Links

### Customer Portal

- **Invite-only linking.** The owner invites a client from **/clients**. An invite is single-use, expires after 7 days, and can be revoked or regenerated. Each client can have at most one pending invite at a time. Only a SHA-256 hash of the token is stored, so the link is shown only once. The invite can be emailed via Zapier or copied from the dialog.
- **Accounts are never linked by email address.** A customer signs up at **/portal/signup** and is linked to a client only by redeeming the owner's invite. An account linked to one client is never moved to another.
- **Scoped data.** Every portal query is scoped to the client linked to the signed-in account, as read from MySQL rather than from the request. Customers see only their own `SENT`, `OVERDUE`, and `PAID` invoices, identified by invoice number. Internal IDs, PayPal IDs, payment tokens, and owner-only fields are never returned.
- **Payment.** Customers pay unpaid invoices through the same server-side PayPal flow and can view their verified payment history.
- **Password reset.** Reset links are stateless and HMAC-signed. They expire after 1 hour and stop working once used, because they are bound to the current password hash. A successful reset signs out all sessions. Responses never reveal whether an email has an account.
- **Abuse protection.** Login failures are rate-limited per email and globally. Signups and reset requests are also rate-limited. All limits are kept in memory.

### Secure payment links

- The owner can copy a `/pay/<token>` link for a payable invoice from **/invoices**. The link is also included in invoice emails when possible.
- The token is 32 random bytes. It is never derived from the invoice ID and never logged.
- The public page shows only what the client already receives in the invoice email. Unknown tokens and `DRAFT`/`CANCELLED` invoices all return the same `404`.
- Payment uses the same verified server-side flow. The amount and currency always come from MySQL.

---

## PayPal Sandbox Checkout

### Flow

1. The owner (from **/invoices**), a customer (from **/portal**), or a client with a payment link starts payment for a `SENT` or `OVERDUE` invoice.
2. The server creates a PayPal order (intent `CAPTURE`) from the **invoice's stored amount and currency**; any request body is ignored. A still-valid existing order is reused. An invoice whose stored line items no longer add up to its amount is refused before any order is created.
3. The payer approves the payment on PayPal.
4. **Approve:** PayPal redirects to `GET /api/paypal/return`. The server fetches the order, captures it, verifies the result, and records the payment. If the payment is held for review, the payer is told not to pay again.
5. **Cancel:** `GET /api/paypal/cancel` changes nothing.

### Webhooks

`POST /api/paypal/webhook` confirms payments even if the payer never returns to the app.

| Event | Handling |
|---|---|
| `CHECKOUT.ORDER.APPROVED` | Capture server-side, verify, record |
| `PAYMENT.CAPTURE.COMPLETED` | Verify the completed capture, record |
| `PAYMENT.CAPTURE.REFUNDED` / `REVERSED` / `DENIED` | Held as a `REVERSAL_EVENT` review item. The invoice is **not** changed automatically. |
| `PAYMENT.CAPTURE.PENDING` | Logged; no invoice change |
| Verified event for an order not linked to any invoice | `UNKNOWN_ORDER` review item |
| Any other type | Acknowledged and ignored |

**Response contract:**

- `401` for missing headers, malformed bodies, or failed signature verification.
- `200` once the event is processed, intentionally ignored, or durably recorded as a review.
- `5xx` for transient failures (including a failed review write), so that PayPal retries.

**Dashboard setup (Sandbox):**

1. Expose the app publicly (PayPal cannot reach `localhost`), for example with a tunnel, and set `APP_URL` to that public URL.
2. In the PayPal Developer Dashboard, go to **Apps & Credentials** → **Sandbox** → your app → **Add Webhook**, and enter `https://<public-host>/api/paypal/webhook`.
3. Subscribe to `CHECKOUT.ORDER.APPROVED` and `PAYMENT.CAPTURE.COMPLETED`. Optionally add `PAYMENT.CAPTURE.PENDING`, `DENIED`, `REFUNDED`, and `REVERSED`.
4. Copy the **Webhook ID** into `PAYPAL_WEBHOOK_ID` and restart the server.

> Events sent by the Dashboard's webhook simulator are not expected to pass signature verification for your registered webhook, so ClearCollect rejects them with `401`. Use real Sandbox payments to test the signed path.

---

## Payment Security, Reconciliation, and Risk Review

### Verification before an invoice is paid

Only `src/lib/paypal.ts` can mark an invoice `PAID`, and only when all of the following are true:

- The order ID matches the invoice's stored `paypalOrderId`, the intent is `CAPTURE`, and the purchase unit references this invoice.
- The order and capture amount and currency match the invoice **exactly**, compared in integer cents.
- The invoice's stored line items still add up to its stored amount.
- The capture status is `COMPLETED`. A `PENDING` capture leaves the invoice unpaid.
- The capture ID is not already recorded against another invoice.
- The invoice is still `SENT` or `OVERDUE` and unpaid.

Ordinary invoice APIs cannot set `PAID`, and paid invoices cannot be edited or deleted. Changing an invoice's amount or currency detaches any pending PayPal order.

### Reconciliation and duplicate-event handling

- **Exactly-once recording:** the `PAID` update is conditional (the invoice is still unpaid, has the same order, and has no capture recorded), and `paypalCaptureId` is unique. A repeated webhook or return visit for the same capture changes nothing and leaves the first record intact.
- **Idempotent PayPal calls:** `PayPal-Request-Id` headers make order creation and capture safe to retry. Duplicate clicks resolve to one order.
- **Recorded payment metadata:** the capture ID, PayPal's capture time (`paidAt`), and the environment (`SANDBOX`/`LIVE`) are stored together. Older rows that are missing these fields show "Unavailable" instead of guessed values.
- **One review per issue:** each `PaymentReview` has a unique `dedupeKey` (rule + invoice + order + capture). Webhook redeliveries, or a return visit and a webhook for the same capture, therefore create a single review. Each reversal event is recorded separately.

### Risk rules and the owner review workflow

These are **deterministic rules**, not machine learning or AI. Each rule compares data that PayPal returned to the server with the invoice in MySQL:

| Code | Triggered when |
|---|---|
| `AMOUNT_MISMATCH` | Captured amount differs from the invoice amount |
| `CURRENCY_MISMATCH` | Capture currency differs from the invoice currency |
| `ORDER_MISMATCH` | The PayPal order's reference, amount, or currency does not match the invoice |
| `LINE_ITEMS_TOTAL_MISMATCH` | Stored line items no longer add up to the stored amount |
| `LINE_ITEMS_INVALID` | Stored line items are malformed |
| `DUPLICATE_CAPTURE` | The capture is already recorded as payment for another invoice |
| `ALREADY_PAID_OTHER_CAPTURE` | The invoice was already paid by a different capture |
| `INVOICE_NOT_PAYABLE` | Funds were captured for an invoice that is not `SENT`/`OVERDUE` (for example, cancelled after approval) |
| `INVOICE_STATE_CHANGED` | The invoice changed while the payment was being recorded |
| `UNKNOWN_ORDER` | A verified event refers to an order not linked to any invoice |
| `REVERSAL_EVENT` | PayPal reports a refund, reversal, or denial |

When a rule fails:

1. The payment is **held**. The invoice stays unpaid, and nothing is approved or refunded automatically.
2. A `PaymentReview` row stores the reason, a recommended action (for example, "Refund the duplicate capture in PayPal"), and the expected and observed values.
3. The owner sees the review on **/payment-reviews**, takes any action in PayPal, and marks it **Reviewed**.
4. Marking a review as reviewed **never changes the invoice**. An invoice can only become `PAID` through a verified capture.

### Other safeguards

- PayPal, Gemini, and Zapier credentials are used only on the server.
- Return, cancel, payment, invite, and reset links use `APP_URL` (or a local development origin), never a spoofable Host header.
- Request-size limits, cross-site request rejection, and anti-framing headers are applied and covered by tests.

---

## API Reference

Every route requires the owner session unless it is marked **public** or **customer**.

| Method & Path | Description |
|---|---|
| `GET / POST /api/clients` | List clients / create a client |
| `PATCH /api/clients/[id]` | Archive or restore a client `{ archived }` |
| `GET / POST /api/clients/[id]/invites` | List invites / create (and optionally email) a portal invite |
| `DELETE /api/clients/[id]/invites/[inviteId]` | Revoke an unused invite |
| `GET / POST /api/invoices` | List (`?status=`, `?clientId=`, `?page=`, `?limit=` ≤ 100) / create (`DRAFT` or `SENT` only) |
| `GET / PATCH / DELETE /api/invoices/[id]` | Read / update (never to `PAID`) / delete an eligible draft |
| `GET / POST /api/invoices/[id]/send` | Preview / send the invoice email via Zapier |
| `POST /api/invoices/[id]/payment-link` | Return the `/pay/<token>` URL, creating it on first use |
| `POST /api/invoices/[id]/paypal-order` | Create or reuse a PayPal order; returns the approval URL |
| `GET /api/transactions` | Verified payments (`?page=`, `?limit=`) |
| `GET /api/payment-reviews` | Held payments (`?status=OPEN\|REVIEWED\|all`) |
| `PATCH /api/payment-reviews/[id]` | Mark a review `REVIEWED` (never changes the invoice) |
| `POST /api/payment-reviews/demo` | Run the in-memory risk demo (mock data only) |
| `POST /api/ai/invoice-draft` | AI draft or clarification questions; never saves |
| `POST /api/follow-ups/draft` | Gemini reminder draft for an unpaid invoice |
| `GET / POST /api/follow-ups/drafts`, `DELETE /api/follow-ups/drafts/[id]` | Saved reminder drafts |
| `POST /api/follow-ups/send` | Send an approved reminder via Zapier (or demo mode) |
| `GET /api/follow-ups/status` | Delivery mode: `zapier`, `demo`, or `misconfigured` (no secrets) |
| `POST /api/paypal/webhook` | **Public**: signature-verified PayPal webhook |
| `GET /api/paypal/return`, `GET /api/paypal/cancel` | **Public**: PayPal redirects |
| `GET /api/pay/[token]`, `POST /api/pay/[token]/order` | **Public**: payment-link invoice view / start payment |
| `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/status` | **Public**: owner sign-in |
| `POST /api/customer/auth/{signup,login,logout,forgot-password,reset-password}`, `GET /api/customer/auth/invite` | **Public**: customer auth and invite preview |
| `GET /api/customer/me`, `GET /api/customer/invoices`, `GET /api/customer/payments` | **Customer**: own profile, invoices, payment history |
| `POST /api/customer/invoices/pay`, `POST /api/customer/invite` | **Customer**: start payment / redeem an invite |

Without a session, protected routes return `401`. If owner auth is not configured, they return `503`. Input validation lives in `src/lib/validation.ts`.

---

## Light/Dark Theme

The sun/moon toggle switches between light and dark themes. The choice is saved in `localStorage` (`clearcollect-theme`); without a saved choice, the OS preference is used. An inline script in `src/app/layout.tsx` applies the theme before the first paint, so there is no flash. Colors come from design tokens in `src/app/globals.css`, and a test fails if a page hard-codes white surfaces or hex colors.

---

## Current Limitations

| Limitation | Detail |
|---|---|
| **Sandbox only** | Tested only against PayPal Sandbox. Live use would require production credentials, a live webhook, and a security review. No production deployment is documented. |
| **Single owner, not multi-tenant** | One password unlocks all business data. There are no owner accounts, roles, or per-business isolation. Sessions are stateless cookies, so a copied owner cookie stays valid until it expires (8 hours) or the password or `AUTH_SECRET` changes. |
| **Webhooks need a public URL** | PayPal cannot deliver to `localhost`. Without a registered webhook, a payment is confirmed only when the payer returns to the app. |
| **Signed webhook path tested with a mock** | Only PayPal can produce valid signatures. Automated tests cover the signed path with a mocked verifier (`payment-workflow.test.ts`) and real Sandbox rejection of invalid signatures (`paypal-webhook.test.ts`). The full signed path with real PayPal must be tested manually with Sandbox deliveries. |
| **Refunds and reversals are flagged, not applied** | Refund, reversal, and denial events create a review item but do not change invoice status. The owner reconciles them manually. |
| **Risk rules are fixed** | The checks are deterministic comparisons. They do not score behaviour, learn from history, or detect fraud patterns beyond the listed rules. |
| **No general webhook event log** | Idempotency relies on invoice state, the unique capture ID, and review dedupe keys. Individual webhook events are not stored unless they produce a review. |
| **Email via Zapier only** | ClearCollect confirms that Zapier accepted an email, not that Gmail delivered it. Invoice emails have no PDF attachment. |
| **No scheduled reminders** | The owner drafts and sends reminders manually; there is no automatic schedule. |
| **In-memory rate limits** | Login, signup, and reset throttles reset when the server restarts and are not shared across server instances. |
| **AI limits** | Drafts depend on Gemini availability and free-tier quotas (`429` when exhausted). The clarification heuristics match common phrasings, so unusual wording may be flagged for confirmation unnecessarily. |
| **Line items on older invoices** | Invoices created before line items were stored have only a total and a combined description. |
| **Settings not persisted** | The Settings page is UI only. |
| **Currency support** | Some currencies (for example `INR`) may be rejected, depending on the PayPal merchant account. |

---

## Future Enhancements

The following are **not implemented** and are possible next steps:

- Applying refunds and reversals to invoice status after owner confirmation.
- Scheduled or automatic reminder follow-ups (still owner-approved).
- Persisted settings and PayPal account connection from the UI.
- Multi-user / multi-business accounts with roles and data isolation.
- Shared rate limiting and session revocation for multi-instance deployments.
- A stored webhook event log for auditing.
- PDF invoice attachments.
- Additional configurable risk rules (for example, payer or velocity checks).
- Production deployment and a public demo environment.

---

## License

This project is licensed under the **MIT License**. Copyright (c) 2026 Subarssini. See [LICENSE](./LICENSE).
