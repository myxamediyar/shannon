// Platform adapters. Only file allowed to reference Tauri internals or
// import from @tauri-apps/*. Components and pages should import from here.

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function openLink(url: string): Promise<void> {
  if (isTauri) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener");
}
