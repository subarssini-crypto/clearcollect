import type { Metadata } from "next";
import CustomerAuthForm from "@/components/CustomerAuthForm";
import PortalAuthLayout from "@/components/PortalAuthLayout";

export const metadata: Metadata = { title: "Customer sign in — ClearCollect" };

export default function PortalLoginPage() {
  return (
    <PortalAuthLayout title="Sign in" subtitle="See your invoices, pay securely with PayPal, and review your payment history.">
      <CustomerAuthForm mode="login" />
    </PortalAuthLayout>
  );
}
