// Transparent localStorage shim for the three legacy keys the codebase
// reads/writes synchronously: shannon_notes, shannon_folders,
// shannon_note_counter. After Phase 3, those values live on the filesystem
// (Tauri) or behind /api/notes etc. (npm CLI mode), but lots of components
// (Sidebar, NotesCanvas, app/notes/page) still call localStorage directly.
//
// Rather than refactor every callsite, we patch Storage.prototype so reads
// hit the in-memory adapter cache and writes route through the adapter
// (which persists to disk). The patch is idempotent and only intercepts
// the three shannon_* keys — everything else passes through.

"use client";

import {
  getAllNotes,
  saveAllNotes,
  getFoldersStringSync,
  writeFoldersFromString,
  writeNoteCounter,
} from "./notes-storage";

const NOTES_KEY = "shannon_notes";
const FOLDERS_KEY = "shannon_folders";
const COUNTER_KEY = "shannon_note_counter";

declare global {
  interface Window {
    __shannonStoragePatched?: boolean;
  }
}

// Saved before the patch is installed so migration code can read the *real*
// localStorage values that the user had under the old origin — otherwise the
// patched getItem would just return the (empty) adapter cache and the
// migration would skip with "nothing to drain."
const proto = typeof window !== "undefined" ? Storage.prototype : null;
const origGetItem = proto ? proto.getItem : null;
const origSetItem = proto ? proto.setItem : null;
const origRemoveItem = proto ? proto.removeItem : null;

export function rawLocalStorageGet(key: string): string | null {
  if (typeof window === "undefined" || !origGetItem) return null;
  return origGetItem.call(localStorage, key);
}

export function rawLocalStorageSet(key: string, value: string): void {
  if (typeof window === "undefined" || !origSetItem) return;
  origSetItem.call(localStorage, key, value);
}

if (typeof window !== "undefined" && !window.__shannonStoragePatched && proto) {
  window.__shannonStoragePatched = true;

  proto.getItem = function (key: string) {
    if (this === localStorage) {
      if (key === NOTES_KEY) {
        // Adapter returns NoteItem[]; legacy code expects the JSON string.
        return JSON.stringify(getAllNotes());
      }
      if (key === FOLDERS_KEY) {
        return getFoldersStringSync();
      }
      // Counter falls through to the original (it's only set rarely; the
      // adapter writes a backing file, but reads still hit localStorage as
      // an in-memory cache that lives at least a session).
    }
    return origGetItem!.call(this, key);
  };

  proto.setItem = function (key: string, value: string) {
    if (this === localStorage) {
      if (key === NOTES_KEY) {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) {
            void saveAllNotes(parsed);
          }
        } catch {
          /* ignore malformed input */
        }
        // Mirror to localStorage too so synchronous reads from non-patched
        // contexts (e.g. server-rendered SSR) and the next non-patched
        // tick still see the write.
        try {
          origSetItem!.call(this, key, value);
        } catch {
          /* quota exceeded — adapter is the truth anyway */
        }
        // Synthetic storage event for legacy listeners (Sidebar listens to
        // "storage" for cross-tab sync; in same-tab writes browsers don't
        // fire it, so we dispatch it ourselves).
        window.dispatchEvent(
          new StorageEvent("storage", { key, newValue: value, oldValue: null }),
        );
        return;
      }
      if (key === FOLDERS_KEY) {
        void writeFoldersFromString(value);
        try {
          origSetItem!.call(this, key, value);
        } catch {
          /* ignore */
        }
        window.dispatchEvent(
          new StorageEvent("storage", { key, newValue: value, oldValue: null }),
        );
        return;
      }
      if (key === COUNTER_KEY) {
        const n = parseInt(value, 10);
        if (Number.isFinite(n)) void writeNoteCounter(n);
        // Fall through — counter is also kept in localStorage as the
        // sync-readable cache.
      }
    }
    return origSetItem!.call(this, key, value);
  };

  proto.removeItem = function (key: string) {
    // Don't intercept removals; legacy code rarely removes shannon_* keys.
    return origRemoveItem!.call(this, key);
  };
}

export {}; // module flag
