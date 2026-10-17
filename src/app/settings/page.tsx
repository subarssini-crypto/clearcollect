"use client";

import { useState } from "react";

export default function SettingsPage() {
  const [name, setName] = useState("Jane Doe");
  const [email, setEmail] = useState("jane@business.com");
  const [businessName, setBusinessName] = useState("Jane Doe Consulting");
  const [currency, setCurrency] = useState("USD");
  const [paymentTerms, setPaymentTerms] = useState("30");
  const [taxRate, setTaxRate] = useState("10");
  const [emailReminders, setEmailReminders] = useState(true);
  const [autoFollowUp, setAutoFollowUp] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div className="min-h-full p-6 lg:p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900">Settings</h1>
        <p className="text-slate-500 text-sm mt-1">
          Configure your account and invoice preferences.{" "}
          <span className="text-amber-600 font-medium">
            ⚠ Demo mode — no data is saved.
          </span>
        </p>
      </div>

      <div className="max-w-2xl space-y-6">
        {/* Profile */}
        <section className="bg-white rounded-2xl ring-1 ring-slate-200 p-6">
          <h2 className="font-semibold text-slate-900 mb-5">Profile</h2>
          <div className="flex items-center gap-4 mb-5">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center text-white text-xl font-bold flex-shrink-0">
              JD
            </div>
            <div>
              <p className="font-medium text-slate-700">Profile Photo</p>
              <button
                id="change-photo-btn"
                className="text-blue-600 hover:text-blue-700 text-sm mt-0.5 transition-colors"
              >
                Change photo (demo)
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="settings-name" className="block text-xs font-medium text-slate-500 mb-1.5">
                Full Name
              </label>
              <input
                id="settings-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
              />
            </div>
            <div>
              <label htmlFor="settings-email" className="block text-xs font-medium text-slate-500 mb-1.5">
                Email Address
              </label>
              <input
                id="settings-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
              />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="settings-business" className="block text-xs font-medium text-slate-500 mb-1.5">
                Business Name
              </label>
              <input
                id="settings-business"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
              />
            </div>
          </div>
        </section>

        {/* Invoice Preferences */}
        <section className="bg-white rounded-2xl ring-1 ring-slate-200 p-6">
          <h2 className="font-semibold text-slate-900 mb-5">Invoice Preferences</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label htmlFor="settings-currency" className="block text-xs font-medium text-slate-500 mb-1.5">
                Currency
              </label>
              <select
                id="settings-currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition bg-white"
              >
                <option value="USD">USD — US Dollar</option>
                <option value="EUR">EUR — Euro</option>
                <option value="GBP">GBP — British Pound</option>
                <option value="CAD">CAD — Canadian Dollar</option>
                <option value="AUD">AUD — Australian Dollar</option>
                <option value="INR">INR — Indian Rupee</option>
              </select>
            </div>
            <div>
              <label htmlFor="settings-terms" className="block text-xs font-medium text-slate-500 mb-1.5">
                Default Payment Terms
              </label>
              <select
                id="settings-terms"
                value={paymentTerms}
                onChange={(e) => setPaymentTerms(e.target.value)}
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition bg-white"
              >
                <option value="7">Net 7 days</option>
                <option value="14">Net 14 days</option>
                <option value="30">Net 30 days</option>
                <option value="60">Net 60 days</option>
              </select>
            </div>
            <div>
              <label htmlFor="settings-tax" className="block text-xs font-medium text-slate-500 mb-1.5">
                Default Tax Rate (%)
              </label>
              <input
                id="settings-tax"
                type="number"
                min={0}
                max={100}
                value={taxRate}
                onChange={(e) => setTaxRate(e.target.value)}
                className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
              />
            </div>
          </div>
        </section>

        {/* Notifications */}
        <section className="bg-white rounded-2xl ring-1 ring-slate-200 p-6">
          <h2 className="font-semibold text-slate-900 mb-5">Notifications & AI</h2>
          <div className="space-y-4">
            {/* Toggle: Email reminders */}
            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-sm font-medium text-slate-800">Email reminders</p>
                <p className="text-slate-400 text-xs">
                  Get email notifications when invoices are due or overdue
                </p>
              </div>
              <button
                id="toggle-email-reminders"
                onClick={() => setEmailReminders(!emailReminders)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  emailReminders ? "bg-blue-600" : "bg-slate-300"
                }`}
                role="switch"
                aria-checked={emailReminders}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                    emailReminders ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>

            {/* Toggle: AI auto follow-up */}
            <div className="flex items-center justify-between py-2 border-t border-slate-100">
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-slate-800">
                    AI auto follow-ups
                  </p>
                  <span className="text-xs bg-violet-100 text-violet-600 font-medium px-2 py-0.5 rounded-full">
                    Coming Soon
                  </span>
                </div>
                <p className="text-slate-400 text-xs">
                  Let AI automatically send follow-up reminders for overdue
                  invoices
                </p>
              </div>
              <button
                id="toggle-auto-followup"
                onClick={() => setAutoFollowUp(!autoFollowUp)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  autoFollowUp ? "bg-blue-600" : "bg-slate-300"
                }`}
                role="switch"
                aria-checked={autoFollowUp}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                    autoFollowUp ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
          </div>
        </section>

        {/* PayPal Integration (placeholder) */}
        <section className="bg-white rounded-2xl ring-1 ring-slate-200 p-6">
          <div className="flex items-center gap-2 mb-1">
            <h2 className="font-semibold text-slate-900">PayPal Integration</h2>
            <span className="text-xs bg-amber-100 text-amber-700 font-medium px-2 py-0.5 rounded-full">
              Coming in Stage 2
            </span>
          </div>
          <p className="text-slate-500 text-sm mb-4">
            Connect your PayPal account to accept payments directly from invoices.
          </p>
          <button
            id="connect-paypal-btn"
            disabled
            className="flex items-center gap-2 border border-slate-200 text-slate-400 text-sm font-medium px-4 py-2.5 rounded-xl cursor-not-allowed opacity-60"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M20.067 8.478c.492.315.844.825.983 1.43.455 2.006-.893 4.1-3.012 4.715-.448.13-.903.193-1.357.193h-1.75l-.46 2.918H12.56l1.855-11.734h3.418c.93 0 1.742.162 2.234.478zM8.386 4h4.142c1.51 0 2.82.517 3.553 1.38.74.87.964 2.065.627 3.418-.338 1.354-1.267 2.544-2.536 3.24-.625.345-1.32.518-2.018.518H9.97L8.953 18h-2.2L8.386 4z" />
            </svg>
            Connect PayPal (disabled in demo)
          </button>
        </section>

        {/* Save button */}
        <div className="flex justify-end pb-8">
          <button
            id="settings-save-btn"
            onClick={handleSave}
            className={`flex items-center gap-2 text-sm font-medium px-6 py-2.5 rounded-xl transition-all ${
              saved
                ? "bg-emerald-500 text-white"
                : "bg-blue-600 hover:bg-blue-700 text-white shadow-sm shadow-blue-200"
            }`}
          >
            {saved ? (
              <>✓ Saved! (Demo)</>
            ) : (
              "Save Changes"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
