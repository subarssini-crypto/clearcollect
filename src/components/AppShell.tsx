"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import ThemeToggle from "@/components/ThemeToggle";

/** sidebarOnly: shown in the icon rail and mobile menu, not the top navigation bar. */
type NavItem = { href: string; label: string; icon: string[]; sidebarOnly?: boolean };

// Heroicons-style outline paths (same icons as the previous sidebar).
const ICONS = {
  dashboard: ["M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"],
  create: ["M12 4v16m8-8H4"],
  transactions: ["M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"],
  invoices: ["M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"],
  clients: ["M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"],
  followUps: ["M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"],
  signOut: ["M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"],
  settings: [
    "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z",
    "M15 12a3 3 0 11-6 0 3 3 0 016 0z",
  ],
};

const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: ICONS.dashboard },
  { href: "/invoices", label: "Invoices", icon: ICONS.invoices },
  { href: "/transactions", label: "Transactions", icon: ICONS.transactions, sidebarOnly: true },
  { href: "/create-invoice", label: "Create Invoice", icon: ICONS.create },
  { href: "/clients", label: "Clients", icon: ICONS.clients },
  { href: "/follow-ups", label: "Follow-ups", icon: ICONS.followUps },
  { href: "/settings", label: "Settings", icon: ICONS.settings },
];

function Icon({ paths, className = "h-[18px] w-[18px]" }: { paths: string[]; className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
      {paths.map((d) => (
        <path key={d} strokeLinecap="round" strokeLinejoin="round" d={d} />
      ))}
    </svg>
  );
}

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

const railTooltip =
  "pointer-events-none absolute left-full z-50 ml-2.5 whitespace-nowrap rounded-md bg-navy px-2 py-1 text-[11px] font-medium text-surface opacity-0 shadow transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100";

// Collapsed: a 36px square centred in the 56px rail. Expanded: full width
// with the icon at the same x-position (10px rail padding + 9px), so icons
// do not jump when the rail opens.
const railItem = (expanded: boolean) =>
  `group relative flex h-9 items-center rounded-lg transition-colors ${expanded ? "w-full gap-3 px-[9px]" : "w-9 justify-center"}`;

function RailLink({ item, pathname, expanded }: { item: NavItem; pathname: string; expanded: boolean }) {
  const active = isActive(pathname, item.href);
  return (
    <Link
      href={item.href}
      // Collapsed: the label is only a tooltip, so name the link explicitly.
      title={expanded ? undefined : item.label}
      aria-label={expanded ? undefined : item.label}
      aria-current={active ? "page" : undefined}
      className={`${railItem(expanded)} ${active ? "bg-brand-50 text-brand" : "text-slate-400 hover:bg-canvas hover:text-navy"}`}
    >
      <Icon paths={item.icon} className="h-[18px] w-[18px] flex-shrink-0" />
      {expanded ? (
        <span className="truncate whitespace-nowrap text-[13px] font-semibold">{item.label}</span>
      ) : (
        <span className={railTooltip}>{item.label}</span>
      )}
    </Link>
  );
}

/** Top-of-rail button: double chevron pointing the way the rail will move. */
function RailToggle({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  const label = expanded ? "Collapse sidebar" : "Expand sidebar";
  return (
    <button
      type="button"
      id="sidebar-toggle"
      onClick={onToggle}
      aria-label={label}
      aria-expanded={expanded}
      aria-controls="quick-navigation"
      className={`${railItem(expanded)} text-slate-400 hover:bg-canvas hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40`}
    >
      <Icon
        paths={[expanded ? "M11 19l-7-7 7-7m8 14l-7-7 7-7" : "M13 5l7 7-7 7M5 5l7 7-7 7"]}
        className="h-[18px] w-[18px] flex-shrink-0"
      />
      {expanded ? (
        <span className="truncate whitespace-nowrap text-[13px] font-semibold">Collapse</span>
      ) : (
        <span className={railTooltip}>{label}</span>
      )}
    </button>
  );
}

/**
 * Ends the owner session, then does a full page load into /login. A client
 * navigation would keep the router cache, which can hold prefetched pages.
 */
async function signOut() {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload is intentional (see above)
  window.location.assign("/login");
}

export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  // Desktop rail: icon-only by default on every load.
  const [railExpanded, setRailExpanded] = useState(false);

  // The login page renders without app navigation.
  if (pathname === "/login") {
    return (
      <main className="relative h-full overflow-y-auto bg-canvas">
        <ThemeToggle className="absolute right-4 top-4 z-10" />
        {children}
      </main>
    );
  }

  return (
    <div className="flex h-full flex-col bg-canvas">
      {/* Top navigation */}
      <header className="relative z-40 flex h-14 flex-shrink-0 items-center border-b border-line bg-surface px-4 sm:px-6">
        <Link href="/" className="flex w-auto items-center gap-2 md:w-44 lg:w-52" onClick={() => setMenuOpen(false)}>
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand">
            <svg className="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </span>
          <span className="text-[15px] font-bold tracking-tight text-navy">ClearCollect</span>
        </Link>

        <nav className="hidden h-full flex-1 items-center justify-center gap-1 md:flex lg:gap-6" aria-label="Primary">
          {NAV.filter((item) => !item.sidebarOnly).map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`relative flex h-full items-center px-2 text-[13px] font-semibold transition-colors ${
                  active ? "text-brand" : "text-slate-500 hover:text-navy"
                }`}
              >
                {item.label}
                {active && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand" />}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center justify-end gap-2 md:ml-0 md:w-44 lg:w-52">
          <Link
            href="/create-invoice"
            className="hidden items-center gap-1 rounded-full bg-brand px-3.5 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-brand-dark sm:inline-flex md:hidden lg:inline-flex"
          >
            <Icon paths={ICONS.create} className="h-3.5 w-3.5" />
            New invoice
          </Link>
          <ThemeToggle />
          <button
            id="sign-out-btn"
            onClick={signOut}
            title="Sign out"
            aria-label="Sign out"
            className="hidden h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-canvas hover:text-navy md:flex"
          >
            <Icon paths={ICONS.signOut} />
          </button>
          <button
            id="mobile-menu-toggle"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Toggle menu"
            aria-expanded={menuOpen}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-navy hover:bg-canvas md:hidden"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d={menuOpen ? "M6 18L18 6M6 6l12 12" : "M4 6h16M4 12h16M4 18h16"} />
            </svg>
          </button>
        </div>

        {/* Mobile menu */}
        {menuOpen && (
          <nav className="absolute inset-x-0 top-14 border-b border-line bg-surface px-3 py-2 shadow-md md:hidden" aria-label="Mobile">
            {NAV.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMenuOpen(false)}
                  aria-current={active ? "page" : undefined}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-semibold ${
                    active ? "bg-brand-50 text-brand" : "text-slate-600 hover:bg-canvas"
                  }`}
                >
                  <Icon paths={item.icon} />
                  {item.label}
                </Link>
              );
            })}
            <button
              onClick={signOut}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-semibold text-slate-600 hover:bg-canvas"
            >
              <Icon paths={ICONS.signOut} />
              Sign out
            </button>
          </nav>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Icon rail (tablet and up; phones use the header menu). Collapsed by
            default; expanding animates its width, and main (min-w-0 flex-1)
            narrows alongside instead of being overlapped. Clipping applies
            only while expanded so collapsed-mode tooltips can extend past the rail. */}
        <aside
          id="quick-navigation"
          className={`hidden flex-shrink-0 flex-col gap-1.5 border-r border-line bg-surface py-3 transition-[width] duration-200 ease-out motion-reduce:transition-none md:flex ${
            railExpanded ? "w-52 items-stretch overflow-hidden px-2.5" : "w-14 items-center"
          }`}
          aria-label="Quick navigation"
        >
          <RailToggle expanded={railExpanded} onToggle={() => setRailExpanded((open) => !open)} />
          <div className={`mb-0.5 self-stretch border-t border-line ${railExpanded ? "mx-1" : "mx-2.5"}`} aria-hidden="true" />
          {NAV.slice(0, -1).map((item) => (
            <RailLink key={item.href} item={item} pathname={pathname} expanded={railExpanded} />
          ))}
          <div className={`mt-auto ${railExpanded ? "w-full" : ""}`}>
            <RailLink item={NAV[NAV.length - 1]} pathname={pathname} expanded={railExpanded} />
          </div>
        </aside>

        <main id="main-content" className="min-w-0 flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
