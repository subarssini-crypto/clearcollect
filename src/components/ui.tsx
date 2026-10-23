/**
 * Shared ClearCollect UI primitives (compact dashboard design system).
 * Colors come from the tokens in globals.css (brand, navy, canvas, surface,
 * line, muted), which switch with the light/dark theme. Use bg-surface for
 * white surfaces. Cards use the `card` utility.
 */

import type { ReactNode } from "react";

export const btnPrimary =
  "inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50";

export const btnSecondary =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-3.5 py-2 text-[13px] font-semibold text-navy transition-colors hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50";

export const linkAction = "text-xs font-semibold text-brand hover:text-brand-ink";

export const inputClass =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-navy placeholder:text-slate-400 outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/15";

export const labelClass = "mb-1 block text-xs font-medium text-muted";

/** Page wrapper with consistent max width and compact padding. */
export function Page({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[1440px] px-4 py-5 sm:px-6 lg:px-8">{children}</div>;
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-bold tracking-tight text-navy">{title}</h1>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardHeader({ title, action, className = "" }: { title: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={`flex items-center justify-between gap-3 px-4 pt-4 pb-2 ${className}`}>
      <h2 className="text-sm font-semibold text-navy">{title}</h2>
      {action}
    </div>
  );
}

export type StatusLabel = "Paid" | "Pending" | "Overdue" | "Draft" | "Cancelled";

/** Status colors: green paid, yellow pending, red overdue. */
export const statusColors: Record<StatusLabel, { pill: string; dot: string }> = {
  Paid: { pill: "bg-emerald-50 text-emerald-700", dot: "bg-emerald-500" },
  Pending: { pill: "bg-amber-50 text-amber-700", dot: "bg-amber-400" },
  Overdue: { pill: "bg-red-50 text-red-700", dot: "bg-red-500" },
  Draft: { pill: "bg-slate-100 text-slate-600", dot: "bg-slate-300" },
  Cancelled: { pill: "bg-slate-100 text-slate-500", dot: "bg-slate-200" },
};

export function StatusPill({ status }: { status: StatusLabel }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusColors[status].pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${statusColors[status].dot}`} />
      {status}
    </span>
  );
}

export function Avatar({ name, index = 0, size = "h-8 w-8" }: { name: string; index?: number; size?: string }) {
  const tones = [
    "bg-brand-50 text-brand",
    "bg-violet-50 text-violet-700",
    "bg-emerald-50 text-emerald-700",
    "bg-amber-50 text-amber-700",
    "bg-pink-50 text-pink-700",
    "bg-cyan-50 text-cyan-700",
  ];
  const initials = name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");
  return (
    <span className={`flex ${size} flex-shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${tones[index % tones.length]}`}>
      {initials}
    </span>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "error" | "success" | "warning"; children: ReactNode }) {
  const tones = {
    info: "bg-brand-50 text-brand-ink border-brand-100",
    error: "bg-red-50 text-red-700 border-red-100",
    success: "bg-emerald-50 text-emerald-700 border-emerald-100",
    warning: "bg-amber-50 text-amber-800 border-amber-100",
  };
  return <div className={`rounded-lg border px-3 py-2 text-[13px] ${tones[tone]}`}>{children}</div>;
}
