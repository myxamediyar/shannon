"use client";

import { useEffect, useState } from "react";
import Sidebar from "./Sidebar";
import { useSettings } from "../lib/use-settings";

export default function DashboardShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const { settings } = useSettings();

  useEffect(() => {
    const root = document.documentElement;
    if (settings.lightTheme) {
      root.classList.remove("dark");
      root.classList.add("light");
    } else {
      root.classList.remove("light");
      root.classList.add("dark");
    }
  }, [settings.lightTheme]);

  return (
    <>
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <div className="flex flex-col h-screen overflow-hidden">
        <main className="flex-1 overflow-y-auto bg-[var(--th-bg)] min-h-0">
          {children}
        </main>
      </div>
    </>
  );
}
