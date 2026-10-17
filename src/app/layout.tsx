import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Sidebar from "@/components/Sidebar";

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
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="h-full flex overflow-hidden bg-slate-50">
        <Sidebar />
        {/* Main content area */}
        <main
          id="main-content"
          className="flex-1 overflow-y-auto h-full pl-0 lg:pl-0"
        >
          {children}
        </main>
      </body>
    </html>
  );
}
