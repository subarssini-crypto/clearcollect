"use client";

import { useState } from "react";

// ── Sample follow-up tasks — demo data only ──
const initialFollowUps = [
  {
    id: 1,
    client: "Acme Corp",
    initials: "AC",
    color: "bg-violet-100 text-violet-700",
    invoice: "INV-2024-001",
    amount: "$3,500",
    daysOverdue: 8,
    status: "Overdue",
    urgency: "high",
    reminder: `Hi John,\n\nJust following up on Invoice INV-2024-001 for $3,500, which was due on October 15th and is now 8 days overdue.\n\nCould you please arrange payment at your earliest convenience?\n\nThank you,\nJane`,
  },
  {
    id: 2,
    client: "Ridge Analytics",
    initials: "RA",
    color: "bg-indigo-100 text-indigo-700",
    invoice: "INV-2024-007",
    amount: "$4,100",
    daysOverdue: 17,
    status: "Overdue",
    urgency: "high",
    reminder: `Hi Team,\n\nThis is a reminder that Invoice INV-2024-007 for $4,100 remains unpaid and is now 17 days past due.\n\nPlease let me know if there's anything I can help resolve.\n\nBest,\nJane`,
  },
  {
    id: 3,
    client: "Stellar Labs",
    initials: "SL",
    color: "bg-emerald-100 text-emerald-700",
    invoice: "INV-2024-003",
    amount: "$5,800",
    daysOverdue: 0,
    dueIn: 7,
    status: "Pending",
    urgency: "medium",
    reminder: `Hi Dev Team,\n\nJust a friendly heads-up that Invoice INV-2024-003 for $5,800 is due in 7 days (October 25th).\n\nPlease don't hesitate to reach out with any questions.\n\nThanks,\nJane`,
  },
];

export default function FollowUpsPage() {
  const [followUps, setFollowUps] = useState(initialFollowUps);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [sentIds, setSentIds] = useState<Set<number>>(new Set());

  const handleSend = (id: number) => {
    setSentIds((prev) => new Set([...prev, id]));
  };

  const handleUpdateReminder = (id: number, text: string) => {
    setFollowUps((prev) =>
      prev.map((f) => (f.id === id ? { ...f, reminder: text } : f))
    );
  };

  return (
    <div className="min-h-full p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">
          AI Follow-up Assistant
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          AI-drafted payment reminders for overdue and upcoming invoices.{" "}
          <span className="text-amber-600 font-medium">
            ⚠ Demo mode — no emails are actually sent.
          </span>
        </p>
      </div>

      {/* Stats bar */}
      <div className="flex flex-wrap gap-3 mb-6">
        <div className="bg-red-50 ring-1 ring-red-100 rounded-xl px-4 py-2 flex items-center gap-2 text-sm">
          <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
          <span className="text-red-700 font-medium">2 Overdue</span>
        </div>
        <div className="bg-amber-50 ring-1 ring-amber-100 rounded-xl px-4 py-2 flex items-center gap-2 text-sm">
          <span className="w-2 h-2 bg-amber-500 rounded-full" />
          <span className="text-amber-700 font-medium">1 Due Soon</span>
        </div>
      </div>

      {/* Follow-up cards */}
      <div className="space-y-4">
        {followUps.map((item) => (
          <div
            key={item.id}
            id={`followup-card-${item.id}`}
            className={`bg-white rounded-2xl ring-1 overflow-hidden transition-all duration-200 ${
              item.urgency === "high"
                ? "ring-red-200 hover:ring-red-300"
                : "ring-slate-200 hover:ring-amber-200"
            }`}
          >
            {/* Card header */}
            <div
              className={`px-5 py-3 flex items-center justify-between text-xs font-semibold ${
                item.urgency === "high"
                  ? "bg-red-50 text-red-700 border-b border-red-100"
                  : "bg-amber-50 text-amber-700 border-b border-amber-100"
              }`}
            >
              <span>
                {item.urgency === "high"
                  ? `🚨 ${item.daysOverdue} days overdue`
                  : `⏰ Due in ${item.dueIn} days`}
              </span>
              <span className="font-normal opacity-70">
                {item.invoice} · {item.amount}
              </span>
            </div>

            <div className="p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 ${item.color}`}
                  >
                    {item.initials}
                  </div>
                  <div>
                    <p className="font-semibold text-slate-900">{item.client}</p>
                    <p className="text-slate-400 text-xs">{item.invoice}</p>
                  </div>
                </div>
                <button
                  id={`toggle-reminder-${item.id}`}
                  onClick={() =>
                    setActiveId(activeId === item.id ? null : item.id)
                  }
                  className="text-blue-600 hover:text-blue-700 text-sm font-medium flex items-center gap-1 transition-colors"
                >
                  {activeId === item.id ? "Hide" : "Edit Reminder"}
                  <svg
                    className={`w-4 h-4 transition-transform ${activeId === item.id ? "rotate-180" : ""}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
              </div>

              {activeId === item.id && (
                <div className="mb-4">
                  <p className="text-xs text-slate-400 font-medium mb-1.5">
                    Edit the AI-drafted message before sending:
                  </p>
                  <textarea
                    id={`reminder-edit-${item.id}`}
                    value={item.reminder}
                    onChange={(e) =>
                      handleUpdateReminder(item.id, e.target.value)
                    }
                    rows={8}
                    className="w-full border border-slate-200 rounded-xl px-3 py-3 text-sm text-slate-700 font-mono leading-relaxed bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none transition"
                  />
                </div>
              )}

              <div className="flex items-center gap-3">
                <button
                  id={`send-followup-${item.id}`}
                  onClick={() => handleSend(item.id)}
                  className={`flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-xl transition-all ${
                    sentIds.has(item.id)
                      ? "bg-emerald-100 text-emerald-700 cursor-default"
                      : "bg-blue-600 hover:bg-blue-700 text-white shadow-sm shadow-blue-200"
                  }`}
                >
                  {sentIds.has(item.id) ? (
                    <>✓ Sent (Demo)</>
                  ) : (
                    <>
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                      </svg>
                      Send Reminder (Demo)
                    </>
                  )}
                </button>
                <button
                  id={`dismiss-followup-${item.id}`}
                  className="text-slate-400 hover:text-slate-600 text-sm font-medium transition-colors"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
