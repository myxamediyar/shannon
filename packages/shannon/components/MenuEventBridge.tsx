"use client";

// Listens for native-menu events emitted by the Tauri shell (lib.rs's
// on_menu_event) and routes them to existing in-app actions. Mounted once
// at the dashboard root; no-op outside Tauri. Each handler reuses the same
// code paths the Sidebar / NotesCanvas use, so menu items behave
// identically to in-app buttons.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { isTauri } from "../lib/platform";
import {
  getNote,
  writeNote,
  readNoteCounter,
  writeNoteCounter,
} from "../lib/platform/notes-storage";
import { saveBlobWithDialog } from "../lib/platform/save";
import { syncRecentsToMenu } from "../lib/platform/recents";
import { prepareNotesForDisplay } from "../lib/canvas-blob-store";
import { exportNoteAsShannon, importShannonNote } from "../lib/canvas-export-shannon";
import { requestExportHtml, requestPrint } from "../lib/canvas-actions-store";
import { toggleSidebar } from "../lib/sidebar-store";
import { makeNote } from "../lib/canvas-utils";

function activeNoteId(): string | null {
  if (typeof window === "undefined") return null;
  return new URL(window.location.href).searchParams.get("id");
}

function sanitizeFilename(name: string): string {
  return (name || "Untitled").replace(/[\\/?%*:|"<>]/g, "-").trim().slice(0, 100) || "Untitled";
}

export default function MenuEventBridge() {
  const router = useRouter();

  useEffect(() => {
    if (!isTauri) return;
    let unsubs: Array<() => void> = [];
    let cancelled = false;

    (async () => {
      const { listen } = await import("@tauri-apps/api/event");

      const wire = async (name: string, handler: () => void | Promise<void>) => {
        const off = await listen(name, () => { void handler(); });
        if (cancelled) { off(); return; }
        unsubs.push(off);
      };

      // Type-tolerant variant for events that carry a payload.
      const wireWith = async <T,>(name: string, handler: (payload: T) => void | Promise<void>) => {
        const off = await listen<T>(name, (e) => { void handler(e.payload); });
        if (cancelled) { off(); return; }
        unsubs.push(off);
      };

      // Push recents from ~/.shannon/recents.json into the native menu so
      // File → Open Recent is populated on first menu open.
      void syncRecentsToMenu();

      await wire("menu:new-note", async () => {
        const counter = await readNoteCounter();
        const note = makeNote(counter);
        await writeNoteCounter(counter + 1);
        await writeNote(note);
        router.push(`/notes?id=${note.id}`, { scroll: false });
      });

      await wire("menu:open", async () => {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const picked = await open({
          multiple: false,
          filters: [{ name: "Shannon Note", extensions: ["shannon"] }],
        });
        if (!picked || typeof picked !== "string") return;
        const { readTextFile } = await import("@tauri-apps/plugin-fs");
        const text = await readTextFile(picked);
        const blob = new Blob([text], { type: "application/json" });
        const note = await importShannonNote(blob);
        await writeNote(note);
        router.push(`/notes?id=${note.id}`, { scroll: false });
      });

      await wire("menu:export-shannon", async () => {
        const id = activeNoteId();
        if (!id) return;
        const found = getNote(id);
        if (!found) return;
        const { notes } = await prepareNotesForDisplay([found]);
        const note = notes[0];
        if (!note) return;
        const blob = await exportNoteAsShannon(note);
        await saveBlobWithDialog(
          blob,
          `${sanitizeFilename(note.title)}.shannon`,
          [{ name: "Shannon Note", extensions: ["shannon"] }],
        );
      });

      await wire("menu:export-html", () => {
        const id = activeNoteId();
        if (!id) return;
        requestExportHtml(id);
      });

      await wire("menu:print", () => {
        // Park a print request; the canvas subscribes and runs it against
        // the currently-selected region (else falls back to the first one).
        // The canvas owns selection hide/restore, which we have no access to
        // from here.
        const id = activeNoteId();
        if (!id) return;
        requestPrint(id);
      });

      await wire("menu:reveal-data-dir", async () => {
        const { homeDir, join } = await import("@tauri-apps/api/path");
        const dir = await join(await homeDir(), ".shannon");
        const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
        await revealItemInDir(dir);
      });

      await wire("menu:toggle-sidebar", () => {
        toggleSidebar();
      });

      await wireWith<string>("menu:open-recent", (noteId) => {
        if (!noteId) return;
        router.push(`/notes?id=${noteId}`, { scroll: false });
      });
    })();

    return () => {
      cancelled = true;
      for (const off of unsubs) off();
      unsubs = [];
    };
  }, [router]);

  return null;
}
