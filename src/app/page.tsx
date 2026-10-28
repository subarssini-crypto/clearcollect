import Link from "next/link";
import type { Metadata } from "next";
import PublicHeader from "@/components/PublicHeader";
import PayLinkForm from "@/components/PayLinkForm";
import { btnPrimary, btnSecondary } from "@/components/ui";

// Public landing page. Static content only: it reads no session and no data.
export const metadata: Metadata = {
  title: "ClearCollect — From invoice created to payment confirmed",
  description:
    "AI-assisted invoicing with secure PayPal payments, verified transaction tracking, and AI follow-ups for freelancers and small businesses.",
};

const FEATURES = [
  {
    title: "AI invoice creation",
    body: "Describe the work in plain words and review an AI-drafted invoice with line items, rates, and totals before it is saved.",
    icon: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z",
  },
  {
    title: "PayPal payments",
    body: "Clients pay through PayPal from a secure link. Amounts come from the saved invoice and every capture is verified on the server.",
    icon: "M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z",
  },
  {
    title: "Transaction tracking",
    body: "Only verified PayPal captures mark an invoice as paid, so your transaction history reflects money that actually arrived.",
    icon: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z",
  },
  {
    title: "AI follow-ups",
    body: "Draft polite payment reminders for unpaid invoices, review them, and approve each one before it is sent.",
    icon: "M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z",
  },
];

function Icon({ d }: { d: string }) {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  );
}

export default function LandingPage() {
  return (
    <>
      <PublicHeader>
        <nav aria-label="Account" className="hidden items-center gap-1 sm:flex">
          <Link href="/portal/login" className="rounded-lg px-3 py-1.5 text-[13px] font-semibold text-slate-500 hover:text-navy">
            Customer Portal
          </Link>
          <Link href="/login" className="rounded-lg px-3 py-1.5 text-[13px] font-semibold text-slate-500 hover:text-navy">
            Owner login
          </Link>
        </nav>
      </PublicHeader>

      <div className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6">
        {/* Hero */}
        <section aria-labelledby="hero-title" className="py-12 text-center sm:py-16">
          <p className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-ink">
            Invoicing · PayPal · Follow-ups
          </p>
          <h1 id="hero-title" className="mx-auto max-w-3xl text-3xl font-bold tracking-tight text-navy sm:text-5xl">
            From invoice created to payment confirmed.
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-[15px] leading-relaxed text-muted">
            ClearCollect helps freelancers and small businesses create invoices with AI, get paid securely through PayPal,
            and keep an honest record of every verified payment.
          </p>

          <div className="mx-auto mt-8 grid max-w-3xl gap-3 sm:grid-cols-3">
            <Link id="cta-owner-login" href="/login" className={`${btnPrimary} py-3`}>
              Business Owner Login
            </Link>
            <Link id="cta-customer-portal" href="/portal/login" className={`${btnSecondary} py-3`}>
              Customer Portal
            </Link>
            <a id="cta-pay-invoice" href="#pay-an-invoice" className={`${btnSecondary} py-3`}>
              Pay an Invoice
            </a>
          </div>
        </section>

        {/* Features */}
        <section aria-labelledby="features-title">
          <h2 id="features-title" className="sr-only">
            Features
          </h2>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((feature) => (
              <li key={feature.title} className="card p-5">
                <span className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50 text-brand">
                  <Icon d={feature.icon} />
                </span>
                <h3 className="text-sm font-bold text-navy">{feature.title}</h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{feature.body}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* Who is this for */}
        <section aria-label="Sign in options" className="mt-12 grid gap-4 md:grid-cols-2">
          <div className="card p-6">
            <h2 className="text-base font-bold text-navy">Running the business?</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
              Sign in with your owner password to create invoices, manage clients, send follow-ups, and track payments.
            </p>
            <Link href="/login" className={`${btnPrimary} mt-4`}>
              Business Owner Login
            </Link>
          </div>
          <div className="card p-6">
            <h2 className="text-base font-bold text-navy">Received an invoice?</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
              The Customer Portal shows all of your invoices and payments in one place. Create an account with the invite
              link your provider sends you, or sign in if you already have one.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href="/portal/login" className={btnPrimary}>
                Sign in to the portal
              </Link>
              <Link href="/portal/signup" className={btnSecondary}>
                Create an account
              </Link>
            </div>
          </div>
        </section>

        {/* Pay an invoice */}
        <section id="pay-an-invoice" aria-labelledby="pay-title" className="card mt-4 scroll-mt-20 p-6">
          <h2 id="pay-title" className="text-base font-bold text-navy">
            Pay an invoice without an account
          </h2>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-[13px] leading-relaxed text-muted">
            <li>Open the invoice email you received from your provider.</li>
            <li>Select its secure payment link (it looks like …/pay/ followed by a long code).</li>
            <li>Check the invoice details and pay with PayPal. You never need an invoice number or password.</li>
          </ol>
          <p className="mt-3 text-xs text-muted">
            For your security, invoices can only be opened with the secure link from your email, never with an invoice
            number alone. If you cannot find the link, contact the business that sent the invoice.
          </p>
          <div className="mt-4 max-w-2xl">
            <PayLinkForm />
          </div>
        </section>
      </div>

      <footer className="border-t border-line py-6 text-center text-xs text-muted">
        ClearCollect · Payments processed by PayPal
      </footer>
    </>
  );
}
