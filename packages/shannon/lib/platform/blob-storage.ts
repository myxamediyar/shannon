// Filesystem-backed blob storage. Replaces IndexedDB ("shannon"/"blobs"
// store) for image/PDF blobs. Each blob is stored as a single text file at
// ~/.shannon/blobs/<id> containing a `data:<mime>;base64,...` URL — the
// same shape the SPA already uses for element.src in memory, so reads need
// no decoding step beyond returning the string.
//
// Tauri reads/writes these files via plugin-fs. Web mode (npm CLI) routes
// through bin/shannon.js's /api/blobs endpoints which manipulate the same
// files.
//
// Migration: on first call to initializeBlobStorage(), if the filesystem
// has nothing but the legacy "shannon" IDB store has blobs, the blobs are
// drained to disk. A localStorage marker keeps the migration idempotent.

import { isTauri } from "./index";

const BLOBS_DIR = ".shannon/blobs";
const MIGRATION_MARKER = "shannon_blobs_migrated_v1";

let initialized = false;
let initializing: Promise<void> | null = null;

export async function initializeBlobStorage(): Promise<void> {
  if (initialized) return;
  if (initializing) return initializing;
  initializing = (async () => {
    await migrateFromIDBIfNeeded();
    initialized = true;
    initializing = null;
  })();
  return initializing;
}

// ── Conversions (kept here so the adapter is self-contained) ───────────────

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const raw = atob(match[2]);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return new Blob([arr], { type: match[1] });
}

// ── Primitives ─────────────────────────────────────────────────────────────

export async function putBlob(id: string, blob: Blob): Promise<void> {
  await initializeBlobStorage();
  const dataUrl = await blobToDataUrl(blob);
  if (isTauri) {
    const { writeTextFile, mkdir, BaseDirectory } = await import(
      "@tauri-apps/plugin-fs"
    );
    await mkdir(BLOBS_DIR, { baseDir: BaseDirectory.Home, recursive: true });
    await writeTextFile(`${BLOBS_DIR}/${id}`, dataUrl, {
      baseDir: BaseDirectory.Home,
    });
    return;
  }
  const res = await fetch(`/api/blobs/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: dataUrl,
  });
  if (!res.ok) throw new Error(`putBlob failed: ${res.status}`);
}

export async function getBlob(id: string): Promise<Blob | null> {
  await initializeBlobStorage();
  if (isTauri) {
    const { readTextFile, exists, BaseDirectory } = await import(
      "@tauri-apps/plugin-fs"
    );
    const filePath = `${BLOBS_DIR}/${id}`;
    if (!(await exists(filePath, { baseDir: BaseDirectory.Home }))) return null;
    const dataUrl = await readTextFile(filePath, { baseDir: BaseDirectory.Home });
    return dataUrlToBlob(dataUrl);
  }
  const res = await fetch(`/api/blobs/${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  return dataUrlToBlob(await res.text());
}

export async function deleteBlob(id: string): Promise<void> {
  await initializeBlobStorage();
  if (isTauri) {
    const { remove, exists, BaseDirectory } = await import(
      "@tauri-apps/plugin-fs"
    );
    const filePath = `${BLOBS_DIR}/${id}`;
    if (await exists(filePath, { baseDir: BaseDirectory.Home })) {
      await remove(filePath, { baseDir: BaseDirectory.Home });
    }
    return;
  }
  await fetch(`/api/blobs/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function listBlobIds(): Promise<string[]> {
  await initializeBlobStorage();
  if (isTauri) {
    const { readDir, exists, BaseDirectory } = await import(
      "@tauri-apps/plugin-fs"
    );
    if (!(await exists(BLOBS_DIR, { baseDir: BaseDirectory.Home }))) return [];
    const entries = await readDir(BLOBS_DIR, { baseDir: BaseDirectory.Home });
    return entries
      .map((e) => e.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
  }
  const res = await fetch("/api/blobs");
  if (!res.ok) return [];
  return (await res.json()) as string[];
}

// ── IndexedDB → filesystem migration ────────────────────────────────────────

async function migrateFromIDBIfNeeded(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  if (typeof localStorage !== "undefined") {
    if (localStorage.getItem(MIGRATION_MARKER) === "true") return;
  }

  let blobs: { id: string; blob: Blob }[] = [];
  try {
    blobs = await readAllLegacyBlobs();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[shannon] Could not read legacy IDB blobs:", e);
    return;
  }
  if (blobs.length === 0) {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(MIGRATION_MARKER, "true");
    }
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`[shannon] Migrating ${blobs.length} blobs from IndexedDB to filesystem`);
  let migrated = 0;
  for (const { id, blob } of blobs) {
    try {
      await putBlob(id, blob);
      migrated++;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[shannon] Failed to migrate blob ${id}:`, e);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[shannon] Migrated ${migrated}/${blobs.length} blobs`);

  if (typeof localStorage !== "undefined") {
    localStorage.setItem(MIGRATION_MARKER, "true");
  }
}

function readAllLegacyBlobs(): Promise<{ id: string; blob: Blob }[]> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("shannon", 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("blobs")) {
        db.close();
        return resolve([]);
      }
      const tx = db.transaction("blobs", "readonly");
      const store = tx.objectStore("blobs");
      const keysReq = store.getAllKeys();
      const valuesReq = store.getAll();
      Promise.all([
        new Promise<IDBValidKey[]>((res, rej) => {
          keysReq.onsuccess = () => res(keysReq.result);
          keysReq.onerror = () => rej(keysReq.error);
        }),
        new Promise<unknown[]>((res, rej) => {
          valuesReq.onsuccess = () => res(valuesReq.result);
          valuesReq.onerror = () => rej(valuesReq.error);
        }),
      ])
        .then(([keys, values]) => {
          const out: { id: string; blob: Blob }[] = [];
          for (let i = 0; i < keys.length; i++) {
            const id = String(keys[i]);
            const v = values[i];
            if (v instanceof Blob) out.push({ id, blob: v });
          }
          db.close();
          resolve(out);
        })
        .catch((e) => {
          db.close();
          reject(e);
        });
    };
  });
}
