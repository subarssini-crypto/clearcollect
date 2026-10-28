import Link from "next/link";
import type { ReactNode } from "react";
import ThemeToggle from "@/components/ThemeToggle";

/** ClearCollect mark + wordmark, as in the owner app's top navigation. */
export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="flex items-center gap-2" aria-label="ClearCollect home">
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand">
        <svg className="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </span>
      <span className="text-[15px] font-bold tracking-tight text-navy">ClearCollect</span>
    </Link>
  );
}

/** Top bar for public and Customer Portal pages (no owner navigation). */
export default function PublicHeader({ children, logoHref = "/" }: { children?: ReactNode; logoHref?: string }) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Logo href={logoHref} />
        <div className="ml-auto flex items-center gap-2">
          {children}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
