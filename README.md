# ClearCollect

**AI-assisted invoicing and payment follow-up for freelancers and small businesses.**

> Built for the [PayPal AI Hackathon](https://developer.paypal.com/). ClearCollect now stores clients and invoices in **MySQL via Prisma** and accepts invoice payments through **PayPal Sandbox Checkout** (Orders v2, server-side). AI features, email sending, and authentication are still **planned**.

---

## Table of Contents

- [Problem Statement](#problem-statement)
- [Current Features](#current-features)
- [Technology Stack](#technology-stack)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Environment Variables](#environment-variables)
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
| **Create Invoice** | ✅ Implemented | Saves invoices to MySQL for an existing client (DRAFT or SENT). Line items are currently a fixed sample list combined into the invoice description |
| **Client Management** | ✅ Implemented | Client grid with totals from MySQL; add new clients |
| **PayPal Sandbox Checkout** | ✅ Implemented | Server-side order creation, approval redirect, cancellation, and verified server-side capture that marks the invoice **PAID** |
| **Follow-up Assistant** | 🔲 Planned (UI only) | Page uses sample demo data; no AI drafting or email sending |
| **AI invoice description** | 🔲 Planned (UI only) | Input and button are present but disabled |
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

Create a `.env` file in the project root (used by both Next.js and the Prisma CLI). `.env*` files are ignored by Git — **never commit them**.

```bash
# .env — DO NOT COMMIT

# MySQL connection string
DATABASE_URL="mysql://USER:PASSWORD@localhost:3306/clearcollect"

# PayPal Sandbox REST app credentials (Developer Dashboard → Apps & Credentials → Sandbox)
PAYPAL_CLIENT_ID="your-sandbox-client-id"
PAYPAL_CLIENT_SECRET="your-sandbox-client-secret"

# Selects the PayPal environment. Any URL containing "sandbox" (or leaving it unset) uses Sandbox.
PAYPAL_BASE_URL="https://api-m.sandbox.paypal.com"

# Optional: public base URL used for PayPal return/cancel links.
# Defaults to the origin of the incoming request (e.g. http://localhost:3000).
# APP_URL="http://localhost:3000"

# Webhook ID from Developer Dashboard → your Sandbox app → Webhooks (required for /api/paypal/webhook)
PAYPAL_WEBHOOK_ID="your-sandbox-webhook-id"
```

PayPal credentials are used **only on the server** (`src/lib/paypal.ts`). No PayPal key is exposed to the browser.

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
| Tests | `npm test` | PayPal webhook/capture tests (see [Tests](#tests)) |

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

- Requires `.env` with `DATABASE_URL` and PayPal Sandbox credentials. If `PAYPAL_WEBHOOK_ID` is unset, a placeholder ID is used (PayPal rejects it, as the invalid-signature tests expect).
- If a `SENT`/`OVERDUE` invoice exists, setup creates (or reuses) a Sandbox order for it and stores its `paypalOrderId`. Tests never mark invoices `PAID`. Tests needing such data are skipped when it is absent.

---

## API Reference

| Method & Path | Description |
|---|---|
| `GET /api/clients` | List clients with invoice counts |
| `POST /api/clients` | Create a client |
| `GET /api/invoices` | List invoices (`?status=`, `?clientId=`, `?page=`, `?limit=` ≤ 100) |
| `POST /api/invoices` | Create an invoice (status `DRAFT` or `SENT` only) |
| `GET /api/invoices/[id]` | Get one invoice |
| `PATCH /api/invoices/[id]` | Update description, amount, currency, due date, or status (not `PAID`) |
| `DELETE /api/invoices/[id]` | Delete a `DRAFT` or `CANCELLED` invoice |
| `POST /api/invoices/[id]/paypal-order` | Create/reuse a PayPal order; returns `{ approveUrl, orderId }` |
| `GET /api/paypal/return` | PayPal approval return: capture + verify + mark `PAID` |
| `GET /api/paypal/cancel` | PayPal cancel return: no state change |
| `POST /api/paypal/webhook` | Signature-verified PayPal webhook: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED` |

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
│   │   ├── layout.tsx              # Root layout with Sidebar
│   │   ├── page.tsx                # / — Dashboard (MySQL data)
│   │   ├── invoices/page.tsx       # /invoices — list, filters, Pay with PayPal
│   │   ├── create-invoice/page.tsx # /create-invoice — saves to MySQL
│   │   ├── clients/page.tsx        # /clients — client grid, add client
│   │   ├── follow-ups/page.tsx     # /follow-ups — sample data (planned)
│   │   ├── settings/page.tsx       # /settings — UI only (planned)
│   │   └── api/
│   │       ├── clients/route.ts
│   │       ├── invoices/route.ts
│   │       ├── invoices/[id]/route.ts
│   │       ├── invoices/[id]/paypal-order/route.ts
│   │       └── paypal/{return,cancel,webhook}/route.ts
│   ├── components/Sidebar.tsx
│   ├── lib/
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
| **No authentication** | Anyone with access to the app can view and manage all data. |
| **No real AI integration** | AI description and follow-up drafting are UI placeholders. |
| **No email sending** | Send buttons are demo-only. |
| **Line items not stored** | Create Invoice uses a fixed sample line-item list; only the total and a combined description are saved. |
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

### Milestone 3 — AI Integration 🔲 Planned

- Parse free-text descriptions into invoice fields
- Draft contextual payment reminders; user reviews before sending
- Email delivery

### Milestone 4 — PayPal Integration ✅ Sandbox checkout complete

- ✅ Server-side order creation, approval redirect, cancellation, verified capture → `PAID`
- ✅ Signature-verified webhooks for approved orders and completed captures
- 🔲 Planned: payment links in reminder emails, refund/reversal handling

### Milestone 5 — Polish and Deploy 🔲 Planned

- Automated tests, deployment, public demo environment

---

## License

This project is licensed under the **MIT License**. Copyright (c) 2026 Subarssini. See [LICENSE](./LICENSE).
