import type { Metadata } from "next";
import { Suspense } from "react";
import PayInvoice from "./PayInvoice";

// Public client payment page; the token in the URL is the credential.
export const metadata: Metadata = {
  title: "Invoice payment — ClearCollect",
  robots: { index: false, follow: false },
};

export default function PayPage() {
  return (
    <Suspense fallback={<p className="p-8 text-center text-sm text-muted">Loading invoice…</p>}>
      <PayInvoice />
    </Suspense>
  );
}
