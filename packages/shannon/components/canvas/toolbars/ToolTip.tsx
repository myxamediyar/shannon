"use client";

import { type ReactNode, useRef, useState } from "react";

export function ToolTip({ label, shortcut, children }: { label: string; shortcut: string; children: ReactNode }) {
  const [show, setShow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  return (
    <div className="relative"
      onMouseEnter={() => { clear(); timer.current = setTimeout(() => setShow(true), 180); }}
      onMouseLeave={() => { clear(); setShow(false); }}>
      {children}
      {show && (
        <div className="absolute top-[calc(100%+8px)] left-1/2 -translate-x-1/2 pointer-events-none z-50 flex flex-col items-center">
          <div className="w-2 h-2 bg-[var(--th-surface)] border-l border-t border-[var(--th-border)] rotate-45 -mb-[5px]" />
          <div className="bg-[var(--th-surface)] border border-[var(--th-border)] rounded-md px-2.5 py-1.5 flex flex-col items-center gap-0.5 whitespace-nowrap">
            <span className="text-[12px] text-[var(--th-text-secondary)] font-lexend leading-none">{label}</span>
            <span className="text-[10px] text-[var(--th-text-faint)] font-mono leading-none">{shortcut}</span>
          </div>
        </div>
      )}
    </div>
  );
}
