"use client";

import { usePathname } from "next/navigation";

export default function TopBar() {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);
  const breadcrumb =
    segments.length === 0
      ? "Overview / Dashboard"
      : segments.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" / ");

  return (
    <header className="h-16 bg-[var(--th-bg)]/80 backdrop-blur-md flex items-center justify-between px-8 shrink-0 border-b border-[var(--th-border-20)] z-40" style={{ boxShadow: `0 1px 6px var(--th-shadow)` }}>
      <span className="font-lexend text-[0.6875rem] text-[var(--th-text-muted)] font-medium tracking-wider uppercase">
        {breadcrumb}
      </span>

      <div />
    </header>
  );
}
