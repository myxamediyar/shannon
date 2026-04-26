"use client";

import { useCallback, useEffect, useState } from "react";

// ── IndexedDB wiring ────────────────────────────────────────────────────────

// Note: deliberately a different DB from `lib/canvas-blob-store.ts`'s `shannon`
// DB, so the two modules can evolve their schemas independently without
// coordinating version bumps.
const DB_NAME = "shannon_settings";
const DB_VERSION = 1;
const STORE = "backgrounds";

export const IDB_PREFIX = "idb:";

export type CustomBackground = { id: string; label: string; createdAt: number };
type Record = CustomBackground & { blob: Blob };

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB unavailable"));
  }
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const r = fn(t.objectStore(STORE));
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      }),
  );
}

// ── CRUD ────────────────────────────────────────────────────────────────────

const CHANGE_EVENT = "shannon:custom-backgrounds";
const emitChange = () => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  }
};

export async function listBackgrounds(): Promise<CustomBackground[]> {
  const all = (await run<Record[]>("readonly", (s) => s.getAll() as IDBRequest<Record[]>)) ?? [];
  return all
    .map(({ id, label, createdAt }) => ({ id, label, createdAt }))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function getBackgroundBlob(id: string): Promise<Blob | null> {
  const rec = (await run<Record | undefined>("readonly", (s) => s.get(id) as IDBRequest<Record | undefined>)) ?? null;
  return rec?.blob ?? null;
}

export async function addBackground(label: string, blob: Blob): Promise<string> {
  const id = crypto.randomUUID();
  const rec: Record = { id, label, blob, createdAt: Date.now() };
  await run("readwrite", (s) => s.add(rec));
  emitChange();
  return id;
}

export async function renameBackground(id: string, label: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE, "readwrite");
    const s = t.objectStore(STORE);
    const g = s.get(id) as IDBRequest<Record | undefined>;
    g.onsuccess = () => {
      const rec = g.result;
      if (!rec) return reject(new Error("Not found"));
      rec.label = label;
      const p = s.put(rec);
      p.onsuccess = () => resolve();
      p.onerror = () => reject(p.error);
    };
    g.onerror = () => reject(g.error);
  });
  emitChange();
}

export async function deleteBackground(id: string): Promise<void> {
  await run("readwrite", (s) => s.delete(id));
  emitChange();
}

// ── Hook: list customs ─────────────────────────────────────────────────────

export function useCustomBackgrounds() {
  const [list, setList] = useState<CustomBackground[]>([]);
  const refresh = useCallback(() => {
    listBackgrounds()
      .then(setList)
      .catch(() => setList([]));
  }, []);
  useEffect(() => {
    refresh();
    const handler = () => refresh();
    window.addEventListener(CHANGE_EVENT, handler);
    return () => window.removeEventListener(CHANGE_EVENT, handler);
  }, [refresh]);
  return { list, refresh };
}

// ── Hook: resolve bgImage value to a usable URL ─────────────────────────────

/** If `bgImage` references an IDB-stored custom (`idb:<id>`), this fetches the
 *  blob and returns a session-scoped object URL. Returns the value unchanged
 *  for presets and "" while loading or on miss. */
export function useResolvedBgImage(bgImage: string): string {
  const [resolved, setResolved] = useState<string>(() =>
    bgImage.startsWith(IDB_PREFIX) ? "" : bgImage,
  );
  useEffect(() => {
    if (!bgImage.startsWith(IDB_PREFIX)) {
      setResolved(bgImage);
      return;
    }
    let cancelled = false;
    let url: string | null = null;
    const id = bgImage.slice(IDB_PREFIX.length);
    getBackgroundBlob(id)
      .then((blob) => {
        if (cancelled) return;
        if (!blob) {
          setResolved("");
          return;
        }
        url = URL.createObjectURL(blob);
        setResolved(url);
      })
      .catch(() => {
        if (!cancelled) setResolved("");
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [bgImage]);
  return resolved;
}
