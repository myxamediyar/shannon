// Recently-opened notes for the native File → Open Recent submenu.
//
// Storage: ~/.shannon/recents.json (Tauri only — npm/browser mode has no
// native menu, so the file is never read or written there). The list is
// capped at MAX_RECENTS, deduplicated by note id, and sorted most-recent
// first.
//
// Sync to menu: every mutation calls `set_recent_notes` on the Rust side,
// which rebuilds the menu in place. JS owns the source of truth — the file
// — so the Rust side is stateless w/r/t recents.

import { isTauri } from "./index";

export type RecentEntry = { id: string; title: string; openedAt: number };

const RECENTS_PATH = ".shannon/recents.json";
const MAX_RECENTS = 10;

let inFlight: Promise<void> | null = null;

async function readRecentsFile(): Promise<RecentEntry[]> {
  if (!isTauri) return [];
  try {
    const { readTextFile, exists, BaseDirectory } = await import(
      "@tauri-apps/plugin-fs"
    );
    if (!(await exists(RECENTS_PATH, { baseDir: BaseDirectory.Home }))) return [];
    const text = await readTextFile(RECENTS_PATH, { baseDir: BaseDirectory.Home });
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RecentEntry =>
        e && typeof e === "object" &&
        typeof e.id === "string" &&
        typeof e.title === "string" &&
        typeof e.openedAt === "number",
    );
  } catch {
    return [];
  }
}

async function writeRecentsFile(items: RecentEntry[]): Promise<void> {
  if (!isTauri) return;
  const { writeTextFile, mkdir, BaseDirectory } = await import(
    "@tauri-apps/plugin-fs"
  );
  await mkdir(".shannon", { baseDir: BaseDirectory.Home, recursive: true });
  await writeTextFile(RECENTS_PATH, JSON.stringify(items), {
    baseDir: BaseDirectory.Home,
  });
}

async function pushToMenu(items: RecentEntry[]): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  // Rust expects { id, title } — strip openedAt to keep the IPC payload tight.
  const slim = items.map(({ id, title }) => ({ id, title }));
  await invoke("set_recent_notes", { items: slim });
}

/** Read recents from disk and push them to the native menu. Call once at
 *  app startup so the submenu is populated on first show. */
export async function syncRecentsToMenu(): Promise<void> {
  if (!isTauri) return;
  const items = await readRecentsFile();
  await pushToMenu(items);
}

/** Mark a note as recently opened. Idempotent — re-opening the same id just
 *  bumps it to the top. Mutations are serialized via a single in-flight
 *  promise so back-to-back calls (e.g. fast nav) don't race. */
export async function addRecent(id: string, title: string): Promise<void> {
  if (!isTauri) return;
  const next = (async () => {
    if (inFlight) await inFlight.catch(() => {});
    const current = await readRecentsFile();
    const filtered = current.filter((r) => r.id !== id);
    const updated = [{ id, title, openedAt: Date.now() }, ...filtered].slice(
      0,
      MAX_RECENTS,
    );
    await writeRecentsFile(updated);
    await pushToMenu(updated);
  })();
  inFlight = next;
  return next;
}

/** Drop a note from recents (e.g. when it's deleted). Silently no-op if
 *  the id isn't present. */
export async function removeRecent(id: string): Promise<void> {
  if (!isTauri) return;
  const next = (async () => {
    if (inFlight) await inFlight.catch(() => {});
    const current = await readRecentsFile();
    if (!current.some((r) => r.id === id)) return;
    const updated = current.filter((r) => r.id !== id);
    await writeRecentsFile(updated);
    await pushToMenu(updated);
  })();
  inFlight = next;
  return next;
}

/** Update the cached title for a note that was just renamed. Skip if the
 *  note isn't in recents. */
export async function updateRecentTitle(id: string, title: string): Promise<void> {
  if (!isTauri) return;
  const next = (async () => {
    if (inFlight) await inFlight.catch(() => {});
    const current = await readRecentsFile();
    const idx = current.findIndex((r) => r.id === id);
    if (idx < 0) return;
    if (current[idx].title === title) return;
    const updated = current.slice();
    updated[idx] = { ...updated[idx], title };
    await writeRecentsFile(updated);
    await pushToMenu(updated);
  })();
  inFlight = next;
  return next;
}
