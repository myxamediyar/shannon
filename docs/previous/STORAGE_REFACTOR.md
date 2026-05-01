# Storage layer: window events → useSyncExternalStore

## Why

The bug: Tauri launched showed an empty notes list until you added a new note,
and image/PDF blobs didn't render until a manual reload. Both symptoms had
the same root cause — storage init was fire-and-forget, and consumers kept
their own copy of the data which they only refreshed on a `notes:updated` /
`folders:updated` window event. So:

1. Sidebar's `useLayoutEffect` ran a synchronous `localStorage.getItem` (proxied
   through the legacy patch) before `initializeNotesStorage()` had populated
   the in-memory cache → got `[]`, set state to empty, never refreshed.
2. Nothing dispatched a "notes are now loaded" event, so the Sidebar stayed
   empty until the user did something that wrote (which fired `notes:updated`).
3. Same shape for blobs: `getBlob` didn't await the IDB → FS migration, so
   the lazy hydrate path lost the race and silently left image/pdf elements
   without `src`.

The user-facing fix could have been a one-line `dispatchEvent` at the end of
init, but the underlying pattern (multiple components owning duplicate copies
of the same data, kept in sync via window events) was the actual problem. We
replaced it with `useSyncExternalStore` end-to-end.

## What changed

### New: tiny pub/sub stores

Each storage module now exposes the React 18 external-store interface —
`subscribe(listener)` + `getSnapshot()` — and rebuilds a stable snapshot on
every mutation. Components subscribe via `useSyncExternalStore` and re-render
automatically; no events, no listeners, no `localStorage.getItem` round-trips.

| Module | New API |
|---|---|
| `lib/platform/notes-storage.ts` | `subscribeNotes` / `getNotesSnapshot`, `subscribeFolders` / `getFoldersSnapshot` |
| `lib/custom-backgrounds.ts` | `subscribeBackgrounds` / `getBackgroundsSnapshot` |
| `lib/use-settings.ts` | module-level `subscribe` / `getSnapshot` (private to the hook) |
| `lib/canvas-actions-store.ts` *(new)* | `subscribePendingExport` / `getPendingExportSnapshot` + `requestExportHtml` / `consumePendingExport` |

Notify call sites:

- `notes-storage`: end of `initializeNotesStorage`, `writeNote`, `saveAllNotes`,
  `deleteNote`, `setCachedNote`, `writeFolders`.
- `custom-backgrounds`: every `readMeta` / `writeMeta` (which all CRUD funnels
  through).
- `use-settings`: `persist` / `reset`.

### Notes/folders: legacy patch deleted

`lib/platform/legacy-storage-patch.ts` (the `Storage.prototype.getItem/setItem`
shim that proxied `shannon_notes` / `shannon_folders` to the in-memory cache)
is gone. Its consumers were rewritten to call the storage layer directly:

- **Sidebar**:
  - `useState<SidebarNote[]>([]) + useIsoLayoutEffect(readNotes)` →
    `useSyncExternalStore(subscribeNotes, getNotesSnapshot)` + `useMemo`
    projection to `{id, title}`.
  - `useState<TreeItem[]>([]) + useEffect(load)` →
    `useSyncExternalStore(subscribeFolders, getFoldersSnapshot)` + `useMemo`
    parse.
  - `commitRename` / `deleteNote` / `handleImportNote`: no more
    `localStorage.getItem(NOTES_STORAGE_KEY)` round-trips —
    `writeNote(...)` / `deleteNoteFromStore(...)` directly.
  - `writeTree(next)` (used to `localStorage.setItem` + `dispatchEvent("folders:updated")`)
    is now a one-liner: `void writeFolders({ tree: next })`.
  - All four `setTree(next); writeTree(next)` pairs collapsed to `writeTree(next)`
    since the tree is now derived from the store.
  - All `notes:updated` / `folders:updated` / `storage` listeners removed.

- **NotesPage** (`app/notes/page.tsx`):
  - `useState<NoteItem[]>([])` + the structural-load `useEffect` that did
    `setNotes(getAllNotes())` → `useSyncExternalStore(subscribeNotes, getNotesSnapshot)`.
    The init `useEffect` shrunk to triggering `initializeNotesStorage()`,
    setting up the note counter, and flipping a `notesLoaded` flag.
  - `handleNoteChange` / `handleCreateNote` / `handleToggleLock` no longer
    call `setNotes`; they just `writeNote(...)`. Cache update is synchronous
    inside `writeNote`, so subscribers re-render before the disk I/O resolves.
  - `setTimeout(() => window.dispatchEvent(new Event("notes:updated")))`
    deleted.

- **Cache holds full notes; disk auto-strips:** the `stripBlobSrcsForPersist`
  call inside `NotesCanvas.persistFromRef` was removed. Stripping moved
  into `notes-storage.writeNoteToBackend` (`stripNoteForDisk`). Net effect:
  the React-visible cache always has hydrated `src`, the on-disk
  `~/.shannon/notes/<id>.shannon` files stay small, and there's no longer
  a window where a save would knock src out of the cache and force a
  re-hydrate on navigation.

- **`setCachedNote(note)` (new)**: in-memory-only cache update. Used by the
  lazy blob-hydrate path so adding `src` back to image/pdf elements doesn't
  rewrite the .shannon file (which already has src stripped).

### Custom backgrounds

`lib/custom-backgrounds.ts`:
- `useCustomBackgrounds()` was `useState + useEffect + addEventListener("shannon:custom-backgrounds")`.
  Now it's `useSyncExternalStore(subscribeBackgrounds, getBackgroundsSnapshot)`
  with a one-shot `useEffect` to trigger initial load.
- `emitChange()` (which fired the `shannon:custom-backgrounds` window event)
  was deleted; `readMeta` / `writeMeta` call `notify()` instead.

### Settings

`lib/use-settings.ts`:
- The hook used to maintain *per-instance* `useState` and broadcast via
  `dispatchEvent("shannon:settings", { detail: next })`, with each hook
  instance listening to it. That's textbook duplicated state synced over
  events — the exact pattern this refactor exists to delete.
- Replaced with a module-level snapshot + subscriber set, read via
  `useSyncExternalStore`. Every `useSettings()` caller in the tree now reads
  the *same* snapshot; `update()` mutates the module snapshot and notifies.

### Export-HTML RPC

The `notes:export-html` window event (sidebar fires → canvas listens → runs
export against live DOM) and its `sessionStorage`-backed
"navigate-then-export" companion were both removed.

Replaced with `lib/canvas-actions-store.ts` — a one-slot store holding the
"pending export request" note id:

- Sidebar's `handleExportHtml(noteId)` calls `requestExportHtml(noteId)` and
  navigates if needed.
- NotesCanvas subscribes via `useSyncExternalStore(subscribePendingExport, …)`.
  When the pending id matches `activeNote.id`, it `consumePendingExport(id)`
  and runs the export. Works for both same-active-note and
  navigate-then-export cases without any storage round-trip.

### Blob hydrate race

`getBlob` / `putBlob` / `deleteBlob` / `listBlobIds` in
`lib/platform/blob-storage.ts` now `await initializeBlobStorage()` at the top.
That closes the IDB → FS migration race that was leaving image/pdf elements
without `src` on the first launch after Phase 3b.

## Bigger picture

The pattern that's gone: **two components own copies of the same data,
synchronized via `window.dispatchEvent` / `window.addEventListener`**.

The pattern that replaced it: **one module-level cache is the source of
truth; components subscribe to it via `useSyncExternalStore`**. Mutations
update the cache synchronously and notify subscribers; React handles the
re-render. No events, no duplicate state, no "did init finish yet?"
ambiguity (subscribers automatically catch the snapshot update at the end of
init).

Real DOM events (keydown, mousedown, focusin/out, paste, touch*, etc.) were
left alone — those aren't state sync.

## Files touched

```
A  packages/shannon/lib/canvas-actions-store.ts
M  packages/shannon/lib/custom-backgrounds.ts
M  packages/shannon/lib/use-settings.ts
M  packages/shannon/lib/platform/notes-storage.ts
M  packages/shannon/lib/platform/blob-storage.ts
M  packages/shannon/components/Sidebar.tsx
M  packages/shannon/components/NotesCanvas.tsx
M  packages/shannon/components/TauriLinkInterceptor.tsx
M  packages/shannon/app/notes/page.tsx
D  packages/shannon/lib/platform/legacy-storage-patch.ts
```
