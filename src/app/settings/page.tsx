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
    <div className="mx-auto w-full max-w-[1440px] px-4 py-5 sm:px-6 lg:px-8">
      <div className="mb-4">
        <h1 className="text-xl font-bold tracking-tight text-navy">Settings</h1>
        <p className="text-muted text-[13px] mt-0.5">
          Configure your account and invoice preferences.{" "}
          <span className="text-amber-600 font-medium">
            ⚠ Demo mode — no data is saved.
          </span>
        </p>
      </div>

      <div className="grid max-w-[1100px] items-start gap-4 lg:grid-cols-2">
        {/* Profile */}
        <section className="card p-4">
          <h2 className="text-sm font-semibold text-navy mb-3">Profile</h2>
          <div className="flex items-center gap-4 mb-4">
            <div className="w-11 h-11 rounded-full bg-brand flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
              JD
            </div>
            <div>
              <p className="text-[13px] font-medium text-navy">Profile photo</p>
              <button
                id="change-photo-btn"
                className="text-brand hover:text-brand-ink text-xs mt-0.5 transition-colors"
              >
                Change photo (demo)
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="settings-name" className="block text-xs font-medium text-muted mb-1">
                Full Name
              </label>
              <input
                id="settings-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full border border-line rounded-lg px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand transition"
              />
            </div>
            <div>
              <label htmlFor="settings-email" className="block text-xs font-medium text-muted mb-1">
                Email Address
              </label>
              <input
                id="settings-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full border border-line rounded-lg px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand transition"
              />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="settings-business" className="block text-xs font-medium text-muted mb-1">
                Business Name
              </label>
              <input
                id="settings-business"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                className="w-full border border-line rounded-lg px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand transition"
              />
            </div>
          </div>
        </section>

        {/* Invoice Preferences */}
        <section className="card p-4">
          <h2 className="text-sm font-semibold text-navy mb-3">Invoice Preferences</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label htmlFor="settings-currency" className="block text-xs font-medium text-muted mb-1">
                Currency
              </label>
              <select
                id="settings-currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="w-full border border-line rounded-lg px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand transition bg-surface"
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
              <label htmlFor="settings-terms" className="block text-xs font-medium text-muted mb-1">
                Default Payment Terms
              </label>
              <select
                id="settings-terms"
                value={paymentTerms}
                onChange={(e) => setPaymentTerms(e.target.value)}
                className="w-full border border-line rounded-lg px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand transition bg-surface"
              >
                <option value="7">Net 7 days</option>
                <option value="14">Net 14 days</option>
                <option value="30">Net 30 days</option>
                <option value="60">Net 60 days</option>
              </select>
            </div>
            <div>
              <label htmlFor="settings-tax" className="block text-xs font-medium text-muted mb-1">
                Default Tax Rate (%)
              </label>
              <input
                id="settings-tax"
                type="number"
                min={0}
                max={100}
                value={taxRate}
                onChange={(e) => setTaxRate(e.target.value)}
                className="w-full border border-line rounded-lg px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand transition"
              />
            </div>
          </div>
        </section>

        {/* Notifications */}
        <section className="card p-4">
          <h2 className="text-sm font-semibold text-navy mb-3">Notifications & AI</h2>
          <div className="space-y-4">
            {/* Toggle: Email reminders */}
            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-sm font-medium text-navy">Email reminders</p>
                <p className="text-slate-400 text-xs">
                  Get email notifications when invoices are due or overdue
                </p>
              </div>
              <button
                id="toggle-email-reminders"
                onClick={() => setEmailReminders(!emailReminders)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  emailReminders ? "bg-brand" : "bg-slate-300"
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
            <div className="flex items-center justify-between py-2 border-t border-line">
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-navy">
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
                  autoFollowUp ? "bg-brand" : "bg-slate-300"
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

        {/* Payments */}
        <section className="card p-4">
          <div className="flex items-center gap-2 mb-1">
            <h2 className="text-sm font-semibold text-navy">Online payments</h2>
            <span className="text-[11px] bg-emerald-50 text-emerald-700 font-semibold px-2 py-0.5 rounded-full">
              Sandbox
            </span>
          </div>
          <p className="text-muted text-[13px]">
            PayPal checkout is configured on the server through environment variables. Clients pay sent or
            overdue invoices from the Invoices page, and invoices are marked paid only after a verified capture.
          </p>
        </section>

        {/* Save button */}
        <div className="flex justify-end pb-6 lg:col-span-2">
          <button
            id="settings-save-btn"
            onClick={handleSave}
            className={`flex items-center gap-2 text-[13px] font-semibold px-4 py-2 rounded-lg transition-all ${
              saved
                ? "bg-emerald-500 text-white"
                : "bg-brand hover:bg-brand-dark text-white"
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
