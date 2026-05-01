"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { isTauri } from "./platform";
import { putBlob, getBlob, deleteBlob } from "./platform/blob-storage";

// Custom canvas background images. Phase 3b moved storage from IndexedDB
// ("shannon_settings" db, "backgrounds" store) to filesystem:
//   - Blobs share the regular blob storage at ~/.shannon/blobs/<id>
//   - Metadata (label, createdAt) lives at ~/.shannon/backgrounds.json
//
// React integration uses useSyncExternalStore — components subscribe to the
// in-memory metaCache, every CRUD mutation rebuilds the snapshot and
// notifies. No window events.
//
// Old IDB records are drained on first call to listBackgrounds() — guarded
// by a localStorage marker so the migration runs at most once.

export const IDB_PREFIX = "idb:";

export type CustomBackground = { id: string; label: string; createdAt: number };

const META_FILE = ".shannon/backgrounds.json";
const MIGRATION_MARKER = "shannon_backgrounds_migrated_v1";

let metaCache: CustomBackground[] | null = null;
let migrationPromise: Promise<void> | null = null;

// Stable snapshot for useSyncExternalStore. Sorted by createdAt so consumers
// can render directly without re-sorting.
let snapshot: CustomBackground[] = [];
const subs = new Set<() => void>();

function rebuildSnapshot(): void {
  snapshot = (metaCache ?? []).slice().sort((a, b) => a.createdAt - b.createdAt);
}

function notify(): void {
  rebuildSnapshot();
  for (const l of subs) l();
}

export function subscribeBackgrounds(listener: () => void): () => void {
  subs.add(listener);
  return () => { subs.delete(listener); };
}

export function getBackgroundsSnapshot(): CustomBackground[] {
  return snapshot;
}

async function readMeta(): Promise<CustomBackground[]> {
  if (metaCache) return [...metaCache];
  if (isTauri) {
    const { readTextFile, exists, BaseDirectory } = await import(
      "@tauri-apps/plugin-fs"
    );
    if (await exists(META_FILE, { baseDir: BaseDirectory.Home })) {
      const text = await readTextFile(META_FILE, { baseDir: BaseDirectory.Home });
      try {
        const parsed = JSON.parse(text) as CustomBackground[];
        metaCache = Array.isArray(parsed) ? parsed : [];
        notify();
        return [...metaCache];
      } catch {
        metaCache = [];
        notify();
        return [];
      }
    }
  } else {
    try {
      const res = await fetch("/api/backgrounds");
      if (res.ok) {
        const parsed = (await res.json()) as CustomBackground[];
        metaCache = Array.isArray(parsed) ? parsed : [];
        notify();
        return [...metaCache];
      }
    } catch {
      /* fall through */
    }
  }
  metaCache = [];
  notify();
  return [];
}

async function writeMeta(meta: CustomBackground[]): Promise<void> {
  metaCache = [...meta];
  notify();
  const json = JSON.stringify(meta, null, 2);
  if (isTauri) {
    const { writeTextFile, mkdir, BaseDirectory } = await import(
      "@tauri-apps/plugin-fs"
    );
    await mkdir(".shannon", { baseDir: BaseDirectory.Home, recursive: true });
    await writeTextFile(META_FILE, json, { baseDir: BaseDirectory.Home });
    return;
  }
  await fetch("/api/backgrounds", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: json,
  });
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export async function listBackgrounds(): Promise<CustomBackground[]> {
  await migrateIfNeeded();
  const meta = await readMeta();
  return [...meta].sort((a, b) => a.createdAt - b.createdAt);
}

export async function getBackgroundBlob(id: string): Promise<Blob | null> {
  return getBlob(id);
}

export async function addBackground(label: string, blob: Blob): Promise<string> {
  const id = crypto.randomUUID();
  await putBlob(id, blob);
  const meta = await readMeta();
  meta.push({ id, label, createdAt: Date.now() });
  await writeMeta(meta);
  return id;
}

export async function renameBackground(id: string, label: string): Promise<void> {
  const meta = await readMeta();
  const idx = meta.findIndex((m) => m.id === id);
  if (idx < 0) throw new Error("Not found");
  meta[idx] = { ...meta[idx], label };
  await writeMeta(meta);
}

export async function deleteBackground(id: string): Promise<void> {
  const meta = await readMeta();
  await writeMeta(meta.filter((m) => m.id !== id));
  try {
    await deleteBlob(id);
  } catch {
    /* blob may already be missing — meta is the truth */
  }
}

// ── IDB → filesystem migration (one-shot, idempotent) ──────────────────────

async function migrateIfNeeded(): Promise<void> {
  if (migrationPromise) return migrationPromise;
  migrationPromise = (async () => {
    if (typeof localStorage !== "undefined") {
      if (localStorage.getItem(MIGRATION_MARKER) === "true") return;
    }
    if (typeof indexedDB === "undefined") return;
    let records: { id: string; label: string; createdAt: number; blob: Blob }[];
    try {
      records = await readLegacyBackgrounds();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[shannon] Could not read legacy backgrounds:", e);
      return;
    }
    if (records.length === 0) {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(MIGRATION_MARKER, "true");
      }
      return;
    }
    // eslint-disable-next-line no-console
    console.log(
      `[shannon] Migrating ${records.length} custom backgrounds from IndexedDB`,
    );
    const existing = await readMeta();
    const existingIds = new Set(existing.map((m) => m.id));
    const merged = [...existing];
    for (const rec of records) {
      if (existingIds.has(rec.id)) continue;
      try {
        await putBlob(rec.id, rec.blob);
        merged.push({ id: rec.id, label: rec.label, createdAt: rec.createdAt });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[shannon] Failed to migrate background ${rec.id}:`, e);
      }
    }
    await writeMeta(merged);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(MIGRATION_MARKER, "true");
    }
  })();
  return migrationPromise;
}

function readLegacyBackgrounds(): Promise<
  { id: string; label: string; createdAt: number; blob: Blob }[]
> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("shannon_settings", 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("backgrounds")) {
        db.close();
        return resolve([]);
      }
      const tx = db.transaction("backgrounds", "readonly");
      const r = tx.objectStore("backgrounds").getAll();
      r.onsuccess = () => {
        db.close();
        resolve(
          r.result as { id: string; label: string; createdAt: number; blob: Blob }[],
        );
      };
      r.onerror = () => {
        db.close();
        reject(r.error);
      };
    };
  });
}

// ── Hooks ──────────────────────────────────────────────────────────────────

export function useCustomBackgrounds() {
  const list = useSyncExternalStore(
    subscribeBackgrounds,
    getBackgroundsSnapshot,
    () => [] as CustomBackground[],
  );
  // Trigger initial load (and one-shot IDB migration). The listBackgrounds()
  // call populates metaCache and notifies subscribers; subsequent renders
  // read straight from the snapshot.
  useEffect(() => { void listBackgrounds(); }, []);
  const refresh = useCallback(() => { void listBackgrounds(); }, []);
  return { list, refresh };
}

/** If `bgImage` references a stored custom (`idb:<id>` — name kept for
 *  back-compat), this fetches the blob and returns a session-scoped object
 *  URL. Returns the value unchanged for presets and "" while loading. */
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
