// IndexedDB-backed store for heavy element payloads (images, PDFs).
//
// Context: localStorage caps at 5-10 MB, which a single pasted PDF or a
// handful of images blows past — the app is otherwise client-side-only, so
// moving blobs to IDB keeps that property while lifting the quota to
// browser-default (typically 50+ GB).
//
// Convention: element.src is a data URL in memory (so rendering and LLM
// serialization work unchanged). On persist to localStorage, `src` is
// stripped and only `blobId` survives. On load, `src` is hydrated from IDB.

import type { CanvasEl, ImageEl, NoteItem, PdfEl } from "./canvas-types";

const DB_NAME = "shannon";
const STORE = "blobs";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function putBlob(blobId: string, blob: Blob): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(blob, blobId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getBlob(blobId: string): Promise<Blob | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(blobId);
    req.onsuccess = () => resolve((req.result as Blob | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteBlob(blobId: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(blobId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listBlobIds(): Promise<string[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAllKeys();
    req.onsuccess = () => resolve(req.result as string[]);
    req.onerror = () => reject(req.error);
  });
}

// ── Data URL ↔ Blob converters ────────────────────────────────────────────

export function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const mediaType = match[1];
  const raw = atob(match[2]);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return new Blob([arr], { type: mediaType });
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ── Element-shape helpers ─────────────────────────────────────────────────

function hasBlobCandidate(el: CanvasEl): el is ImageEl | PdfEl {
  return el.type === "image" || el.type === "pdf";
}

/** Strip `src` from image/pdf elements that have a `blobId`. Used at persist time. */
export function stripBlobSrcsForPersist(elements: CanvasEl[]): CanvasEl[] {
  return elements.map((el) => {
    if (!hasBlobCandidate(el)) return el;
    if (!el.blobId) return el; // no backing blob — leave src alone
    const { src: _drop, ...rest } = el;
    return rest as unknown as CanvasEl;
  });
}

/** Migrate elements with inline `src:"data:..."` but no `blobId` — push blob to IDB, assign id.
 *  Returns the updated elements and whether any migration happened. */
export async function migrateInlineBlobs(
  elements: CanvasEl[],
): Promise<{ elements: CanvasEl[]; changed: boolean }> {
  let changed = false;
  const out: CanvasEl[] = [];
  for (const el of elements) {
    if (!hasBlobCandidate(el) || el.blobId || !el.src || !el.src.startsWith("data:")) {
      out.push(el);
      continue;
    }
    const blob = dataUrlToBlob(el.src);
    if (!blob) { out.push(el); continue; }
    const blobId = crypto.randomUUID();
    try {
      await putBlob(blobId, blob);
      out.push({ ...el, blobId });
      changed = true;
    } catch {
      // IDB write failed — leave inline (will still work but may exceed quota later)
      out.push(el);
    }
  }
  return { elements: out, changed };
}

/** For each image/pdf element with `blobId` but no `src`, fetch blob from IDB and set `src` as a data URL. */
export async function hydrateBlobs(elements: CanvasEl[]): Promise<CanvasEl[]> {
  const out: CanvasEl[] = [];
  for (const el of elements) {
    if (!hasBlobCandidate(el) || !el.blobId || el.src) {
      out.push(el);
      continue;
    }
    try {
      const blob = await getBlob(el.blobId);
      if (!blob) { out.push(el); continue; }
      const src = await blobToDataUrl(blob);
      out.push({ ...el, src });
    } catch {
      out.push(el);
    }
  }
  return out;
}

/** Migrate + hydrate an array of notes in one pass. Returns new notes and whether any migration happened. */
export async function prepareNotesForDisplay(
  notes: NoteItem[],
): Promise<{ notes: NoteItem[]; migrated: boolean }> {
  let migrated = false;
  const out: NoteItem[] = [];
  for (const n of notes) {
    const m = await migrateInlineBlobs(n.elements ?? []);
    if (m.changed) migrated = true;
    const hydrated = await hydrateBlobs(m.elements);
    out.push({ ...n, elements: hydrated });
  }
  return { notes: out, migrated };
}

/** Strip blob srcs from every note — used before writing to localStorage. */
export function stripNotesForPersist(notes: NoteItem[]): NoteItem[] {
  return notes.map((n) => ({ ...n, elements: stripBlobSrcsForPersist(n.elements ?? []) }));
}

/** Collect every blobId referenced by any image/pdf element across the given notes. */
export function collectReferencedBlobIds(notes: NoteItem[]): Set<string> {
  const out = new Set<string>();
  for (const n of notes) {
    for (const el of n.elements ?? []) {
      if (hasBlobCandidate(el) && el.blobId) out.add(el.blobId);
    }
  }
  return out;
}

/** Delete IDB blobs not referenced by any note. Returns the number deleted.
 *  Intended to run once per session (e.g. on mount) — leaks from the previous
 *  session get reclaimed without any per-mutation bookkeeping. */
export async function gcOrphanedBlobs(notes: NoteItem[]): Promise<number> {
  let allIds: string[];
  try {
    allIds = await listBlobIds();
  } catch {
    return 0;
  }
  const referenced = collectReferencedBlobIds(notes);
  let deleted = 0;
  for (const id of allIds) {
    if (referenced.has(id)) continue;
    try {
      await deleteBlob(id);
      deleted++;
    } catch {
      // ignore and continue
    }
  }
  return deleted;
}
