
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Invoice = {
  id: number;
  invoiceNumber: string;
  clientId: number;
  amount: string | number;
  currency: string;
  issueDate: string;
  dueDate: string;
  createdAt?: string;
  status: "DRAFT" | "SENT" | "PAID" | "OVERDUE" | "CANCELLED";
  client: {
    id: number;
    name: string;
    email: string | null;
    company: string | null;
  };
};

type ApiResponse = {
  ok: boolean;
  data?: Invoice[];
  error?: string;
};

const avatarColors = [
  "bg-violet-100 text-violet-700",
  "bg-blue-100 text-blue-700",
  "bg-emerald-100 text-emerald-700",
  "bg-pink-100 text-pink-700",
  "bg-orange-100 text-orange-700",
  "bg-teal-100 text-teal-700",
  "bg-indigo-100 text-indigo-700",
  "bg-cyan-100 text-cyan-700",
];

function formatMoney(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function getInitials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function getDisplayStatus(invoice: Invoice) {
  if (invoice.status === "PAID") return "Paid";
  if (invoice.status === "DRAFT") return "Draft";
  if (invoice.status === "CANCELLED") return "Cancelled";
  if (invoice.status === "OVERDUE") return "Overdue";

  const dueDate = new Date(
    `${invoice.dueDate.slice(0, 10)}T00:00:00Z`
  );

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  return dueDate < today ? "Overdue" : "Pending";
}

function getStatusStyle(status: string) {
  switch (status) {
    case "Paid":
      return "bg-emerald-100 text-emerald-700";
    case "Pending":
      return "bg-amber-100 text-amber-700";
    case "Overdue":
      return "bg-red-100 text-red-700";
    case "Draft":
      return "bg-slate-100 text-slate-600";
    case "Cancelled":
      return "bg-slate-200 text-slate-600";
    default:
      return "bg-slate-100 text-slate-600";
  }
}

export default function DashboardPage() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function loadInvoices() {
      try {
        const response = await fetch("/api/invoices?limit=100");
        const result: ApiResponse = await response.json();

        if (!response.ok || !result.ok || !result.data) {
          throw new Error(
            result.error || "Could not load dashboard data."
          );
        }

        if (!cancelled) {
          setInvoices(result.data);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Something went wrong loading dashboard data."
          );
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadInvoices();

    return () => {
      cancelled = true;
    };
  }, []);

  const activeInvoices = invoices.filter(
    (invoice) => invoice.status !== "CANCELLED"
  );

  const totalInvoiced = activeInvoices.reduce(
    (sum, invoice) => sum + Number(invoice.amount),
    0
  );

  const paidInvoices = activeInvoices.filter(
    (invoice) => invoice.status === "PAID"
  );

  const totalPaid = paidInvoices.reduce(
    (sum, invoice) => sum + Number(invoice.amount),
    0
  );

  const pendingInvoices = activeInvoices.filter(
    (invoice) => getDisplayStatus(invoice) === "Pending"
  );

  const totalPending = pendingInvoices.reduce(
    (sum, invoice) => sum + Number(invoice.amount),
    0
  );

  const overdueInvoices = activeInvoices.filter(
    (invoice) => getDisplayStatus(invoice) === "Overdue"
  );

  const totalOverdue = overdueInvoices.reduce(
    (sum, invoice) => sum + Number(invoice.amount),
    0
  );

  const currencies = new Set(
    activeInvoices.map((invoice) => invoice.currency)
  );

  const currency =
    currencies.size === 1
      ? activeInvoices[0]?.currency ?? "USD"
      : null;

  const formatTotal = (amount: number) =>
    currencies.size > 1
      ? "Multiple currencies"
      : formatMoney(amount, currency ?? "USD");

  const collectionRate =
    totalInvoiced > 0
      ? Math.round((totalPaid / totalInvoiced) * 100)
      : 0;

  const summaryCards = [
    {
      id: "total-invoiced",
      label: "Total Invoiced",
      value: formatTotal(totalInvoiced),
      change: `${activeInvoices.length} active invoices`,
      icon: (
        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      ),
      color: "bg-blue-50 text-blue-600",
      ring: "ring-blue-100",
    },
    {
      id: "total-paid",
      label: "Paid",
      value: formatTotal(totalPaid),
      change: `${collectionRate}% of invoiced amount`,
      icon: (
        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
      color: "bg-emerald-50 text-emerald-600",
      ring: "ring-emerald-100",
    },
    {
      id: "total-pending",
      label: "Pending",
      value: formatTotal(totalPending),
      change: `${pendingInvoices.length} invoices awaiting payment`,
      icon: (
        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
      color: "bg-amber-50 text-amber-600",
      ring: "ring-amber-100",
    },
    {
      id: "total-overdue",
      label: "Overdue",
      value: formatTotal(totalOverdue),
      change: `${overdueInvoices.length} overdue invoices`,
      icon: (
        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      ),
      color: "bg-red-50 text-red-600",
      ring: "ring-red-100",
    },
  ];

  const recentInvoices = [...invoices]
    .sort(
      (a, b) =>
        new Date(b.createdAt ?? b.issueDate).getTime() -
        new Date(a.createdAt ?? a.issueDate).getTime()
    )
    .slice(0, 5);

  return (
    <div className="min-h-full p-6 lg:p-8">
      {/* Page header */}
      <div className="mb-8 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            Dashboard
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Your invoicing overview, calculated from your database.
          </p>
        </div>

        <Link
          href="/create-invoice"
          id="dashboard-create-invoice-btn"
          className="hidden sm:flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2.5 rounded-xl transition-colors shadow-sm shadow-blue-200"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          New Invoice
        </Link>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-6 rounded-xl bg-red-50 p-4 text-sm text-red-700"
        >
          {error}
          <button
            onClick={() => window.location.reload()}
            className="ml-2 font-semibold underline"
          >
            Try again
          </button>
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-8">
        {summaryCards.map((card) => (
          <div
            key={card.id}
            id={card.id}
            className="bg-white rounded-2xl p-5 ring-1 ring-slate-200 hover:ring-slate-300 hover:shadow-md transition-all duration-200"
          >
            <div className="flex items-start justify-between mb-4">
              <div className={`${card.color} ${card.ring} ring-1 p-2.5 rounded-xl`}>
                {card.icon}
              </div>
            </div>

            <p className="text-slate-500 text-sm font-medium">
              {card.label}
            </p>

            <p className="text-2xl font-bold text-slate-900 mt-1">
              {isLoading ? "Loading..." : card.value}
            </p>

            <p className="text-xs mt-1.5 font-medium text-slate-400">
              {isLoading ? "Fetching database data" : card.change}
            </p>
          </div>
        ))}
      </div>

      {/* Recent invoices */}
      <div className="bg-white rounded-2xl ring-1 ring-slate-200 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <h2 className="font-semibold text-slate-900">
            Recent Invoices
          </h2>

          <Link
            href="/invoices"
            id="dashboard-view-all-invoices"
            className="text-blue-600 hover:text-blue-700 text-sm font-medium transition-colors"
          >
            View all →
          </Link>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="text-left px-6 py-3 font-medium text-slate-500">
                  Invoice
                </th>
                <th className="text-left px-4 py-3 font-medium text-slate-500">
                  Client
                </th>
                <th className="text-left px-4 py-3 font-medium text-slate-500">
                  Amount
                </th>
                <th className="text-left px-4 py-3 font-medium text-slate-500 hidden md:table-cell">
                  Issued
                </th>
                <th className="text-left px-4 py-3 font-medium text-slate-500">
                  Due Date
                </th>
                <th className="text-left px-4 py-3 font-medium text-slate-500">
                  Status
                </th>
              </tr>
            </thead>

            <tbody className="divide-y divide-slate-50">
              {!isLoading && !error && recentInvoices.map((invoice, index) => {
                const status = getDisplayStatus(invoice);

                return (
                  <tr
                    key={invoice.id}
                    className="hover:bg-slate-50/70 transition-colors"
                  >
                    <td className="px-6 py-4 font-mono text-xs font-medium text-slate-500 whitespace-nowrap">
                      {invoice.invoiceNumber}
                    </td>

                    <td className="px-4 py-4">
                      <div className="flex items-center gap-2.5">
                        <div
                          className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${avatarColors[index % avatarColors.length]
                            }`}
                        >
                          {getInitials(invoice.client.name)}
                        </div>
                        <span className="font-medium text-slate-800">
                          {invoice.client.name}
                        </span>
                      </div>
                    </td>

                    <td className="px-4 py-4 font-semibold text-slate-900 whitespace-nowrap">
                      {formatMoney(Number(invoice.amount), invoice.currency)}
                    </td>

                    <td className="px-4 py-4 text-slate-500 hidden md:table-cell whitespace-nowrap">
                      {formatDate(invoice.issueDate)}
                    </td>

                    <td className="px-4 py-4 text-slate-500 whitespace-nowrap">
                      {formatDate(invoice.dueDate)}
                    </td>

                    <td className="px-4 py-4">
                      <span
                        className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${getStatusStyle(status)}`}
                      >
                        {status}
                      </span>
                    </td>
                  </tr>
                );
              })}

              {isLoading && (
                <tr>
                  <td colSpan={6} className="px-6 py-10 text-center text-slate-500">
                    Loading invoices from the database...
                  </td>
                </tr>
              )}

              {!isLoading && !error && recentInvoices.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-10 text-center text-slate-500">
                    No invoices yet. Create your first invoice to get started.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="px-6 py-3 bg-slate-50 border-t border-slate-100">
          <p className="text-xs text-slate-400">
            Live database data · Paid totals reflect invoices marked as paid.
          </p>
        </div>
      </div>
    </div>
  );
}
