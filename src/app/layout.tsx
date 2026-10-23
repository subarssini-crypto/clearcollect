import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import AppShell from "@/components/AppShell";
import { THEME_INIT_SCRIPT } from "@/lib/theme";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ClearCollect — AI-Powered Invoicing",
  description:
    "ClearCollect is an AI-powered invoicing and payment follow-up tool for freelancers and small businesses. Built for the PayPal AI Hackathon.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // data-theme is corrected by the inline script before first paint (saved
    // choice, else the OS preference), so the DOM may differ from this default.
    <html
      lang="en"
      data-theme="light"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="h-full overflow-hidden bg-canvas">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
