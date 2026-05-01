import type { Metadata } from "next";
import { Lexend_Deca } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";
import DashboardShell from "@/components/DashboardShell";

const lexendDeca = Lexend_Deca({
  subsets: ["latin"],
  weight: ["100", "200", "300", "400", "500", "600", "700", "800", "900"],
  display: "swap",
  variable: "--font-lexend",
});

const materialSymbols = localFont({
  src: "../public/fonts/material-symbols-outlined.woff2",
  display: "block",
  weight: "100 700",
  variable: "--font-material-symbols",
});

export const metadata: Metadata = {
  title: "Shannon",
  description: "The tool for intelligent ideation.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`dark ${lexendDeca.variable} ${materialSymbols.variable}`}
      suppressHydrationWarning
    >
      <body className="bg-[var(--th-bg)] text-[var(--th-text)] antialiased overflow-hidden">
        <DashboardShell>{children}</DashboardShell>
      </body>
    </html>
  );
}
