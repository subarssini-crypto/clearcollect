import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import PublicHeader from "@/components/PublicHeader";

/** Centered card layout for Customer Portal sign-in, sign-up, and invite pages. */
export default function PortalAuthLayout({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <>
      <PublicHeader>
        <Link href="/" className="hidden rounded-lg px-3 py-1.5 text-[13px] font-semibold text-slate-500 hover:text-navy sm:inline">
          Home
        </Link>
      </PublicHeader>
      <div className="flex justify-center px-4 py-10 sm:py-16">
        <div className="card w-full max-w-sm p-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-brand">Customer Portal</p>
          <h1 className="mt-1 text-lg font-bold text-navy">{title}</h1>
          <p className="mb-5 mt-1 text-[13px] text-muted">{subtitle}</p>
          <Suspense fallback={<p className="text-[13px] text-muted">Loading…</p>}>{children}</Suspense>
        </div>
      </div>
      <p className="pb-8 text-center text-xs text-muted">
        Business owner?{" "}
        <Link href="/login" className="font-semibold text-brand hover:text-brand-ink">
          Owner login
        </Link>
      </p>
    </>
  );
}
