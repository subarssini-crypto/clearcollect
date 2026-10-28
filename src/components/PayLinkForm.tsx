"use client";

import { useState, type FormEvent } from "react";
import { btnPrimary, inputClass, labelClass } from "@/components/ui";
import { extractPayToken } from "@/lib/pay-link-input";

/**
 * Opens a secure payment link pasted from an invoice email. Only a /pay/<token>
 * link on this site (or the bare token) is accepted; an invoice number or ID
 * alone grants nothing.
 */
export default function PayLinkForm() {
  const [link, setLink] = useState("");
  const [error, setError] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    const token = extractPayToken(link, window.location.origin);
    if (!token) {
      setError("That doesn’t look like a ClearCollect payment link. Copy the full “Pay” link from your invoice email.");
      return;
    }
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- plain navigation to the public pay page
    window.location.assign(`/pay/${token}`);
  }

  return (
    <form onSubmit={submit} className="space-y-2" noValidate>
      <label htmlFor="pay-link" className={labelClass}>
        Secure payment link from your invoice email
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id="pay-link"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://…/pay/…"
          value={link}
          onChange={(e) => {
            setLink(e.target.value);
            setError("");
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "pay-link-error" : undefined}
          className={inputClass}
        />
        <button type="submit" className={`${btnPrimary} whitespace-nowrap`}>
          Open payment page
        </button>
      </div>
      {error && (
        <p id="pay-link-error" role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
    </form>
  );
}
