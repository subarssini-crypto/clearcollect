import type { Metadata } from "next";
import CustomerAuthForm from "@/components/CustomerAuthForm";
import PortalAuthLayout from "@/components/PortalAuthLayout";

export const metadata: Metadata = { title: "Create a customer account — ClearCollect" };

export default function PortalSignupPage() {
  return (
    <PortalAuthLayout
      title="Create your account"
      subtitle="Your invoices appear once your account is linked with the invite link sent by the business that bills you."
    >
      <CustomerAuthForm mode="signup" />
    </PortalAuthLayout>
  );
}
