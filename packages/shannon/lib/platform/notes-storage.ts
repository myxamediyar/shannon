// Filesystem-backed notes storage. Replaces localStorage for the three
// shannon_* keys (shannon_notes, shannon_folders, shannon_note_counter).
//
// Layout under ~/.shannon/:
//   notes/<id>.shannon  — one file per note (JSON)
//   folders.json        — folder tree (single JSON object)
//   note-counter.json   — running counter for "Note #N" titles
//
// In Tauri mode the SPA reads/writes those files directly via plugin-fs.
// In web mode (running under bin/shannon.js) the adapter routes through
// /api/notes, /api/folders, /api/counter on the local CLI server, which
// reads/writes the same files.
//
// Strategy: per-note files are loaded into an in-memory Map at startup so
// the React layer can keep its synchronous read-from-state pattern.
// Writes mutate the cache synchronously and queue a per-file write; the
// caller can `await` if they need to know the disk is current.
//
// Migration: on first run, if the filesystem is empty and localStorage
// has data, the localStorage values are drained into the filesystem.
// This is what recovers existing notes after Phase 2d/e changed origins.

import { isTauri } from "./index";
import type { NoteItem } from "@/lib/canvas-types";
import { rawLocalStorageGet } from "./legacy-storage-patch";

const NOTES_DIR = ".shannon/notes";
const FOLDERS_FILE = ".shannon/folders.json";
const COUNTER_FILE = ".shannon/note-counter.json";
const SHANNON_DIR = ".shannon";

const cache = new Map<string, NoteItem>();
let initialized = false;
let initializing: Promise<void> | null = null;

function notify() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("notes:updated"));
  }
}

export function getAllNotes(): NoteItem[] {
  return [...cache.values()];
}

export function getNote(id: string): NoteItem | null {
  return cache.get(id) ?? null;
}

export function isNotesStorageReady(): boolean {
  return initialized;
}

export async function initializeNotesStorage(): Promise<void> {
  if (initialized) return;
  if (initializing) return initializing;
  initializing = (async () => {
    await loadAllFromBackend();
    await migrateFromLocalStorageIfNeeded();
    await loadFoldersIntoCache();
    initialized = true;
    initializing = null;
    // Wake legacy listeners that may have read empty localStorage on mount.
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new StorageEvent("storage", { key: "shannon_notes", newValue: "" }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: "shannon_folders", newValue: "" }),
      );
      window.dispatchEvent(new Event("notes:updated"));
      window.dispatchEvent(new Event("folders:updated"));
    }
  })();
  return initializing;
}

async function loadAllFromBackend(): Promise<void> {
  if (isTauri) {
    const { readDir, readTextFile, exists, mkdir, BaseDirectory } = await import(
      "@tauri-apps/plugin-fs"
    );
    if (!(await exists(NOTES_DIR, { baseDir: BaseDirectory.Home }))) {
      await mkdir(NOTES_DIR, { baseDir: BaseDirectory.Home, recursive: true });
      return;
    }
    const entries = await readDir(NOTES_DIR, { baseDir: BaseDirectory.Home });
    for (const entry of entries) {
      const name = entry.name;
      if (!name || !name.endsWith(".shannon")) continue;
      try {
        const text = await readTextFile(`${NOTES_DIR}/${name}`, {
          baseDir: BaseDirectory.Home,
        });
        const note = JSON.parse(text) as NoteItem;
        if (note && note.id) cache.set(note.id, note);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[shannon] Failed to load note ${name}:`, e);
      }
    }
    return;
  }
  // Web: fetch all from the CLI shell.
  try {
    const res = await fetch("/api/notes");
    if (!res.ok) return;
    const notes = (await res.json()) as NoteItem[];
    if (Array.isArray(notes)) {
      for (const n of notes) if (n && n.id) cache.set(n.id, n);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[shannon] Failed to load notes from /api/notes:", e);
  }
}

async function migrateFromLocalStorageIfNeeded(): Promise<void> {
  if (cache.size > 0) return; // backend already populated
  // Read RAW localStorage — bypasses the Storage.prototype patch so the
  // migration sees the original data the user had stored, not the (empty)
  // adapter cache the patched getItem would otherwise return.
  const raw = rawLocalStorageGet("shannon_notes");
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as NoteItem[];
    if (!Array.isArray(parsed) || parsed.length === 0) return;
    // eslint-disable-next-line no-console
    console.log(
      `[shannon] Migrating ${parsed.length} notes from localStorage to filesystem`,
    );
    for (const note of parsed) {
      if (!note || !note.id) continue;
      cache.set(note.id, note);
      try {
        await writeNoteToBackend(note);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[shannon] Failed to migrate note ${note.id}:`, e);
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[shannon] Notes migration from localStorage failed:", e);
  }
}

export async function writeNote(note: NoteItem): Promise<void> {
  cache.set(note.id, note);
  await writeNoteToBackend(note);
  notify();
}

async function writeNoteToBackend(note: NoteItem): Promise<void> {
  const json = JSON.stringify(note);
  if (isTauri) {
    const { writeTextFile, mkdir, BaseDirectory } = await import(
      "@tauri-apps/plugin-fs"
    );
    await mkdir(NOTES_DIR, { baseDir: BaseDirectory.Home, recursive: true });
    await writeTextFile(`${NOTES_DIR}/${note.id}.shannon`, json, {
      baseDir: BaseDirectory.Home,
    });
    return;
  }
  const res = await fetch(`/api/notes/${encodeURIComponent(note.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: json,
  });
  if (!res.ok) throw new Error(`writeNote failed: ${res.status}`);
}

export async function deleteNote(id: string): Promise<void> {
  cache.delete(id);
  if (isTauri) {
    const { remove, exists, BaseDirectory } = await import("@tauri-apps/plugin-fs");
    const filePath = `${NOTES_DIR}/${id}.shannon`;
    if (await exists(filePath, { baseDir: BaseDirectory.Home })) {
      await remove(filePath, { baseDir: BaseDirectory.Home });
    }
  } else {
    await fetch(`/api/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  notify();
}

/** Diff against current cache and persist additions/changes/deletions. */
export async function saveAllNotes(notes: NoteItem[]): Promise<void> {
  const newIds = new Set(notes.map((n) => n.id));
  // Sync cache eagerly so any interleaved getAllNotes() sees the new state.
  for (const n of notes) cache.set(n.id, n);
  for (const oldId of [...cache.keys()]) {
    if (!newIds.has(oldId)) cache.delete(oldId);
  }
  // Then persist.
  await Promise.all(notes.map((n) => writeNoteToBackend(n)));
  const removed: string[] = [];
  for (const oldId of [...cache.keys()]) {
    if (!newIds.has(oldId)) removed.push(oldId);
  }
  // (the cache deletion already happened above; only need to remove the file)
  await Promise.all(removed.map((id) => deleteNoteFile(id)));
  notify();
}

async function deleteNoteFile(id: string): Promise<void> {
  if (isTauri) {
    const { remove, exists, BaseDirectory } = await import("@tauri-apps/plugin-fs");
    const filePath = `${NOTES_DIR}/${id}.shannon`;
    if (await exists(filePath, { baseDir: BaseDirectory.Home })) {
      await remove(filePath, { baseDir: BaseDirectory.Home });
    }
  } else {
    await fetch(`/api/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
}

// ── Folders (single JSON object) ───────────────────────────────────────────

export async function readFolders<T = unknown>(): Promise<T | null> {
  if (isTauri) {
    const { readTextFile, exists, BaseDirectory } = await import(
      "@tauri-apps/plugin-fs"
    );
    if (await exists(FOLDERS_FILE, { baseDir: BaseDirectory.Home })) {
      const text = await readTextFile(FOLDERS_FILE, { baseDir: BaseDirectory.Home });
      try {
        return JSON.parse(text) as T;
      } catch {
        return null;
      }
    }
  } else {
    try {
      const res = await fetch("/api/folders");
      if (res.ok) return (await res.json()) as T;
    } catch {
      /* fall through to localStorage migration */
    }
  }
  // Migration: bypass the patch and read raw localStorage so we see the
  // user's original data even after the adapter has installed itself.
  const raw = rawLocalStorageGet("shannon_folders");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as T;
      await writeFolders(parsed); // persist forward so we don't migrate twice
      return parsed;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export async function writeFolders<T = unknown>(folders: T): Promise<void> {
  const json = JSON.stringify(folders, null, 2);
  if (isTauri) {
    const { writeTextFile, mkdir, BaseDirectory } = await import(
      "@tauri-apps/plugin-fs"
    );
    await mkdir(SHANNON_DIR, { baseDir: BaseDirectory.Home, recursive: true });
    await writeTextFile(FOLDERS_FILE, json, { baseDir: BaseDirectory.Home });
    return;
  }
  await fetch("/api/folders", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: json,
  });
}

// ── Folders sync cache (for legacy localStorage patch) ─────────────────────
// Sidebar.tsx reads/writes localStorage["shannon_folders"] synchronously in
// many places. The adapter is async, so we keep a synchronous mirror that
// the patched Storage.prototype.getItem returns.

let foldersCache: string | null = null;

export async function loadFoldersIntoCache(): Promise<void> {
  const folders = await readFolders<unknown>();
  foldersCache = folders ? JSON.stringify(folders) : null;
}

export function getFoldersStringSync(): string | null {
  return foldersCache;
}

export async function writeFoldersFromString(json: string): Promise<void> {
  foldersCache = json;
  try {
    const parsed = JSON.parse(json);
    await writeFolders(parsed);
  } catch {
    /* malformed input — leave cache, skip persist */
  }
}

// ── Note counter ───────────────────────────────────────────────────────────

export async function readNoteCounter(): Promise<number> {
  if (isTauri) {
    const { readTextFile, exists, BaseDirectory } = await import(
      "@tauri-apps/plugin-fs"
    );
    if (await exists(COUNTER_FILE, { baseDir: BaseDirectory.Home })) {
      const text = await readTextFile(COUNTER_FILE, { baseDir: BaseDirectory.Home });
      const n = parseInt(text.trim(), 10);
      return Number.isFinite(n) ? n : 1;
    }
  } else {
    try {
      const res = await fetch("/api/counter");
      if (res.ok) {
        const text = await res.text();
        const n = parseInt(text.trim(), 10);
        if (Number.isFinite(n)) return n;
      }
    } catch {
      /* fall through */
    }
  }
  const raw = rawLocalStorageGet("shannon_note_counter");
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n)) {
      await writeNoteCounter(n);
      return n;
    }
  }
  return 1;
}

export async function writeNoteCounter(n: number): Promise<void> {
  if (isTauri) {
    const { writeTextFile, mkdir, BaseDirectory } = await import(
      "@tauri-apps/plugin-fs"
    );
    await mkdir(SHANNON_DIR, { baseDir: BaseDirectory.Home, recursive: true });
    await writeTextFile(COUNTER_FILE, String(n), { baseDir: BaseDirectory.Home });
    return;
  }
  await fetch("/api/counter", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: String(n),
  });
}
