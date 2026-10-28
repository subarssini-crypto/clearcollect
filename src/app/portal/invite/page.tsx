import type { Metadata } from "next";
import PortalAuthLayout from "@/components/PortalAuthLayout";
import InviteRedeem from "./InviteRedeem";

export const metadata: Metadata = { title: "Customer Portal invite — ClearCollect", robots: { index: false, follow: false } };

export default function PortalInvitePage() {
  return (
    <PortalAuthLayout title="You’re invited" subtitle="Link a Customer Portal account to see and pay your invoices in one place.">
      <InviteRedeem />
    </PortalAuthLayout>
  );
}
