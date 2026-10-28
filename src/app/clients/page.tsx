
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { EMAIL_STATUS_LABEL, INVITE_STATUS_LABEL, InviteCustomerDialog } from "@/components/InviteCustomerDialog";
import { btnPrimary } from "@/components/ui";

type PortalSummary = {
  linkedAccounts: number;
  latestInvite: { status: keyof typeof INVITE_STATUS_LABEL; email: keyof typeof EMAIL_STATUS_LABEL } | null;
};

type Client = {
  id: number;
  name: string;
  email: string | null;
  company: string | null;
  createdAt: string;
  archivedAt?: string | null;
  _count?: {
    invoices: number;
  };
  portal?: PortalSummary;
};

/** Customer Portal state on a client card: linked accounts, else the latest invitation. */
function PortalStatus({ portal }: { portal?: PortalSummary }) {
  if (!portal) return <span />;
  if (portal.linkedAccounts > 0) {
    return (
      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
        Portal: {portal.linkedAccounts} linked
      </span>
    );
  }
  const invite = portal.latestInvite;
  if (!invite) return <span className="text-[11px] text-muted">Not invited</span>;
  const label = INVITE_STATUS_LABEL[invite.status];
  const failed = invite.status === "pending" && invite.email === "failed";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${failed ? "bg-red-50 text-red-700" : label.className}`}>
      Invite {failed ? "email failed" : label.text.toLowerCase()}
    </span>
  );
}

type Invoice = {
  id: number;
  clientId: number;
  amount: string | number;
  currency: string;
  status: string;
  issueDate: string;
  invoiceNumber: string;
};

type ApiResponse<T> = {
  ok: boolean;
  data?: T;
  error?: string;
  errors?: { field: string; message: string }[];
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

function getInitials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

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

export default function ClientsPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [pageError, setPageError] = useState("");

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");

  // Active clients by default; archived clients keep their invoices and can be restored.
  const [view, setView] = useState<"active" | "archived">("active");
  const [archiveTarget, setArchiveTarget] = useState<Client | null>(null);
  const [archiveBusy, setArchiveBusy] = useState<number | null>(null);
  const [archiveError, setArchiveError] = useState("");
  const [notice, setNotice] = useState("");
  const clientsUrl = view === "archived" ? "/api/clients?archived=true" : "/api/clients";

  // Customer Portal invitations: the owner explicitly authorizes who can see a client's invoices.
  const [inviteTarget, setInviteTarget] = useState<Client | null>(null);

  async function setArchived(client: Client, archived: boolean) {
    if (archiveBusy !== null) return;
    setArchiveBusy(client.id);
    setArchiveError("");
    setNotice("");
    try {
      const response = await fetch(`/api/clients/${client.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived }),
      });
      let result: ApiResponse<Client> & { message?: string } = { ok: false };
      try {
        result = await response.json();
      } catch {
        result = { ok: false, error: `The server returned an unexpected response (HTTP ${response.status}).` };
      }
      if (!response.ok || !result.ok) {
        throw new Error(result.errors?.map((e) => e.message).join(" ") || result.error || "The client was not updated.");
      }
      // It now belongs to the other tab.
      setClients((current) => current.filter((c) => c.id !== client.id));
      setNotice(result.message || `${client.name} ${archived ? "archived" : "restored"}.`);
      setArchiveTarget(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The client was not updated.";
      if (archived) setArchiveError(message);
      else setPageError(message);
    } finally {
      setArchiveBusy(null);
    }
  }

  // Load clients and invoices from the database.
  useEffect(() => {
    let cancelled = false;

    async function fetchData() {
      try {
        const [clientsResponse, invoicesResponse] = await Promise.all([
          fetch(clientsUrl),
          fetch("/api/invoices?limit=100"),
        ]);

        const clientsResult: ApiResponse<Client[]> =
          await clientsResponse.json();

        const invoicesResult: ApiResponse<Invoice[]> =
          await invoicesResponse.json();

        if (
          !clientsResponse.ok ||
          !clientsResult.ok ||
          !clientsResult.data
        ) {
          throw new Error("Could not load clients from the database.");
        }

        if (
          !invoicesResponse.ok ||
          !invoicesResult.ok ||
          !invoicesResult.data
        ) {
          throw new Error("Could not load invoice statistics.");
        }

        if (!cancelled) {
          setClients(clientsResult.data);
          setInvoices(invoicesResult.data);
        }
      } catch (error) {
        if (!cancelled) {
          setPageError(
            error instanceof Error
              ? error.message
              : "Something went wrong while loading clients."
          );
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void fetchData();

    return () => {
      cancelled = true;
    };
  }, [clientsUrl]);

  async function refreshData() {
    const [clientsResponse, invoicesResponse] = await Promise.all([
      fetch(clientsUrl),
      fetch("/api/invoices?limit=100"),
    ]);

    const clientsResult: ApiResponse<Client[]> =
      await clientsResponse.json();

    const invoicesResult: ApiResponse<Invoice[]> =
      await invoicesResponse.json();

    if (
      !clientsResponse.ok ||
      !clientsResult.ok ||
      !clientsResult.data
    ) {
      throw new Error("Client was saved, but refreshing clients failed.");
    }

    if (
      !invoicesResponse.ok ||
      !invoicesResult.ok ||
      !invoicesResult.data
    ) {
      throw new Error("Client was saved, but refreshing invoice data failed.");
    }

    setClients(clientsResult.data);
    setInvoices(invoicesResult.data);
  }

  async function handleAddClient(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();
    setFormError("");

    if (!name.trim()) {
      setFormError("Please enter the client's name.");
      return;
    }

    setIsSaving(true);

    try {
      const response = await fetch("/api/clients", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim() || null,
          company: company.trim() || null,
        }),
      });

      const result: ApiResponse<Client> = await response.json();

      if (!response.ok || !result.ok || !result.data) {
        const message =
          result.errors?.map((item) => item.message).join(" ") ||
          result.error ||
          "Could not create the client.";

        throw new Error(message);
      }

      setName("");
      setEmail("");
      setCompany("");
      setIsModalOpen(false);

      try {
        await refreshData();
        setPageError("");
      } catch (error) {
        setPageError(
          error instanceof Error
            ? error.message
            : "Client was saved, but refreshing the list failed."
        );
      }
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : "Something went wrong while adding the client."
      );
    } finally {
      setIsSaving(false);
    }
  }

  function getClientInvoices(clientId: number) {
    return invoices.filter((invoice) => invoice.clientId === clientId);
  }

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-5 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-navy">Clients</h1>
          <p className="text-muted text-[13px] mt-0.5">
            View and manage your clients stored in the database.
          </p>
        </div>

        <button
          id="add-client-btn"
          onClick={() => {
            setFormError("");
            setIsModalOpen(true);
          }}
          className="flex items-center gap-2 bg-brand hover:bg-brand-dark text-white text-[13px] font-semibold px-3.5 py-2 rounded-lg transition-colors whitespace-nowrap"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 4v16m8-8H4"
            />
          </svg>
          Add Client
        </button>
      </div>

      {pageError && (
        <div
          role="alert"
          className="mb-4 rounded-lg bg-red-50 p-4 text-sm text-red-700 ring-1 ring-red-200"
        >
          {pageError}
          <button
            onClick={() => window.location.reload()}
            className="ml-2 font-semibold underline"
          >
            Refresh page
          </button>
        </div>
      )}

      {/* Active / archived filter */}
      <div className="flex flex-wrap gap-1 mb-4 bg-slate-100 p-1 rounded-lg w-fit" role="group" aria-label="Client list">
        {(["active", "archived"] as const).map((tab) => (
          <button
            key={tab}
            id={`clients-tab-${tab}`}
            onClick={() => {
              setNotice("");
              if (tab === view) return;
              setPageError("");
              setIsLoading(true);
              setView(tab);
            }}
            aria-pressed={view === tab}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${view === tab ? "bg-surface text-navy shadow-sm" : "text-muted hover:text-slate-700"}`}
          >
            {tab === "active" ? "Active" : "Archived"}
          </button>
        ))}
      </div>

      {notice && (
        <div role="status" className="mb-4 rounded-lg bg-emerald-50 p-4 text-sm text-emerald-700 ring-1 ring-emerald-200">
          {notice}
        </div>
      )}

      {inviteTarget && (
        <InviteCustomerDialog
          clientId={inviteTarget.id}
          clientName={inviteTarget.name}
          onClose={() => setInviteTarget(null)}
          onChanged={() => {
            refreshData().catch(() => {});
          }}
        />
      )}

      {archiveTarget && (
        <ConfirmDialog
          id="archive-client"
          title={`Archive ${archiveTarget.name}?`}
          confirmLabel="Archive client"
          busyLabel="Archiving…"
          busy={archiveBusy === archiveTarget.id}
          error={archiveError}
          onConfirm={() => setArchived(archiveTarget, true)}
          onCancel={() => setArchiveTarget(null)}
        >
          <p>
            <span className="font-semibold text-navy">{archiveTarget.name}</span>
            {archiveTarget.email ? ` (${archiveTarget.email})` : ""} will be hidden from client selection for new invoices.
          </p>
          <p>
            All {archiveTarget._count?.invoices ?? 0} invoice(s), payments, and reminders are kept unchanged. You can restore the client from the Archived tab at any time.
          </p>
        </ConfirmDialog>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="card p-10 text-center text-[13px] text-muted">
          Loading clients from the database...
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !pageError && clients.length === 0 && (
        <div className="card p-10 text-center">
          <h2 className="font-semibold text-navy">{view === "archived" ? "No archived clients" : "No clients yet"}</h2>
          <p className="mt-2 text-sm text-muted">
            {view === "archived"
              ? "Archived clients appear here and can be restored."
              : "Add your first client to start creating invoices."}
          </p>
        </div>
      )}

      {/* Client cards */}
      {!isLoading && !pageError && clients.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {clients.map((client, index) => {
            const clientInvoices = getClientInvoices(client.id);

            const totalInvoiced = clientInvoices.reduce(
              (sum, invoice) => sum + Number(invoice.amount),
              0
            );

            const currencies = new Set(
              clientInvoices.map((invoice) => invoice.currency)
            );

            const currency =
              currencies.size === 1
                ? clientInvoices[0]?.currency ?? "USD"
                : null;

            const lastInvoice = clientInvoices.reduce<Invoice | null>(
              (latest, invoice) => {
                if (!latest) return invoice;

                return new Date(invoice.issueDate) >
                  new Date(latest.issueDate)
                  ? invoice
                  : latest;
              },
              null
            );

            return (
              <div
                key={client.id}
                id={`client-card-${client.id}`}
                className="card flex flex-col hover:border-brand-100 p-4 transition-all duration-200"
              >
                <div className="flex items-start justify-between mb-4 gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`w-11 h-11 rounded-lg flex items-center justify-center text-sm font-bold flex-shrink-0 ${avatarColors[index % avatarColors.length]
                        }`}
                    >
                      {getInitials(client.name)}
                    </div>

                    <div className="min-w-0">
                      <h3 className="font-semibold text-navy break-words">
                        {client.name}
                      </h3>
                      <p className="text-slate-400 text-xs truncate">
                        {client.email || "No email provided"}
                      </p>
                    </div>
                  </div>

                  {client.archivedAt ? (
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                      Archived
                    </span>
                  ) : (
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">
                      Client
                    </span>
                  )}
                </div>

                {client.company && client.company !== client.name && (
                  <p className="text-xs text-muted mb-4">
                    {client.company}
                  </p>
                )}

                <div className="grid grid-cols-2 gap-3 text-sm mb-4">
                  <div className="bg-canvas rounded-lg p-3">
                    <p className="text-slate-400 text-xs mb-0.5">
                      Total Invoiced
                    </p>
                    <p className="font-bold text-navy">
                      {currency
                        ? formatMoney(totalInvoiced, currency)
                        : currencies.size > 1
                          ? "Multiple currencies"
                          : formatMoney(0, "USD")}
                    </p>
                  </div>

                  <div className="bg-canvas rounded-lg p-3">
                    <p className="text-slate-400 text-xs mb-0.5">
                      Invoices
                    </p>
                    <p className="font-bold text-navy">
                      {client._count?.invoices ?? clientInvoices.length}
                    </p>
                  </div>
                </div>

                {!client.archivedAt && (
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <PortalStatus portal={client.portal} />
                    <button
                      type="button"
                      id={`invite-client-${client.id}`}
                      onClick={() => setInviteTarget(client)}
                      className={`${btnPrimary} py-1.5 text-xs`}
                    >
                      Invite Customer
                    </button>
                  </div>
                )}

                <div className="mt-auto flex items-center justify-between gap-3 text-xs text-slate-400 border-t border-line pt-3">
                  <span>
                    {lastInvoice
                      ? `Last invoice: ${formatDate(lastInvoice.issueDate)}`
                      : "No invoices yet"}
                  </span>

                  {client.archivedAt ? (
                    <button
                      type="button"
                      id={`restore-client-${client.id}`}
                      onClick={() => setArchived(client, false)}
                      disabled={archiveBusy !== null}
                      className="text-brand hover:text-brand-ink font-medium transition-colors whitespace-nowrap disabled:opacity-50"
                    >
                      {archiveBusy === client.id ? "Restoring…" : "Restore"}
                    </button>
                  ) : (
                    <span className="flex items-center gap-3">
                      <button
                        type="button"
                        id={`archive-client-${client.id}`}
                        onClick={() => {
                          setArchiveError("");
                          setArchiveTarget(client);
                        }}
                        className="text-muted hover:text-navy font-medium transition-colors whitespace-nowrap"
                      >
                        Archive
                      </button>
                      <Link
                        href="/create-invoice"
                        className="text-brand hover:text-brand-ink font-medium transition-colors whitespace-nowrap"
                      >
                        + Invoice
                      </Link>
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add Client modal */}
      {isModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !isSaving) {
              setIsModalOpen(false);
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-client-title"
            className="w-full max-w-md rounded-lg bg-surface p-5 shadow-xl"
          >
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2
                  id="add-client-title"
                  className="text-lg font-bold text-navy"
                >
                  Add Client
                </h2>
                <p className="mt-1 text-sm text-muted">
                  Client details will be saved to MySQL.
                </p>
              </div>

              <button
                type="button"
                aria-label="Close dialog"
                disabled={isSaving}
                onClick={() => setIsModalOpen(false)}
                className="rounded-lg px-2 py-1 text-xl text-slate-400 hover:bg-slate-100 disabled:opacity-50"
              >
                ×
              </button>
            </div>

            <form onSubmit={handleAddClient} className="space-y-4">
              <div>
                <label
                  htmlFor="new-client-name"
                  className="mb-1 block text-xs font-medium text-muted"
                >
                  Client Name *
                </label>
                <input
                  id="new-client-name"
                  required
                  maxLength={191}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Acme Corp"
                  className="w-full rounded-lg border border-line px-3 py-2 text-[13px] outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/15"
                />
              </div>

              <div>
                <label
                  htmlFor="new-client-company"
                  className="mb-1 block text-xs font-medium text-muted"
                >
                  Company
                </label>
                <input
                  id="new-client-company"
                  maxLength={191}
                  value={company}
                  onChange={(event) => setCompany(event.target.value)}
                  placeholder="Company name (optional)"
                  className="w-full rounded-lg border border-line px-3 py-2 text-[13px] outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/15"
                />
              </div>

              <div>
                <label
                  htmlFor="new-client-email"
                  className="mb-1 block text-xs font-medium text-muted"
                >
                  Email
                </label>
                <input
                  id="new-client-email"
                  type="email"
                  maxLength={191}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="billing@example.com"
                  className="w-full rounded-lg border border-line px-3 py-2 text-[13px] outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/15"
                />
              </div>

              {formError && (
                <p
                  role="alert"
                  className="rounded-lg bg-red-50 p-3 text-sm text-red-700"
                >
                  {formError}
                </p>
              )}

              <div className="flex justify-end gap-3 border-t border-line pt-4">
                <button
                  type="button"
                  disabled={isSaving}
                  onClick={() => setIsModalOpen(false)}
                  className="rounded-lg border border-line px-3.5 py-2 text-[13px] font-semibold text-slate-600 hover:bg-canvas disabled:opacity-50"
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  disabled={isSaving}
                  className="rounded-lg bg-brand px-3.5 py-2 text-sm font-medium text-white transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSaving ? "Saving..." : "Save Client"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
