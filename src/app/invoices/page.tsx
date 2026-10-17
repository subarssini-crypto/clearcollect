import Link from "next/link";

// ── All invoice data below is fictional sample data only ──
const allInvoices = [
  { id: "INV-2024-001", client: "Acme Corp", initials: "AC", color: "bg-violet-100 text-violet-700", amount: "$3,500", issued: "Oct 1, 2024", due: "Oct 15, 2024", status: "Overdue", statusColor: "bg-red-100 text-red-700" },
  { id: "INV-2024-002", client: "Bright Media", initials: "BM", color: "bg-blue-100 text-blue-700", amount: "$1,200", issued: "Oct 5, 2024", due: "Oct 20, 2024", status: "Paid", statusColor: "bg-emerald-100 text-emerald-700" },
  { id: "INV-2024-003", client: "Stellar Labs", initials: "SL", color: "bg-emerald-100 text-emerald-700", amount: "$5,800", issued: "Oct 8, 2024", due: "Oct 25, 2024", status: "Pending", statusColor: "bg-amber-100 text-amber-700" },
  { id: "INV-2024-004", client: "Nova Digital", initials: "ND", color: "bg-pink-100 text-pink-700", amount: "$920", issued: "Oct 10, 2024", due: "Oct 28, 2024", status: "Paid", statusColor: "bg-emerald-100 text-emerald-700" },
  { id: "INV-2024-005", client: "Peak Solutions", initials: "PS", color: "bg-orange-100 text-orange-700", amount: "$2,750", issued: "Oct 12, 2024", due: "Oct 31, 2024", status: "Pending", statusColor: "bg-amber-100 text-amber-700" },
  { id: "INV-2024-006", client: "Horizon Creative", initials: "HC", color: "bg-teal-100 text-teal-700", amount: "$1,830", issued: "Oct 20, 2024", due: "Nov 5, 2024", status: "Draft", statusColor: "bg-slate-100 text-slate-600" },
  { id: "INV-2024-007", client: "Ridge Analytics", initials: "RA", color: "bg-indigo-100 text-indigo-700", amount: "$4,100", issued: "Sep 15, 2024", due: "Sep 30, 2024", status: "Overdue", statusColor: "bg-red-100 text-red-700" },
  { id: "INV-2024-008", client: "Blue Prism Co.", initials: "BP", color: "bg-cyan-100 text-cyan-700", amount: "$660", issued: "Sep 20, 2024", due: "Oct 5, 2024", status: "Paid", statusColor: "bg-emerald-100 text-emerald-700" },
];

const tabs = ["All", "Paid", "Pending", "Overdue", "Draft"];

export default function InvoicesPage() {
  return (
    <div className="min-h-full p-6 lg:p-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Invoices</h1>
          <p className="text-slate-500 text-sm mt-1">
            Manage all your invoices.{" "}
            <span className="text-amber-600 font-medium">
              ⚠ Sample data only.
            </span>
          </p>
        </div>
        <Link
          href="/create-invoice"
          id="invoices-create-btn"
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2.5 rounded-xl transition-colors shadow-sm shadow-blue-200"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          New Invoice
        </Link>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 mb-5 bg-slate-100 p-1 rounded-xl w-fit">
        {tabs.map((tab) => (
          <button
            key={tab}
            id={`filter-tab-${tab.toLowerCase()}`}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              tab === "All"
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl ring-1 ring-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="text-left px-6 py-3 font-medium text-slate-500">Invoice</th>
                <th className="text-left px-4 py-3 font-medium text-slate-500">Client</th>
                <th className="text-left px-4 py-3 font-medium text-slate-500">Amount</th>
                <th className="text-left px-4 py-3 font-medium text-slate-500 hidden md:table-cell">Issued</th>
                <th className="text-left px-4 py-3 font-medium text-slate-500">Due Date</th>
                <th className="text-left px-4 py-3 font-medium text-slate-500">Status</th>
                <th className="text-left px-4 py-3 font-medium text-slate-500 hidden lg:table-cell">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {allInvoices.map((inv) => (
                <tr key={inv.id} className="hover:bg-slate-50/70 transition-colors">
                  <td className="px-6 py-4 font-mono text-xs font-medium text-slate-500">{inv.id}</td>
                  <td className="px-4 py-4">
                    <div className="flex items-center gap-2.5">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${inv.color}`}>
                        {inv.initials}
                      </div>
                      <span className="font-medium text-slate-800">{inv.client}</span>
                    </div>
                  </td>
                  <td className="px-4 py-4 font-semibold text-slate-900">{inv.amount}</td>
                  <td className="px-4 py-4 text-slate-500 hidden md:table-cell">{inv.issued}</td>
                  <td className="px-4 py-4 text-slate-500">{inv.due}</td>
                  <td className="px-4 py-4">
                    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${inv.statusColor}`}>
                      {inv.status}
                    </span>
                  </td>
                  <td className="px-4 py-4 hidden lg:table-cell">
                    <div className="flex items-center gap-2">
                      <button className="text-blue-600 hover:text-blue-700 text-xs font-medium transition-colors">
                        View
                      </button>
                      <span className="text-slate-200">|</span>
                      <button className="text-slate-500 hover:text-slate-700 text-xs font-medium transition-colors">
                        Send
                      </button>
                    </div>
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
