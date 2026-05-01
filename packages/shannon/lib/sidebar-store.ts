// Module-level sidebar collapsed state, exposed via useSyncExternalStore.
// Originally lived inside DashboardShell as plain useState, but the native
// menu's Toggle Sidebar item needs to flip it from outside the React tree.

let collapsed = false;
const subs = new Set<() => void>();

function notify() {
  for (const l of subs) l();
}

export function subscribeSidebarCollapsed(listener: () => void): () => void {
  subs.add(listener);
  return () => { subs.delete(listener); };
}

export function getSidebarCollapsedSnapshot(): boolean {
  return collapsed;
}

export function setSidebarCollapsed(next: boolean): void {
  if (collapsed === next) return;
  collapsed = next;
  notify();
}

export function toggleSidebar(): void {
  setSidebarCollapsed(!collapsed);
}
