"use client";

import { useEffect, useSyncExternalStore } from "react";
import Sidebar from "./Sidebar";
import MenuEventBridge from "./MenuEventBridge";
import { useSettings } from "../lib/use-settings";
import {
  subscribeSidebarCollapsed,
  getSidebarCollapsedSnapshot,
  toggleSidebar,
} from "../lib/sidebar-store";

export default function DashboardShell({ children }: { children: React.ReactNode }) {
  // Lifted to a module store so the native menu's Toggle Sidebar item can
  // flip it from outside the React tree.
  const collapsed = useSyncExternalStore(
    subscribeSidebarCollapsed,
    getSidebarCollapsedSnapshot,
    () => false,
  );
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
      <MenuEventBridge />
      <Sidebar collapsed={collapsed} onToggle={toggleSidebar} />
      <div className="flex flex-col h-screen overflow-hidden">
        <main className="flex-1 overflow-y-auto bg-[var(--th-bg)] min-h-0">
          {children}
        </main>
      </div>
    </>
  );
}
