import type { Metadata } from "next";
import PortalAuthLayout from "@/components/PortalAuthLayout";
import ResetPasswordForm from "./ResetPasswordForm";

// The reset token is in the URL: keep it out of search engines and Referer headers.
export const metadata: Metadata = { title: "Reset password — ClearCollect", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default function PortalResetPasswordPage() {
  return (
    <PortalAuthLayout title="Choose a new password" subtitle="Resetting your password signs you out on every device.">
      <ResetPasswordForm />
    </PortalAuthLayout>
  );
}
