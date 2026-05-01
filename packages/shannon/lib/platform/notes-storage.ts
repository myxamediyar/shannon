// Filesystem-backed notes storage. Replaces localStorage for the three
// shannon_* keys (shannon_notes, shannon_folders, shannon_note_counter).
//
// Layout under ~/.shannon/:
//   notes/<id>.shannon  — one file per note (JSON, blob srcs stripped)
//   folders.json        — folder tree (single JSON object)
//   note-counter.json   — running counter for "Note #N" titles
//
// In Tauri mode the SPA reads/writes those files directly via plugin-fs.
// In web mode (running under bin/shannon.js) the adapter routes through
// /api/notes, /api/folders, /api/counter on the local CLI server, which
// reads/writes the same files.
//
// React integration: components read the cache via useSyncExternalStore
// (subscribeNotes/getNotesSnapshot, subscribeFolders/getFoldersSnapshot).
// Every write updates the cache, rebuilds the snapshot, and notifies
// subscribers — no window events, no localStorage round-trip.
//
// Migration: on first run, if the filesystem is empty and localStorage
// has data, the localStorage values are drained into the filesystem.
// This recovers existing notes after Phase 2d/e changed origins.

import { isTauri } from "./index";
import type { CanvasEl, NoteItem } from "@/lib/canvas-types";

const NOTES_DIR = ".shannon/notes";
const FOLDERS_FILE = ".shannon/folders.json";
const COUNTER_FILE = ".shannon/note-counter.json";
const SHANNON_DIR = ".shannon";

const cache = new Map<string, NoteItem>();
let initialized = false;
let initializing: Promise<void> | null = null;

// ── Subscription primitives (useSyncExternalStore) ──────────────────────────

const notesListeners = new Set<() => void>();
let notesSnapshot: NoteItem[] = [];

const foldersListeners = new Set<() => void>();
let foldersSnapshot: unknown = null;

function notifyNotes(): void {
  notesSnapshot = [...cache.values()];
  for (const l of notesListeners) l();
}

function notifyFolders(): void {
  for (const l of foldersListeners) l();
}

export function subscribeNotes(listener: () => void): () => void {
  notesListeners.add(listener);
  return () => { notesListeners.delete(listener); };
}

export function getNotesSnapshot(): NoteItem[] {
  return notesSnapshot;
}

export function subscribeFolders(listener: () => void): () => void {
  foldersListeners.add(listener);
  return () => { foldersListeners.delete(listener); };
}

export function getFoldersSnapshot<T = unknown>(): T | null {
  return foldersSnapshot as T | null;
}

// ── Strip blob srcs on disk (kept here so callers don't need to remember) ──

function stripNoteForDisk(note: NoteItem): NoteItem {
  const elements = (note.elements ?? []).map((el) => {
    if ((el.type === "image" || el.type === "pdf") && el.blobId && el.src) {
      const { src: _drop, ...rest } = el;
      return rest as CanvasEl;
    }
    return el;
  });
  return { ...note, elements };
}

// ── Sync getters ───────────────────────────────────────────────────────────

export function getNote(id: string): NoteItem | null {
  return cache.get(id) ?? null;
}

// ── Init ───────────────────────────────────────────────────────────────────

export async function initializeNotesStorage(): Promise<void> {
  if (initialized) return;
  if (initializing) return initializing;
  initializing = (async () => {
    await loadAllFromBackend();
    await migrateFromLocalStorageIfNeeded();
    await loadFoldersIntoCache();
    initialized = true;
    initializing = null;
    notifyNotes();
    notifyFolders();
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
  if (typeof localStorage === "undefined") return;
  const raw = localStorage.getItem("shannon_notes");
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

// ── Mutations ──────────────────────────────────────────────────────────────

export async function writeNote(note: NoteItem): Promise<void> {
  cache.set(note.id, note);
  notifyNotes();
  await writeNoteToBackend(note);
}

/** Update the cache for a note without writing to disk. Used by the lazy
 *  blob-hydrate path: `src` is added back to image/pdf elements so consumers
 *  see them, but the on-disk file (which has src stripped) doesn't need
 *  rewriting. */
export function setCachedNote(note: NoteItem): void {
  cache.set(note.id, note);
  notifyNotes();
}

async function writeNoteToBackend(note: NoteItem): Promise<void> {
  const onDisk = stripNoteForDisk(note);
  const json = JSON.stringify(onDisk);
  if (isTauri) {
    const { mkdir, BaseDirectory } = await import("@tauri-apps/plugin-fs");
    const { atomicWriteTextFile } = await import("./atomic-write");
    await mkdir(NOTES_DIR, { baseDir: BaseDirectory.Home, recursive: true });
    await atomicWriteTextFile(`${NOTES_DIR}/${note.id}.shannon`, json, {
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
  notifyNotes();
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

/** Diff against current cache and persist additions/changes/deletions. */
export async function saveAllNotes(notes: NoteItem[]): Promise<void> {
  const newIds = new Set(notes.map((n) => n.id));
  for (const n of notes) cache.set(n.id, n);
  for (const oldId of [...cache.keys()]) {
    if (!newIds.has(oldId)) cache.delete(oldId);
  }
  notifyNotes();
  await Promise.all(notes.map((n) => writeNoteToBackend(n)));
  const removed: string[] = [];
  for (const oldId of [...cache.keys()]) {
    if (!newIds.has(oldId)) removed.push(oldId);
  }
  await Promise.all(removed.map((id) => deleteNoteFile(id)));
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

export async function writeFolders<T = unknown>(folders: T): Promise<void> {
  foldersSnapshot = folders;
  notifyFolders();
  const json = JSON.stringify(folders, null, 2);
  if (isTauri) {
    const { mkdir, BaseDirectory } = await import("@tauri-apps/plugin-fs");
    const { atomicWriteTextFile } = await import("./atomic-write");
    await mkdir(SHANNON_DIR, { baseDir: BaseDirectory.Home, recursive: true });
    await atomicWriteTextFile(FOLDERS_FILE, json, { baseDir: BaseDirectory.Home });
    return;
  }
  await fetch("/api/folders", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: json,
  });
}

async function readFoldersFromBackend(): Promise<unknown> {
  if (isTauri) {
    const { readTextFile, exists, BaseDirectory } = await import(
      "@tauri-apps/plugin-fs"
    );
    if (await exists(FOLDERS_FILE, { baseDir: BaseDirectory.Home })) {
      const text = await readTextFile(FOLDERS_FILE, { baseDir: BaseDirectory.Home });
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    }
    return null;
  }
  try {
    const res = await fetch("/api/folders");
    if (res.ok) return await res.json();
  } catch {
    /* fall through to localStorage migration */
  }
  return null;
}

async function loadFoldersIntoCache(): Promise<void> {
  const fromBackend = await readFoldersFromBackend();
  if (fromBackend != null) {
    foldersSnapshot = fromBackend;
    return;
  }
  // Migration: read raw localStorage so we see the user's pre-Phase-3 data
  // even after the storage shim has been removed.
  if (typeof localStorage !== "undefined") {
    const raw = localStorage.getItem("shannon_folders");
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        foldersSnapshot = parsed;
        await writeFolders(parsed); // persist forward; this also re-notifies
        return;
      } catch {
        /* ignore */
      }
    }
  }
  foldersSnapshot = null;
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
  if (typeof localStorage !== "undefined") {
    const raw = localStorage.getItem("shannon_note_counter");
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n)) {
        await writeNoteCounter(n);
        return n;
      }
    }
  }
  return 1;
}

export async function writeNoteCounter(n: number): Promise<void> {
  if (isTauri) {
    const { mkdir, BaseDirectory } = await import("@tauri-apps/plugin-fs");
    const { atomicWriteTextFile } = await import("./atomic-write");
    await mkdir(SHANNON_DIR, { baseDir: BaseDirectory.Home, recursive: true });
    await atomicWriteTextFile(COUNTER_FILE, String(n), { baseDir: BaseDirectory.Home });
    return;
  }
  await fetch("/api/counter", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: String(n),
  });
}
