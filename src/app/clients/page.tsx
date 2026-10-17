"use client";

import Link from "next/link";

// ── Sample client data — for demonstration purposes only ──
const clients = [
  { id: 1, name: "Acme Corp", initials: "AC", color: "bg-violet-100 text-violet-700", contact: "john@acmecorp.com", invoices: 4, totalBilled: "$12,400", lastInvoice: "Oct 1, 2024", status: "Active" },
  { id: 2, name: "Bright Media", initials: "BM", color: "bg-blue-100 text-blue-700", contact: "lisa@brightmedia.com", invoices: 2, totalBilled: "$2,800", lastInvoice: "Oct 5, 2024", status: "Active" },
  { id: 3, name: "Stellar Labs", initials: "SL", color: "bg-emerald-100 text-emerald-700", contact: "dev@stellarlabs.io", invoices: 3, totalBilled: "$15,600", lastInvoice: "Oct 8, 2024", status: "Active" },
  { id: 4, name: "Nova Digital", initials: "ND", color: "bg-pink-100 text-pink-700", contact: "nova@novadigital.co", invoices: 1, totalBilled: "$920", lastInvoice: "Oct 10, 2024", status: "Inactive" },
  { id: 5, name: "Peak Solutions", initials: "PS", color: "bg-orange-100 text-orange-700", contact: "ops@peaksolutions.com", invoices: 5, totalBilled: "$9,200", lastInvoice: "Oct 12, 2024", status: "Active" },
  { id: 6, name: "Horizon Creative", initials: "HC", color: "bg-teal-100 text-teal-700", contact: "sarah@horizoncreative.com", invoices: 2, totalBilled: "$4,680", lastInvoice: "Oct 20, 2024", status: "Active" },
];

export default function ClientsPage() {
  return (
    <div className="min-h-full p-6 lg:p-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Clients</h1>
          <p className="text-slate-500 text-sm mt-1">
            View and manage your client list.{" "}
            <span className="text-amber-600 font-medium">
              ⚠ Sample data only.
            </span>
          </p>
        </div>
        <button
          id="add-client-btn"
          onClick={() =>
            alert("Add Client — coming soon! No data will be saved in demo mode.")
          }
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2.5 rounded-xl transition-colors shadow-sm shadow-blue-200"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Add Client
        </button>
      </div>

      {/* Client cards grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {clients.map((client) => (
          <div
            key={client.id}
            id={`client-card-${client.id}`}
            className="bg-white rounded-2xl ring-1 ring-slate-200 hover:ring-blue-200 hover:shadow-md p-5 transition-all duration-200"
          >
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div
                  className={`w-11 h-11 rounded-xl flex items-center justify-center text-sm font-bold flex-shrink-0 ${client.color}`}
                >
                  {client.initials}
                </div>
                <div>
                  <h3 className="font-semibold text-slate-900">{client.name}</h3>
                  <p className="text-slate-400 text-xs truncate">{client.contact}</p>
                </div>
              </div>
              <span
                className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                  client.status === "Active"
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-slate-100 text-slate-500"
                }`}
              >
                {client.status}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm mb-4">
              <div className="bg-slate-50 rounded-lg p-3">
                <p className="text-slate-400 text-xs mb-0.5">Total Billed</p>
                <p className="font-bold text-slate-900">{client.totalBilled}</p>
              </div>
              <div className="bg-slate-50 rounded-lg p-3">
                <p className="text-slate-400 text-xs mb-0.5">Invoices</p>
                <p className="font-bold text-slate-900">{client.invoices}</p>
              </div>
            </div>

            <div className="flex items-center justify-between text-xs text-slate-400 border-t border-slate-100 pt-3">
              <span>Last invoice: {client.lastInvoice}</span>
              <Link
                href="/create-invoice"
                className="text-blue-600 hover:text-blue-700 font-medium transition-colors"
              >
                + Invoice
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
