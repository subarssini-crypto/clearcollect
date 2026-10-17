# ClearCollect

**AI-assisted invoicing and payment follow-up for freelancers and small businesses.**

> Built for the [PayPal AI Hackathon](https://developer.paypal.com/). This repository currently contains **Milestone 1 — the frontend UI only**. No real AI calls, PayPal payments, or database storage are active yet.

---

## Table of Contents

- [Problem Statement](#problem-statement)
- [Current Features](#current-features)
- [Technology Stack](#technology-stack)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Running Locally](#running-locally)
- [Project Structure](#project-structure)
- [Current Limitations](#current-limitations)
- [Roadmap](#roadmap)
- [Environment Variables](#environment-variables)
- [License](#license)

---

## Problem Statement

Freelancers and small business owners spend significant time chasing unpaid invoices. Writing polite but firm follow-up emails is repetitive, awkward, and easy to forget. Late payments disrupt cash flow and strain client relationships.

**ClearCollect** solves this by combining a clean invoicing interface with an AI-powered follow-up assistant. The AI drafts contextually appropriate payment reminders based on the invoice details, client history, and how many days overdue the invoice is — so users can review, edit, and send with one click. PayPal integration provides a direct, trusted payment link inside each reminder.

---

## Current Features

> All data shown in the UI is **sample data for demonstration purposes only**. No real payments, emails, or AI calls are made in this milestone.

| Feature | Status | Description |
|---|---|---|
| **Dashboard** | ✅ Implemented | Summary cards (Total Invoiced, Paid, Pending, Overdue) and a recent invoices table |
| **Create Invoice** | ✅ Implemented | AI description input (UI only), editable invoice fields, line items with auto-calculated totals, and an AI Follow-up Assistant panel with an editable sample reminder |
| **Invoices List** | ✅ Implemented | Full invoice table with status filter tabs (All / Paid / Pending / Overdue / Draft) |
| **Client Management** | ✅ Implemented | Card-based client grid showing billing totals, invoice count, and quick-create invoice link |
| **Follow-up Assistant** | ✅ Implemented | Urgency-ranked follow-up cards with AI-drafted reminders that can be expanded and edited before sending |
| **Settings** | ✅ Implemented | Profile, invoice preferences (currency, payment terms, tax rate), notification toggles, and a PayPal integration placeholder |
| **Responsive Sidebar** | ✅ Implemented | Navy sidebar with active route highlighting, Follow-ups badge, and a mobile hamburger menu |

---

## Technology Stack

| Layer | Technology | Version |
|---|---|---|
| Framework | [Next.js](https://nextjs.org/) (App Router) | 16.4.2 |
| Language | TypeScript | ^5 |
| Styling | [Tailwind CSS](https://tailwindcss.com/) v4 | ^4 |
| UI Runtime | React | 19.3.0 |
| Linting | ESLint + eslint-config-next | ^9 / 16.4.2 |

**Planned additions (future milestones):**

- PostgreSQL + [Prisma](https://www.prisma.io/) — persistent data storage
- AI model API (e.g., Google Gemini or OpenAI) — invoice parsing and reminder drafting
- [PayPal Sandbox SDK](https://developer.paypal.com/sdk/js/) — payment links inside invoices

---

## Prerequisites

Before you begin, make sure you have the following installed:

- **Node.js** v18 or later — [nodejs.org](https://nodejs.org/)
- **npm** v9 or later (bundled with Node.js)
- **Git** — [git-scm.com](https://git-scm.com/)

To verify your versions:

```bash
node -v
npm -v
git --version
```

---

## Installation

1. **Clone the repository:**

   ```bash
   git clone https://github.com/subarssini-crypto/clearcollect.git
   cd clearcollect
   ```

2. **Install dependencies:**

   ```bash
   npm install
   ```

   > This installs Next.js, React, Tailwind CSS, TypeScript, and all dev tools listed in `package.json`. No database driver or AI SDK is installed yet — those come in later milestones.

---

## Running Locally

Start the development server:

```bash
npm run dev
```

Open your browser and navigate to:

```
http://localhost:3000
```

The app hot-reloads automatically whenever you save a file.

**Available scripts:**

| Script | Command | Description |
|---|---|---|
| Development server | `npm run dev` | Starts Next.js with Turbopack in watch mode |
| Production build | `npm run build` | Compiles and optimises the app for production |
| Production server | `npm run start` | Serves the production build (run `build` first) |
| Lint | `npm run lint` | Runs ESLint across the project |

---

## Project Structure

```
clearcollect/
├── src/
│   ├── app/                        # Next.js App Router — one folder = one route
│   │   ├── layout.tsx              # Root layout: imports Sidebar, wraps all pages
│   │   ├── page.tsx                # / — Dashboard (summary cards + recent invoices)
│   │   ├── globals.css             # Global styles and Tailwind v4 design tokens
│   │   ├── favicon.ico
│   │   ├── clients/
│   │   │   └── page.tsx            # /clients — Client card grid
│   │   ├── create-invoice/
│   │   │   └── page.tsx            # /create-invoice — Invoice form + AI follow-up panel
│   │   ├── follow-ups/
│   │   │   └── page.tsx            # /follow-ups — AI-drafted payment reminders
│   │   ├── invoices/
│   │   │   └── page.tsx            # /invoices — Full invoice list with filter tabs
│   │   └── settings/
│   │       └── page.tsx            # /settings — Profile, preferences, toggles
│   └── components/
│       └── Sidebar.tsx             # Navy sidebar with navigation and mobile support
├── public/                         # Static assets (served at /)
├── .gitignore
├── LICENSE
├── README.md
├── next.config.ts                  # Next.js configuration
├── tsconfig.json                   # TypeScript configuration
├── eslint.config.mjs               # ESLint configuration
└── package.json
```

> **Convention:** Every page is a React Server Component by default. Components that use browser APIs, event handlers, or React hooks are marked with `"use client"` at the top of the file.

---

## Current Limitations

The following features are **not yet implemented** in this milestone:

| Limitation | Detail |
|---|---|
| **Sample data only** | All invoices, clients, and figures in the UI are hardcoded demo values. No data is read from or written to a real database. |
| **No persistent storage** | There is no database connected. Creating, editing, or saving an invoice does nothing beyond a browser alert confirming demo mode. |
| **No real AI integration** | The AI invoice generator and AI follow-up assistant buttons are present in the UI but disabled or stubbed. No AI API calls are made. |
| **No PayPal integration** | The PayPal connect button in Settings is disabled. No payment links are generated. |
| **No authentication** | There is no login system. The user profile shown ("Jane Doe") is a hardcoded placeholder. |
| **No email sending** | The "Send Reminder" and "Send Invoice" buttons show a browser alert in demo mode. No emails are dispatched. |

---

## Roadmap

### Milestone 1 — Frontend UI ✅ Complete

- Professional responsive dashboard
- All six navigation pages with sample data
- AI Follow-up Assistant panel (UI only)
- Sidebar navigation with active states and mobile hamburger menu

### Milestone 2 — Backend and Database 🔲 Planned

- Set up PostgreSQL with Prisma ORM
- Define schema for `User`, `Client`, `Invoice`, and `LineItem`
- Build Next.js Route Handlers (API routes) for full CRUD operations
- Connect all UI forms to real API endpoints
- Add user authentication (e.g., NextAuth.js)

### Milestone 3 — AI Integration 🔲 Planned

- Integrate a large language model API for invoice parsing
- Accept free-text project descriptions and extract structured invoice fields automatically
- Generate contextual payment reminder emails based on invoice age, amount, and client history
- Allow users to review and edit AI output before sending

### Milestone 4 — PayPal Integration 🔲 Planned

- Connect PayPal Sandbox via the PayPal REST API
- Embed a direct PayPal payment link in each invoice and follow-up email
- Receive and process payment webhooks to update invoice status to "Paid" automatically
- Display payment confirmation in the dashboard

### Milestone 5 — Polish and Deploy 🔲 Planned

- End-to-end testing
- Performance optimisation
- Deploy to a hosting platform (e.g., Vercel)
- Public demo environment

---

## Environment Variables

No environment variables are required to run the current milestone locally.

When future milestones are implemented, create a `.env.local` file in the project root. **This file must never be committed to version control** — it is already covered by `.gitignore`.

Template for future reference:

```bash
# .env.local — DO NOT COMMIT THIS FILE

# Database (Milestone 2)
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/clearcollect"

# Authentication (Milestone 2)
NEXTAUTH_SECRET="your-secret-here"
NEXTAUTH_URL="http://localhost:3000"

# AI API (Milestone 3)
AI_API_KEY="your-ai-api-key-here"

# PayPal (Milestone 4)
PAYPAL_CLIENT_ID="your-paypal-client-id"
PAYPAL_CLIENT_SECRET="your-paypal-client-secret"
PAYPAL_MODE="sandbox"
```

> **Security note:** Never paste real API keys, database passwords, or PayPal credentials into source code, README files, or any file tracked by Git.

---

## License

This project is licensed under the **MIT License**.

Copyright (c) 2026 Subarssini

See the [LICENSE](./LICENSE) file for the full license text.
