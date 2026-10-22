# ClearCollect

**AI-assisted invoicing and payment follow-up for freelancers and small businesses.**

> Built for the [PayPal AI Hackathon](https://developer.paypal.com/). ClearCollect now stores clients and invoices in **MySQL via Prisma** and accepts invoice payments through **PayPal Sandbox Checkout** (Orders v2, server-side). An **AI invoice generator** (Google Gemini) drafts invoices from plain-language descriptions for review. Sign-in is a **single-owner demo login**: one password protects the whole app. It is **not** multi-tenant (see [Authentication](#authentication-single-owner-demo)).

---

## Table of Contents

- [Problem Statement](#problem-statement)
- [Current Features](#current-features)
- [Technology Stack](#technology-stack)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Environment Variables](#environment-variables)
- [Authentication (single-owner demo)](#authentication-single-owner-demo)
- [Database Setup (MySQL + Prisma)](#database-setup-mysql--prisma)
- [Running Locally](#running-locally)
- [PayPal Sandbox Checkout](#paypal-sandbox-checkout)
- [API Reference](#api-reference)
- [Project Structure](#project-structure)
- [Current Limitations](#current-limitations)
- [Roadmap](#roadmap)
- [License](#license)

---

## Problem Statement

Freelancers and small business owners spend significant time chasing unpaid invoices. Writing polite but firm follow-up emails is repetitive, awkward, and easy to forget. Late payments disrupt cash flow and strain client relationships.

**ClearCollect** combines a clean invoicing interface with direct PayPal payment and (planned) an AI-powered follow-up assistant that drafts payment reminders based on invoice details and how overdue the invoice is.

---

## Current Features

| Feature | Status | Description |
|---|---|---|
| **Dashboard** | ✅ Implemented | Summary cards and recent invoices, loaded from MySQL |
| **Invoices List** | ✅ Implemented | Invoices from MySQL with status filter tabs (All / Paid / Pending / Overdue / Draft) and a **Pay with PayPal** button on payable invoices |
| **Create Invoice** | ✅ Implemented | Saves invoices to MySQL as DRAFT for an existing client, with editable line items and currency. Line items are combined into the invoice description |
| **Client Management** | ✅ Implemented | Client grid with totals from MySQL; add new clients |
| **PayPal Sandbox Checkout** | ✅ Implemented | Server-side order creation, approval redirect, cancellation, and verified server-side capture that marks the invoice **PAID** |
| **AI Follow-up Reminders** | ✅ Implemented | Gemini drafts reminders for unpaid SENT/OVERDUE invoices; you review and edit, then approve to deliver via Zapier (demo mode when Zapier is not configured) |
| **AI Invoice Generator** | ✅ Implemented | Gemini turns a plain-language request into an editable draft (client, currency, dates, line items); nothing is saved until you click Save Draft |
| **Settings** | 🔲 Planned (UI only) | Preferences are not persisted; the "Connect PayPal" button is a disabled placeholder |
| **Responsive Sidebar** | ✅ Implemented | Active route highlighting and mobile menu |

---

## Technology Stack

| Layer | Technology | Version |
|---|---|---|
| Framework | [Next.js](https://nextjs.org/) (App Router, Route Handlers) | 16.4.2 |
| Language | TypeScript | ^5 |
| UI | React / Tailwind CSS v4 | 19.3.0 / ^4 |
| Database | MySQL | 8.x recommended |
| ORM | [Prisma](https://www.prisma.io/) (`prisma-client` generator) | 6.19.3 |
| Payments | [`@paypal/paypal-server-sdk`](https://www.npmjs.com/package/@paypal/paypal-server-sdk) (Orders v2) | 2.5.0 |
| AI | [`@google/genai`](https://www.npmjs.com/package/@google/genai) (model `gemini-3.5-flash-lite`) | ^2.30.0 |
| Linting | ESLint + eslint-config-next | ^9 / 16.4.2 |

---

## Prerequisites

- **Node.js** v20 or later and **npm**
- **MySQL** server you can create a database on
- **PayPal Developer account** with a Sandbox REST app and a Sandbox **personal** (buyer) account — [developer.paypal.com](https://developer.paypal.com/)

---

## Installation

```bash
git clone https://github.com/subarssini-crypto/clearcollect.git
cd clearcollect
npm install
```

---

## Environment Variables

Copy `.env.example` to `.env` in the project root (used by both Next.js and the Prisma CLI) and fill in your values. `.env` is ignored by Git — **never commit it**.

```bash
# .env — DO NOT COMMIT

# Single-owner sign-in (required — every page and API route except the PayPal
# callbacks needs it). Generate both with: npm run auth:setup (writes them into .env)
# AUTH_SECRET: 32+ random characters that encrypt the session cookie.
# OWNER_PASSWORD_HASH: scrypt hash of the owner password (never the password itself).
AUTH_SECRET="generate-with-npm-run-auth-setup"
OWNER_PASSWORD_HASH="generate-with-npm-run-auth-setup"

# MySQL connection string
DATABASE_URL="mysql://USER:PASSWORD@localhost:3306/clearcollect"

# PayPal Sandbox REST app credentials (Developer Dashboard → Apps & Credentials → Sandbox)
PAYPAL_CLIENT_ID="your-sandbox-client-id"
PAYPAL_CLIENT_SECRET="your-sandbox-client-secret"

# Selects the PayPal environment. Any URL containing "sandbox" (or leaving it unset) uses Sandbox.
PAYPAL_BASE_URL="https://api-m.sandbox.paypal.com"

# Public base URL used for PayPal return/cancel links. Required whenever the app is
# reached through anything other than localhost (a tunnel such as ngrok, or a deployment);
# without it, payments are only accepted on localhost so a spoofed Host header cannot
# redirect payers to another site.
# APP_URL="http://localhost:3000"

# Webhook ID from Developer Dashboard → your Sandbox app → Webhooks (required for /api/paypal/webhook)
PAYPAL_WEBHOOK_ID="your-sandbox-webhook-id"

# Google Gemini API key for the AI invoice generator
GEMINI_API_KEY="your-gemini-api-key"

# Optional: Zapier delivery for approved follow-up reminders (demo mode when both are unset)
ZAPIER_WEBHOOK_URL="https://hooks.zapier.com/hooks/catch/your-id/your-hook/"
ZAPIER_WEBHOOK_SECRET="your-long-random-secret"
```

PayPal credentials and the Gemini key are used **only on the server** (`src/lib/paypal.ts`, `src/lib/ai-invoice.ts`). No key is exposed to the browser.

---

## Authentication (single-owner demo)

> **Single owner only — not multi-tenant.** There are no user accounts. One owner password unlocks the whole app, and every signed-in session sees and manages **all** clients and invoices. Do not present this demo as supporting separate, isolated accounts for multiple businesses.

### Setup

1. Generate the two settings:

   ```bash
   npm run auth:setup
   ```

   It asks for the password twice (12+ characters). Typing is hidden in PowerShell, cmd, and the VS Code terminal; Git Bash/mintty may echo it. It then writes `AUTH_SECRET` and `OWNER_PASSWORD_HASH` into `.env`, replacing existing lines for them (such as the `.env.example` placeholders). Nothing secret is printed, and the password itself is not stored anywhere.
2. Restart `npm run dev` (or rebuild and restart for production).
3. Open the app, then sign in at **/login** with the password.

The login page explains these steps and says there is no public registration. If sign-in is not configured, it shows a **Setup required** state (via `GET /api/auth/status`) instead of a generic error. The password can only be created or changed in the project terminal; there is no browser-based setup.

To change the password, run step 1 again: the new hash signs out every existing session. Rotating `AUTH_SECRET` also signs everyone out. For a deployment, set both as server environment variables there; never commit them.

### How it works

- **Password:** stored only as a scrypt hash (`OWNER_PASSWORD_HASH`), checked in constant time. After 10 wrong passwords in 15 minutes, sign-in is refused until the window passes (`429`). The counter is global and in memory, so it resets on restart.
- **Session:** an [iron-session](https://github.com/vvo/iron-session) cookie (`cc_session`), encrypted and integrity-protected with `AUTH_SECRET`, `HttpOnly`, `SameSite=Lax`, valid for 8 hours. It is marked `Secure` on every host except localhost.
- **Enforcement:** every protected API route checks the session itself on the server (`requireOwner` in `src/lib/auth.ts`). `src/proxy.ts` also redirects signed-out page visits to `/login` (keeping the original URL as `?next=`) and returns `401` for signed-out `/api` calls. Hiding UI is never relied on.
- **Fails closed:** if `AUTH_SECRET` or `OWNER_PASSWORD_HASH` is missing or invalid, protected routes return `503` and nobody can sign in.
- **CSRF:** login and logout use the same cross-site guards as the other endpoints, so another site cannot sign the browser in or out.

### Public endpoints (no browser session)

| Endpoint | Caller | Protection |
|---|---|---|
| `POST /api/paypal/webhook` | PayPal servers | PayPal signature verification; order and amount re-verified with PayPal (unchanged) |
| `GET /api/paypal/return` | Payer's browser | Capture verified server-side with PayPal; the query string only identifies the order |
| `GET /api/paypal/cancel` | Payer's browser | Redirect only; no state change |
| `POST /api/auth/login`, `POST /api/auth/logout` | Owner's browser | Cross-site and content-type guards, throttling |
| `GET /api/auth/status` | Login page | Read-only; returns only `configured` and `signedIn` booleans, never secrets or which setting is wrong |

After a PayPal return, a signed-out visitor is sent to `/login` and returned to the payment result after signing in.

---

## AI Invoice Generator

On **/create-invoice**, describe the work (e.g. *"12 hours of UX research for Acme at $85/hr, due in 30 days"*) and click **Generate with AI**.

1. The browser sends the text (max 2,000 characters), the **currently selected client id**, and any dates you typed into the form to `POST /api/ai/invoice-draft`. The server checks that the selected client exists in MySQL.
2. **Missing details are asked about, not invented.** A deterministic check runs first: an hourly rate with work described in days, weeks, or months but no hours (e.g. *"three days of frontend development at $20 per hour"*) returns a clarification question without calling Gemini. ClearCollect never assumes 8 hours per day. Gemini is told never to guess:
   - **Missing quantity or rate:** Gemini leaves that value `null` and gives the item's unit. The server turns each missing value into one explicit question with a stable id, naming the item, field, unit, and currency, e.g. *"Frontend: 3 hours at what hourly rate (USD/hour)?"*.
   - **Answers:** the page shows one answer box per question and sends each answer with its question id, so order never matters. The server applies the answers itself, with no second Gemini call.
   - **What an answer must contain:** exactly one exact, positive number. An answer with several numbers (e.g. "6 dollars, 3 dollars, 2" in one box), an approximate value ("about 6", "5-6", "?"), another item's name, a different time unit ("per day" for an hourly rate), or a currency other than the invoice's is sent back with the reason. Answers that were accepted are kept.
   - **Bare numbers** use the unit and currency named in the question. If no currency was stated anywhere, the app default (USD) is used and labelled as such.
   - **Other missing information** (e.g. what work was done) is asked as a general question. The answers are added to the request as explicit *Question / Answer* pairs and the draft is regenerated.
3. Gemini (`gemini-3.5-flash-lite`, structured JSON) receives only the request and today's date. It returns line items, the client name *as written in the request*, and only the currency, dates, and payment terms the request states. It never returns a client id.
4. The response is strictly validated in `src/lib/invoice-draft.ts`:
   - Status, payment, amount, total, or client-id fields are rejected.
   - **Client:** resolved server-side against MySQL records. If the request names no client, the selected client is kept. A name matching exactly one client uses that client and shows a notice if it differs from the selection. An unknown or ambiguous name clears the client and asks you to choose; a client is never guessed or created.
   - **Numbers:** line amounts and the total are recomputed in integer cents. Any quantity or rate that does not appear in your request (other than a quantity of 1 for a fixed price) is flagged. Every AI draft shows a **Review before saving** panel listing each line's quantity, unit, rate, and amount, the currency, and the total. Values not stated in your request are called out there. **Save Draft** stays blocked until you tick the review confirmation, and editing a quantity, rate, or the currency clears the tick.
   - **Dates:** dates stated in the request win, then dates you typed in the form, then app defaults (today; due 14 days after the issue date). Each date is labelled with its source, and the default due date is labelled *"App default … not from your request"*. A due date that is not after the issue date produces a question instead of being replaced.
   - The result must pass the same rules as `POST /api/invoices`.
5. The form is filled in for review. You can edit everything; **nothing is saved** until you click **Save Draft**, which creates a `DRAFT` invoice through the normal invoice API. The AI cannot set `PAID` or touch PayPal.

The **Reminder preview** card on this page is sample wording only, and no email is sent from it. Real reminders go through **/follow-ups**: draft with AI, approve, then the reminder is handed to Zapier for Gmail delivery.

**Setup:** create a key at [Google AI Studio](https://aistudio.google.com/) → **Get API key**, add it to `.env` as `GEMINI_API_KEY`, and restart the server. Without it the endpoint returns `503` and the form still works manually. Free-tier rate limits apply; a `429` response means the quota is exhausted for now.

### Invoice numbers

Leave **Invoice Number** blank and the server assigns the next number in `INV-YYYY-NNN` format (year of the issue date, e.g. `INV-2026-007`); the assigned number is shown after saving. If two invoices are saved at the same moment and pick the same number, the database's unique constraint rejects one and it is safely retried with the next number — existing invoices are never changed. You can still type a custom invoice number; if it is already in use, the save is rejected with "An invoice with this number already exists".

---

## AI Follow-up Reminders

**/follow-ups** lists unpaid invoices from MySQL that are overdue or due within 7 days (status `SENT`/`OVERDUE`, no recorded payment).

1. Click **Review Reminder** to open the editor (pre-filled with a plain template), then **Draft with AI** to have Gemini write a personalized reminder.
2. Gemini writes only the wording. It must use the placeholders `{{invoice_number}}`, `{{amount}}` and `{{due_date}}`, which the server fills from the database (amount includes the currency code, e.g. `USD 1,830.00`). Drafts missing a placeholder or mentioning a different invoice number are rejected.
3. Edit the subject and message as needed, then click **Approve & Send**.
4. The server re-checks that the invoice exists and is still unpaid (`PAID` invoices or invoices with a PayPal capture are refused with `409`), requires a valid client email (otherwise `422`, nothing sent), validates the text, and forwards it to Zapier.

**Delivery status shown in the app**

| Situation | Result |
|---|---|
| `ZAPIER_WEBHOOK_URL` and `ZAPIER_WEBHOOK_SECRET` unset | **Demo mode** — nothing is sent, and the app says so |
| Only one set, non-https URL, or secret under 16 characters | **Misconfigured** — sending is refused (`503`) |
| Zapier returns 2xx | "Accepted by Zapier" — your Zap then sends the email/Slack message |
| Zapier error, timeout, or unreachable | Error shown; the reminder was **not** sent |

ClearCollect only confirms that Zapier **received** the reminder. Whether the email or Slack message was delivered is visible in your Zap's history.

### Zapier setup

1. In Zapier, create a Zap with the trigger **Webhooks by Zapier → Catch Hook**. Copy the webhook URL.
2. Generate a secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
3. Add both to `.env` as `ZAPIER_WEBHOOK_URL` and `ZAPIER_WEBHOOK_SECRET` and restart the server.
4. Send one reminder from **/follow-ups** so Zapier can capture a sample, then add a **Filter** step: only continue if **Auth Token** (`auth_token`) *exactly matches* your secret. This is what authenticates requests to your Zap.
5. Add an action, for example **Gmail → Send Email** mapped as below, or **Slack → Send Channel Message**.

   | Gmail field | Payload field |
   |---|---|
   | To | `recipient_email` |
   | Subject | `subject` |
   | Body | `message` (already contains the invoice number, amount and due date) |

   `invoice_number` and `amount` are also available separately if you want them in the subject or a footer.
6. Turn the Zap on.

Payload fields: `event` (`invoice.reminder.approved`), `auth_token`, `approved_at`, `invoice_id`, `invoice_number`, `amount`, `currency`, `due_date`, `days_overdue`, `status`, `client_name`, `client_company`, `client_email`, `recipient_email` (same as `client_email`), `subject`, `message`. The secret is also sent as the `X-ClearCollect-Token` header (useful with **Catch Raw Hook**). The URL and secret are server-only and never sent to the browser.

### Testing the reminder flow with disposable data (development only)

To exercise the real Follow-ups → Zapier → Gmail flow without touching real invoices or clients:

```bash
npm run test-data:reminder -- --email you@your-own-domain.com   # create test client + SENT test invoice
npm run test-data:reminder -- --email you@your-own-domain.com --use-existing-client   # opt-in: test invoice for the existing client with that email (client not modified)
npm run test-data:reminder -- --cleanup                        # remove them afterwards
```

The script (`scripts/create-reminder-test-data.ts`) refuses `NODE_ENV=production` and non-local databases, rejects any email that belongs to an existing client, creates a client named "ClearCollect Reminder Test (TEST ONLY)" and a USD 1.00 invoice `INV-TEST-REMINDER-…` due in 3 days, then confirms it passes the production eligibility checks. It sends nothing; draft and approve the reminder on **/follow-ups**. Cleanup removes only invoices with both the `INV-TEST-REMINDER-` prefix and a "TEST ONLY" description (never paid ones), and only ever deletes the dedicated test client — never an existing client.

---

## Database Setup (MySQL + Prisma)

1. Create an empty database, e.g. `CREATE DATABASE clearcollect;`
2. Apply the migrations and generate the Prisma Client:

   ```bash
   npx prisma migrate deploy   # apply existing migrations
   npx prisma generate         # generates the client into src/generated/prisma
   ```

   For local schema development use `npx prisma migrate dev` instead.

**Schema overview** (`prisma/schema.prisma`):

| Model | Key fields |
|---|---|
| `Client` | `name`, `email?`, `company?` |
| `Invoice` | `invoiceNumber` (unique), `clientId`, `description`, `amount` (Decimal 10,2), `currency` (3-letter), `issueDate`, `dueDate`, `status`, `paypalOrderId?` (unique), `paypalCaptureId?` (unique) |
| `InvoiceStatus` | `DRAFT`, `SENT`, `PAID`, `OVERDUE`, `CANCELLED` |

Migrations: `init_client_invoice`, `add_paypal_payment_tracking`. Prisma CLI configuration lives in `prisma.config.ts`; the client singleton is in `src/lib/prisma.ts`.

---

## Running Locally

```bash
npm run dev
```

Open http://localhost:3000.

| Script | Command | Description |
|---|---|---|
| Development server | `npm run dev` | Next.js dev server |
| Production build | `npm run build` | Build for production |
| Production server | `npm run start` | Serve the production build |
| Lint | `npm run lint` | ESLint |
| Type check | `npx tsc --noEmit` | TypeScript check |
| Tests | `npm test` | Auth, PayPal webhook/capture, AI draft, and follow-up tests (see [Tests](#tests)) |
| Auth setup | `npm run auth:setup` | Generate `AUTH_SECRET` and `OWNER_PASSWORD_HASH` (see [Authentication](#authentication-single-owner-demo)) |

---

## PayPal Sandbox Checkout

### Flow

1. On **/invoices**, the user clicks **Pay with PayPal** on a `SENT` or `OVERDUE` invoice.
2. The browser calls `POST /api/invoices/[id]/paypal-order`. The server loads the invoice from MySQL and creates a PayPal order (intent `CAPTURE`) using the **invoice's stored amount and currency** — any request body is ignored. The order ID is saved to `paypalOrderId`.
3. The browser is redirected to PayPal's approval page.
4. **Approve:** PayPal redirects to `GET /api/paypal/return?token=<orderId>`. The server fetches the order, captures it, verifies the result, and marks the invoice `PAID`, then redirects to `/invoices?payment=paid`.
5. **Cancel:** PayPal redirects to `GET /api/paypal/cancel`, which changes nothing and redirects to `/invoices?payment=cancelled`.

### Safeguards

- Amount and currency always come from the database, never the browser.
- Before and after capture the server verifies: order ID matches the invoice's `paypalOrderId`, intent is `CAPTURE`, a single purchase unit whose `referenceId`/`customId` equal the invoice ID, and amount/currency match the invoice exactly.
- An invoice is set to `PAID` only when a capture has status `COMPLETED`; `PENDING` captures leave the invoice unpaid.
- Duplicate prevention: an existing unapproved order is reused; `PayPal-Request-Id` headers make order creation and capture idempotent; the `PAID` update is conditional (still unpaid, same order, no capture recorded); `paypalCaptureId` is unique.
- Ordinary invoice APIs cannot set `PAID`, and a `PAID` invoice cannot be edited or deleted. Changing an invoice's amount or currency detaches any pending PayPal order.

### Testing in Sandbox

1. Configure `.env` with Sandbox credentials and run `npm run dev`.
2. Create (or pick) an invoice with status `SENT` and a future due date.
3. Click **Pay with PayPal**, log in with your Sandbox **personal** account, and approve.
4. You are returned to `/invoices` with a success banner and the invoice shows **Paid**. Reloading the return URL does not capture again.
5. Repeat with another invoice and click **Cancel and return** on PayPal — the invoice stays unpaid.

Captured payments can be checked in the Sandbox business account at [sandbox.paypal.com](https://www.sandbox.paypal.com/).

### Webhooks

`POST /api/paypal/webhook` confirms payments even if the payer never returns to the app (e.g. closes the tab after approving).

**How it works**

1. Every delivery is verified with PayPal's [verify-webhook-signature](https://developer.paypal.com/docs/api/webhooks/v1/#verify-webhook-signature_post) API using `PAYPAL_WEBHOOK_ID`. Missing headers, malformed bodies, or failed verification → `401`.
2. The event is used only to find the order ID. The order is re-fetched from PayPal and goes through the same verification as the return flow before the invoice is marked `PAID`.
3. Handled events:
   - `CHECKOUT.ORDER.APPROVED` → captures the order server-side, then verifies.
   - `PAYMENT.CAPTURE.COMPLETED` → verifies the completed capture (including captures that were previously `PENDING`).
   - `PAYMENT.CAPTURE.PENDING` / `DENIED` / `REFUNDED` / `REVERSED` → logged only; no invoice change.
   - Any other event type → acknowledged and ignored.
4. Duplicate deliveries are safe: an already-paid order is acknowledged without changes.
5. Responses: `200` for processed or intentionally ignored events (including unknown orders and mismatches, which are logged), `5xx` for transient failures so PayPal retries.

**PayPal Dashboard setup (Sandbox)**

1. Expose your app publicly (PayPal cannot reach `localhost`), e.g. with a tunnel such as ngrok, or deploy it.
2. Go to [developer.paypal.com](https://developer.paypal.com/) → **Apps & Credentials** → **Sandbox** → your app → **Add Webhook**.
3. Webhook URL: `https://<public-host>/api/paypal/webhook`.
4. Subscribe to `CHECKOUT.ORDER.APPROVED` and `PAYMENT.CAPTURE.COMPLETED` (optionally `PAYMENT.CAPTURE.PENDING`, `DENIED`, `REFUNDED`, `REVERSED` for logging).
5. Copy the **Webhook ID** into `.env` as `PAYPAL_WEBHOOK_ID` and restart the server.
6. Make a Sandbox payment through the public URL and confirm the delivery shows `200` under the app's webhook events.

> The Dashboard's **Webhooks simulator** sends events that do not pass signature verification for your webhook, so they are rejected with `401`. Use real Sandbox payments to test.

### Tests

```bash
npm test
```

Uses Node's built-in test runner (no extra dependencies) against the **real MySQL database and PayPal Sandbox** — nothing is mocked. Covers: unsigned/forged/malformed webhook requests rejected with no invoice changes, oversized payloads, duplicate deliveries, re-processing an already-paid order, unapproved orders not being captured, and unknown orders.

AI invoice draft tests (`tests/invoice-draft.test.ts`) make **no Gemini calls**: the model call is replaced with a mock. They make **no database writes**; route tests read existing clients and check that invoice and client counts are unchanged. They cover:
- strict draft validation, recomputed totals, and rejected status/payment/client-id fields;
- clarification for ambiguous day-based hourly work (never 8 h/day), and flagging of numbers the user never stated;
- preservation of explicit quantities, rates, currency, and dates;
- transparent date defaults, and selected/unknown/ambiguous client resolution;
- the endpoint's input, missing-key, and unknown-client guards.

`tests/ui-guards.test.ts` checks that the Create Invoice reminder card is preview-only and cannot claim delivery. It also checks the login page's first-time setup copy, that no registration endpoint exists, and that `GET /api/auth/status` leaks no secrets and fails closed.

Follow-up reminder tests (`tests/follow-up.test.ts`) make **no Gemini or Zapier calls** (Zapier is replaced with a fake `fetch`). They cover input validation, paid/draft/cancelled invoice rejection, placeholder filling, missing or invalid Zapier configuration, Zapier errors and timeouts, and the success path. Route tests read existing PAID invoices but never write.

Authentication tests (`tests/auth.test.ts`) use throwaway test credentials set inside the test process, so they never read or reveal the real `AUTH_SECRET`/`OWNER_PASSWORD_HASH`. They check that every protected route returns `401` without a session, and also with forged, foreign-secret, expired, or pre-password-change cookies. They check `503` when auth is not configured, and that a signed-in owner can still list, create (one test client, deleted afterwards), look up, pay, and draft. They also cover login cookie attributes, wrong-password and cross-site login, throttling, logout, the proxy redirects, the open-redirect guard, and that PayPal webhook/return/cancel work without a session.

- Requires `.env` with `DATABASE_URL` and PayPal Sandbox credentials. If `PAYPAL_WEBHOOK_ID` is unset, a placeholder ID is used (PayPal rejects it, as the invalid-signature tests expect).
- If a `SENT`/`OVERDUE` invoice exists, setup creates (or reuses) a Sandbox order for it and stores its `paypalOrderId`. Tests never mark invoices `PAID`. Tests needing such data are skipped when it is absent.

---

## API Reference

| Method & Path | Description |
|---|---|
| `GET /api/clients` | List clients with invoice counts |
| `POST /api/clients` | Create a client |
| `GET /api/invoices` | List invoices (`?status=`, `?clientId=`, `?page=`, `?limit=` ≤ 100) |
| `POST /api/invoices` | Create an invoice (status `DRAFT` or `SENT` only; omit `invoiceNumber` to auto-assign `INV-YYYY-NNN`) |
| `GET /api/invoices/[id]` | Get one invoice |
| `PATCH /api/invoices/[id]` | Update description, amount, currency, due date, or status (not `PAID`) |
| `DELETE /api/invoices/[id]` | Delete a `DRAFT` or `CANCELLED` invoice |
| `POST /api/invoices/[id]/paypal-order` | Create/reuse a PayPal order; returns `{ approveUrl, orderId }` |
| `GET /api/paypal/return` | PayPal approval return: capture + verify + mark `PAID` |
| `GET /api/paypal/cancel` | PayPal cancel return: no state change |
| `POST /api/ai/invoice-draft` | `{ request, selectedClientId?, issueDate?, dueDate? }` → `{ kind: "draft", … }` for review or `{ kind: "clarification", questions }`; never saves |
| `POST /api/follow-ups/draft` | Gemini reminder draft for an unpaid invoice: `{ invoiceId }` → `{ subject, message }` |
| `POST /api/follow-ups/send` | Deliver an approved reminder `{ invoiceId, subject, message }` to Zapier (or demo mode) |
| `GET /api/follow-ups/status` | Delivery mode: `zapier`, `demo` or `misconfigured` (no secrets) |
| `POST /api/paypal/webhook` | Signature-verified PayPal webhook: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED` |

Every route above requires the owner session except `/api/paypal/webhook`, `/api/paypal/return`, and `/api/paypal/cancel`. Auth routes: `POST /api/auth/login` (`{ password }` → session cookie), `POST /api/auth/logout`, and the public `GET /api/auth/status` (`{ configured, signedIn }`). Without a session, protected routes return `401`; if auth is not configured, they return `503`.

Input validation lives in `src/lib/validation.ts`.

---

## Project Structure

```
clearcollect/
├── prisma/
│   ├── schema.prisma               # Client, Invoice, InvoiceStatus
│   └── migrations/                 # init_client_invoice, add_paypal_payment_tracking
├── prisma.config.ts                # Prisma CLI config (loads .env)
├── src/
│   ├── app/
│   │   ├── layout.tsx              # Root layout with AppShell navigation
│   │   ├── page.tsx                # / — Dashboard (MySQL data)
│   │   ├── invoices/page.tsx       # /invoices — list, filters, Pay with PayPal
│   │   ├── create-invoice/page.tsx # /create-invoice — AI draft + review, saves to MySQL
│   │   ├── clients/page.tsx        # /clients — client grid, add client
│   │   ├── follow-ups/page.tsx     # /follow-ups — AI reminders for unpaid invoices
│   │   ├── settings/page.tsx       # /settings — UI only (planned)
│   │   ├── login/page.tsx          # /login — owner sign-in
│   │   └── api/
│   │       ├── auth/{login,logout}/route.ts
│   │       ├── clients/route.ts
│   │       ├── invoices/route.ts
│   │       ├── invoices/[id]/route.ts
│   │       ├── invoices/[id]/paypal-order/route.ts
│   │       └── paypal/{return,cancel,webhook}/route.ts
│   ├── proxy.ts                    # Redirects signed-out visitors to /login
│   ├── components/AppShell.tsx
│   ├── lib/
│   │   ├── auth.ts                 # Single-owner password + session checks
│   │   ├── prisma.ts               # Prisma Client singleton
│   │   ├── paypal.ts               # PayPal order creation, capture, verification
│   │   └── validation.ts           # Request validation
│   └── generated/prisma/           # Generated Prisma Client (git-ignored)
└── package.json
```

---

## Current Limitations

| Limitation | Detail |
|---|---|
| **Webhooks need a public URL** | PayPal cannot deliver to `localhost`; without a registered webhook, payment is confirmed only when the payer returns to the app. |
| **Signed webhook paths not auto-tested** | Only PayPal can produce valid signatures, so verified-event handling (ignored types, duplicate signed deliveries, PAID via webhook) must be tested with real Sandbox deliveries. |
| **No webhook event log** | Idempotency relies on invoice state; individual webhook event IDs are not stored. |
| **Refunds/reversals not reflected** | `PAYMENT.CAPTURE.REFUNDED`/`REVERSED` webhooks are logged but do not change invoice status. |
| **Sandbox only** | Tested against PayPal Sandbox; live use requires production credentials, webhooks, and review. |
| **Single-owner only (not multi-tenant)** | One password unlocks all data. There are no user accounts, roles, or per-business isolation, so do not present it as supporting multiple businesses. Sessions are stateless cookies: signing out clears the cookie, but a copied cookie stays valid until it expires (8 h) or the password or `AUTH_SECRET` is changed. |
| **Reminder delivery needs Zapier** | Without a configured Zap, reminders run in demo mode. ClearCollect confirms Zapier received a reminder, not that the email/Slack message was delivered. Sent reminders are not stored, so the app does not track reminder history. AI drafts depend on Gemini free-tier limits and should always be reviewed. |
| **Email only via Follow-ups** | Reminders are sent only from **/follow-ups** (approved, then handed to Zapier → Gmail). The Create Invoice reminder card is a preview, and **Send Invoice (Demo)** does not send invoices. |
| **AI clarification heuristics** | The "days + hourly rate" check and the "number not stated in your request" flag match common phrasings (digits, separators, `2k`, number words up to twenty, tens). Unusual wording may be flagged for confirmation unnecessarily; it is never silently converted. |
| **Line items not stored separately** | Line items are editable in the form, but only the total and a combined description are saved. |
| **Settings not persisted** | Settings page is UI only. |
| **Currency support** | `INR` and some other currencies may be rejected depending on the PayPal merchant account. |

---

## Roadmap

### Milestone 1 — Frontend UI ✅ Complete

### Milestone 2 — Backend and Database ✅ Mostly complete

- ✅ MySQL + Prisma schema and migrations for `Client` and `Invoice`
- ✅ Route Handlers for clients and invoices with server-side validation
- ✅ Dashboard, invoices, clients, and create-invoice pages use real data
- 🔲 Planned: line items model, user authentication, persisted settings

### Milestone 3 — AI Integration 🟡 In progress

- ✅ Parse free-text descriptions into an editable invoice draft (Gemini)
- ✅ Gemini-drafted payment reminders for unpaid invoices; user reviews and edits before sending
- ✅ Delivery via Zapier webhook (email/Slack configured in Zapier)
- 🔲 Planned: reminder history and scheduled/automatic follow-ups

### Milestone 4 — PayPal Integration ✅ Sandbox checkout complete

- ✅ Server-side order creation, approval redirect, cancellation, verified capture → `PAID`
- ✅ Signature-verified webhooks for approved orders and completed captures
- 🔲 Planned: payment links in reminder emails, refund/reversal handling

### Milestone 5 — Polish and Deploy 🔲 Planned

- Automated tests, deployment, public demo environment

---

## License

This project is licensed under the **MIT License**. Copyright (c) 2026 Subarssini. See [LICENSE](./LICENSE).
