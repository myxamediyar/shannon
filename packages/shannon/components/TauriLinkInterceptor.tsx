"use client";

import { useEffect } from "react";
import { isTauri, openLink } from "@/lib/platform";
// Side-effect import: installs the Storage.prototype patch that routes
// shannon_notes / shannon_folders / shannon_note_counter through the
// platform adapter (filesystem in Tauri, /api/notes etc. in npm CLI mode).
import "@/lib/platform/legacy-storage-patch";
import { initializeNotesStorage } from "@/lib/platform/notes-storage";

export default function TauriLinkInterceptor() {
  // Hydrate the notes storage cache as early as possible so legacy
  // localStorage callsites read filesystem-backed data on first paint.
  useEffect(() => {
    void initializeNotesStorage();
  }, []);

  useEffect(() => {
    if (!isTauri) return;

    const handler = (e: MouseEvent) => {
      const target = e.target as Element | null;
      const a = target?.closest("a");
      if (!a) return;
      const href = a.getAttribute("href");
      if (!href) return;
      if (href.startsWith("http://") || href.startsWith("https://")) {
        e.preventDefault();
        openLink(href).catch((err) =>
          // eslint-disable-next-line no-console
          console.error("[TauriLinkInterceptor] openLink failed:", err),
        );
      }
    };

    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  return null;
}
