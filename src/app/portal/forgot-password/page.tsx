import type { Metadata } from "next";
import PortalAuthLayout from "@/components/PortalAuthLayout";
import ForgotPasswordForm from "./ForgotPasswordForm";

export const metadata: Metadata = { title: "Forgot password — ClearCollect", robots: { index: false, follow: false } };

export default function PortalForgotPasswordPage() {
  return (
    <PortalAuthLayout title="Forgot your password?" subtitle="Enter your account's email address and we'll send you a link to choose a new password.">
      <ForgotPasswordForm />
    </PortalAuthLayout>
  );
}
