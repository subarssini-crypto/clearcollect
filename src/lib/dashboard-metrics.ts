/**
 * Dashboard metrics derived purely from invoice records (no hardcoded figures).
 * Kept free of React/Next imports so it can be unit-tested offline.
 *
 * Money is summed in integer cents. Figures are shown in the dominant
 * currency; invoices in other currencies are counted but not summed.
 * Collected dates use `updatedAt` of PAID invoices: PAID invoices can no
 * longer be edited, so it reflects when payment was recorded.
 */

export type InvoiceStatus = "DRAFT" | "SENT" | "PAID" | "OVERDUE" | "CANCELLED";
export type DisplayStatus = "Paid" | "Pending" | "Overdue" | "Draft" | "Cancelled";

export interface DashboardInvoice {
  id: number;
  invoiceNumber: string;
  amount: string | number;
  currency: string;
  issueDate: string;
  dueDate: string;
  updatedAt: string;
  status: InvoiceStatus;
  paypalCaptureId?: string | null;
  client: { id: number; name: string; company: string | null; email?: string | null };
}

export interface MonthPoint {
  key: string; // YYYY-MM
  label: string; // e.g. "Oct"
  invoiced: number;
  collected: number;
}

export interface ClientSummary {
  id: number;
  name: string;
  company: string | null;
  billed: number;
  paid: number;
  invoiceCount: number;
}

export interface DatedInvoice {
  invoice: DashboardInvoice;
  amount: number;
  days: number; // days until due (upcoming) or days overdue (follow-ups)
}

export interface DashboardMetrics {
  currency: string;
  otherCurrencyCount: number;
  outstanding: number;
  outstandingCount: number;
  overdue: number;
  overdueCount: number;
  collected: number;
  collectedCount: number;
  collectedThisMonth: number;
  collectedViaPaypalCount: number;
  draftCount: number;
  collectionRate: number | null; // 0–1, null when nothing billed
  statusCounts: Record<DisplayStatus, number>;
  monthly: MonthPoint[];
  recent: { invoice: DashboardInvoice; status: DisplayStatus }[];
  upcoming: DatedInvoice[];
  followUps: DatedInvoice[];
  topClients: ClientSummary[];
}

const DAY_MS = 86_400_000;

export function toCents(amount: string | number): number {
  const n = Number(amount);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function utcDay(value: string | number): number {
  const d = new Date(typeof value === "string" ? `${value.slice(0, 10)}T00:00:00Z` : value);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function monthKey(value: string | number): string {
  return new Date(value).toISOString().slice(0, 7);
}

/** Same rule as the invoices page: SENT invoices past due display as Overdue. */
export function displayStatus(invoice: DashboardInvoice, now: number): DisplayStatus {
  switch (invoice.status) {
    case "PAID":
      return "Paid";
    case "DRAFT":
      return "Draft";
    case "CANCELLED":
      return "Cancelled";
    case "OVERDUE":
      return "Overdue";
    default:
      return utcDay(invoice.dueDate) < utcDay(now) ? "Overdue" : "Pending";
  }
}

function dominantCurrency(invoices: DashboardInvoice[]): string {
  const counts = new Map<string, number>();
  for (const inv of invoices) {
    if (inv.status !== "CANCELLED") counts.set(inv.currency, (counts.get(inv.currency) ?? 0) + 1);
  }
  let best = "USD";
  let bestCount = 0;
  for (const [currency, count] of counts) {
    if (count > bestCount) [best, bestCount] = [currency, count];
  }
  return best;
}

export function computeDashboard(
  invoices: DashboardInvoice[],
  now: number,
  months = 6
): DashboardMetrics {
  const currency = dominantCurrency(invoices);
  const inCurrency = invoices.filter((inv) => inv.currency === currency);
  const today = utcDay(now);
  const thisMonth = monthKey(now);

  const statusCounts: Record<DisplayStatus, number> = { Paid: 0, Pending: 0, Overdue: 0, Draft: 0, Cancelled: 0 };
  for (const inv of invoices) statusCounts[displayStatus(inv, now)]++;

  // Last `months` calendar months (UTC), oldest first.
  const nowDate = new Date(now);
  const monthly: MonthPoint[] = Array.from({ length: months }, (_, i) => {
    const d = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() - (months - 1 - i), 1));
    return {
      key: d.toISOString().slice(0, 7),
      label: d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }),
      invoiced: 0,
      collected: 0,
    };
  });
  const monthIndex = new Map(monthly.map((m, i) => [m.key, i]));

  let outstanding = 0, outstandingCount = 0, overdue = 0, overdueCount = 0;
  let collected = 0, collectedCount = 0, collectedThisMonth = 0, collectedViaPaypalCount = 0;
  const upcoming: DatedInvoice[] = [];
  const followUps: DatedInvoice[] = [];
  const clients = new Map<number, ClientSummary>();

  for (const inv of inCurrency) {
    const cents = toCents(inv.amount);
    const status = displayStatus(inv, now);
    const billable = status !== "Draft" && status !== "Cancelled";

    if (billable) {
      const i = monthIndex.get(monthKey(`${inv.issueDate.slice(0, 10)}T00:00:00Z`));
      if (i !== undefined) monthly[i].invoiced += cents;

      const c = clients.get(inv.client.id) ?? {
        id: inv.client.id, name: inv.client.name, company: inv.client.company, billed: 0, paid: 0, invoiceCount: 0,
      };
      c.billed += cents;
      c.invoiceCount++;
      if (status === "Paid") c.paid += cents;
      clients.set(inv.client.id, c);
    }

    if (status === "Paid") {
      collected += cents;
      collectedCount++;
      if (inv.paypalCaptureId) collectedViaPaypalCount++;
      if (monthKey(inv.updatedAt) === thisMonth) collectedThisMonth += cents;
      const i = monthIndex.get(monthKey(inv.updatedAt));
      if (i !== undefined) monthly[i].collected += cents;
    } else if (status === "Pending" || status === "Overdue") {
      outstanding += cents;
      outstandingCount++;
      const days = Math.round((utcDay(inv.dueDate) - today) / DAY_MS);
      if (status === "Overdue") {
        overdue += cents;
        overdueCount++;
        followUps.push({ invoice: inv, amount: cents / 100, days: Math.max(0, -days) });
      } else {
        upcoming.push({ invoice: inv, amount: cents / 100, days });
      }
    }
  }

  const recent = [...invoices]
    .sort((a, b) => b.issueDate.localeCompare(a.issueDate) || b.id - a.id)
    .slice(0, 6)
    .map((invoice) => ({ invoice, status: displayStatus(invoice, now) }));

  return {
    currency,
    otherCurrencyCount: invoices.length - inCurrency.length,
    outstanding: outstanding / 100,
    outstandingCount,
    overdue: overdue / 100,
    overdueCount,
    collected: collected / 100,
    collectedCount,
    collectedThisMonth: collectedThisMonth / 100,
    collectedViaPaypalCount,
    draftCount: statusCounts.Draft,
    collectionRate: collected + outstanding > 0 ? collected / (collected + outstanding) : null,
    statusCounts,
    monthly: monthly.map((m) => ({ ...m, invoiced: m.invoiced / 100, collected: m.collected / 100 })),
    recent,
    upcoming: upcoming.sort((a, b) => a.days - b.days).slice(0, 5),
    followUps: followUps.sort((a, b) => b.days - a.days).slice(0, 5),
    topClients: [...clients.values()]
      .sort((a, b) => b.billed - a.billed)
      .slice(0, 4)
      .map((c) => ({ ...c, billed: c.billed / 100, paid: c.paid / 100 })),
  };
}
