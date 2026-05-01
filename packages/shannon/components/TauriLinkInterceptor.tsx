"use client";

import { useEffect } from "react";
import { isTauri, openLink } from "@/lib/platform";
import { initializeNotesStorage } from "@/lib/platform/notes-storage";
import { initializeBlobStorage } from "@/lib/platform/blob-storage";

export default function TauriLinkInterceptor() {
  // Kick off both storage layers early so their pub/sub stores are populated
  // before any subscriber's first render. Subscribers read via
  // useSyncExternalStore and re-render automatically once init completes.
  useEffect(() => {
    void initializeNotesStorage();
    void initializeBlobStorage();
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
