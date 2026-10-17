import Link from "next/link";

// ── Sample data ── These are demo figures only. No real payments.
const summaryCards = [
  {
    id: "total-invoiced",
    label: "Total Invoiced",
    value: "$24,800",
    change: "+12% vs last month",
    positive: true,
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
    value: "$18,350",
    change: "74% collection rate",
    positive: true,
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
    value: "$4,200",
    change: "3 invoices awaiting",
    positive: null,
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
    value: "$2,250",
    change: "2 invoices overdue",
    positive: false,
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
    ),
    color: "bg-red-50 text-red-600",
    ring: "ring-red-100",
  },
];

// ── Sample invoice rows ── All data is fictional for demonstration purposes
const recentInvoices = [
  {
    id: "INV-2024-001",
    client: "Acme Corp",
    clientInitials: "AC",
    clientColor: "bg-violet-100 text-violet-700",
    amount: "$3,500",
    issued: "Oct 1, 2024",
    due: "Oct 15, 2024",
    status: "Overdue",
    statusColor: "bg-red-100 text-red-700",
  },
  {
    id: "INV-2024-002",
    client: "Bright Media",
    clientInitials: "BM",
    clientColor: "bg-blue-100 text-blue-700",
    amount: "$1,200",
    issued: "Oct 5, 2024",
    due: "Oct 20, 2024",
    status: "Paid",
    statusColor: "bg-emerald-100 text-emerald-700",
  },
  {
    id: "INV-2024-003",
    client: "Stellar Labs",
    clientInitials: "SL",
    clientColor: "bg-emerald-100 text-emerald-700",
    amount: "$5,800",
    issued: "Oct 8, 2024",
    due: "Oct 25, 2024",
    status: "Pending",
    statusColor: "bg-amber-100 text-amber-700",
  },
  {
    id: "INV-2024-004",
    client: "Nova Digital",
    clientInitials: "ND",
    clientColor: "bg-pink-100 text-pink-700",
    amount: "$920",
    issued: "Oct 10, 2024",
    due: "Oct 28, 2024",
    status: "Paid",
    statusColor: "bg-emerald-100 text-emerald-700",
  },
  {
    id: "INV-2024-005",
    client: "Peak Solutions",
    clientInitials: "PS",
    clientColor: "bg-orange-100 text-orange-700",
    amount: "$2,750",
    issued: "Oct 12, 2024",
    due: "Oct 31, 2024",
    status: "Pending",
    statusColor: "bg-amber-100 text-amber-700",
  },
];

export default function DashboardPage() {
  return (
    <div className="min-h-full p-6 lg:p-8">
      {/* Page header */}
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
          <p className="text-slate-500 text-sm mt-1">
            Welcome back, Jane — here&apos;s your invoicing overview.{" "}
            <span className="text-amber-600 font-medium">
              ⚠ All figures below are sample data only.
            </span>
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
            <p className="text-slate-500 text-sm font-medium">{card.label}</p>
            <p className="text-2xl font-bold text-slate-900 mt-1">{card.value}</p>
            <p
              className={`text-xs mt-1.5 font-medium ${
                card.positive === true
                  ? "text-emerald-600"
                  : card.positive === false
                    ? "text-red-500"
                    : "text-slate-400"
              }`}
            >
              {card.positive === true && "↑ "}
              {card.positive === false && "↓ "}
              {card.change}
            </p>
          </div>
        ))}
      </div>

      {/* Recent Invoices table */}
      <div className="bg-white rounded-2xl ring-1 ring-slate-200 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <h2 className="font-semibold text-slate-900">Recent Invoices</h2>
          <Link
            href="/invoices"
            id="dashboard-view-all-invoices"
            className="text-blue-600 hover:text-blue-700 text-sm font-medium transition-colors"
          >
            View all →
          </Link>
        </div>

        {/* Desktop table */}
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
              {recentInvoices.map((inv) => (
                <tr
                  key={inv.id}
                  className="hover:bg-slate-50/70 transition-colors group"
                >
                  <td className="px-6 py-4 font-mono text-xs font-medium text-slate-500">
                    {inv.id}
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex items-center gap-2.5">
                      <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${inv.clientColor}`}
                      >
                        {inv.clientInitials}
                      </div>
                      <span className="font-medium text-slate-800">
                        {inv.client}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-4 font-semibold text-slate-900">
                    {inv.amount}
                  </td>
                  <td className="px-4 py-4 text-slate-500 hidden md:table-cell">
                    {inv.issued}
                  </td>
                  <td className="px-4 py-4 text-slate-500">{inv.due}</td>
                  <td className="px-4 py-4">
                    <span
                      className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${inv.statusColor}`}
                    >
                      {inv.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="px-6 py-3 bg-slate-50 border-t border-slate-100">
          <p className="text-xs text-slate-400">
            ⚠ Sample data only — not real transactions
          </p>
        </div>
      </div>
    </div>
  );
}
