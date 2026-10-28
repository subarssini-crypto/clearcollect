import type { Metadata } from "next";
import { Suspense } from "react";
import PortalDashboard from "./PortalDashboard";

export const metadata: Metadata = { title: "Customer Portal — ClearCollect", robots: { index: false, follow: false } };

// Signed-in customers only (src/proxy.ts); every API it calls checks the session itself.
export default function PortalPage() {
  return (
    <Suspense fallback={<p className="p-8 text-center text-sm text-muted">Loading your portal…</p>}>
      <PortalDashboard />
    </Suspense>
  );
}
