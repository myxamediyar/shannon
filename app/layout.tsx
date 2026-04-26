import type { Metadata } from "next";
import { Lexend_Deca } from "next/font/google";
import "./globals.css";
import DashboardShell from "@/components/DashboardShell";

const lexendDeca = Lexend_Deca({
  subsets: ["latin"],
  weight: ["100", "200", "300", "400", "500", "600", "700", "800", "900"],
  display: "swap",
  variable: "--font-lexend",
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
    <html lang="en" className={`dark ${lexendDeca.variable}`} suppressHydrationWarning>
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap"
          rel="stylesheet"
        />

      </head>
      <body className="bg-[var(--th-bg)] text-[var(--th-text)] antialiased overflow-hidden">
        <DashboardShell>{children}</DashboardShell>
      </body>
    </html>
  );
}
