"use client";

import { Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import NotesCanvas from "../../components/NotesCanvas";
import { NotFoundView } from "../../components/NotFoundView";
import { makeNote } from "../../lib/canvas-utils";
import type { NoteItem } from "../../lib/canvas-types";
import { gcOrphanedBlobs, prepareNotesForDisplay } from "../../lib/canvas-blob-store";
import {
  initializeNotesStorage,
  subscribeNotes,
  getNotesSnapshot,
  getNote,
  writeNote,
  setCachedNote,
  readNoteCounter,
  writeNoteCounter,
} from "../../lib/platform/notes-storage";
import { addRecent } from "../../lib/platform/recents";

function NotesPageInner() {
  const router = useRouter();
  // Active note is identified by `?id=<noteId>`. Using a search param (not a
  // path segment) keeps `/notes` and `/notes?id=…` resolving to the *same*
  // page route file, so the component instance is preserved across selection
  // changes — no remount, no canvas state wipe, no flicker.
  const searchParams = useSearchParams();
  const routeId = searchParams.get("id");

  // Notes come from the storage layer's pub/sub. Cache holds full notes
  // (including hydrated `src` on image/pdf elements); disk writes auto-strip
  // src in writeNoteToBackend, so the cache and UI stay rich while the
  // .shannon files stay small.
  const notes = useSyncExternalStore(subscribeNotes, getNotesSnapshot, () => []);
  const notesRef = useRef<NoteItem[]>(notes);
  notesRef.current = notes;

  /** True once initializeNotesStorage() has resolved. Until then `notes`
   *  is empty for "we haven't checked yet" reasons, not "no match" — so we
   *  shouldn't show the 404 view based on `notes.find` misses. */
  const [notesLoaded, setNotesLoaded] = useState(false);
  const noteCounterRef = useRef<number>(1);
  /** Note ids whose image/pdf blobs have been pulled from disk in this session. */
  const hydratedRef = useRef<Set<string>>(new Set());

  const activeNote: NoteItem | null = routeId
    ? notes.find((n) => n.id === routeId) ?? null
    : null;
  const activeId = activeNote?.id ?? null;

  // ── One-shot init: hydrate the cache + read counter ─────────────────────

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await initializeNotesStorage();
        if (cancelled) return;

        const counter = await readNoteCounter();
        if (cancelled) return;
        if (counter > 1) {
          noteCounterRef.current = counter;
        } else {
          const loaded = getNotesSnapshot();
          if (loaded.length > 0) {
            const maxNum = Math.max(
              0,
              ...loaded.map((n) => {
                const m = /^Note #(\d+)$/.exec(n.title ?? "");
                return m ? parseInt(m[1], 10) : 0;
              }),
            );
            noteCounterRef.current = maxNum + 1;
            await writeNoteCounter(noteCounterRef.current);
          }
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("Failed to load notes:", e);
      } finally {
        if (!cancelled) setNotesLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Lazy hydrate: pull the active note's blobs in from disk once ────────
  // Other notes stay disk-shaped (no `src` on image/pdf) until the user
  // switches to them.

  useEffect(() => {
    if (!activeId) return;
    if (hydratedRef.current.has(activeId)) return;
    const note = getNote(activeId);
    if (!note) return;
    hydratedRef.current.add(activeId);
    let cancelled = false;
    (async () => {
      const { notes: [hydrated], migrated } = await prepareNotesForDisplay([note]);
      if (cancelled || !hydrated) return;
      // Cache update only — the on-disk file already has src stripped, no
      // need to rewrite. If migrateInlineBlobs assigned new blobIds, persist
      // so disk picks them up.
      if (migrated) void writeNote(hydrated);
      else setCachedNote(hydrated);
    })();
    return () => { cancelled = true; };
  }, [activeId]);

  // ── GC orphaned blob files once per session, deferred past first paint ──

  useEffect(() => {
    const timer = setTimeout(() => {
      void gcOrphanedBlobs(notesRef.current);
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  // ── Recents: track the active note in the native File → Open Recent menu.
  // Fires on every nav (even revisits) so re-opening bumps a note to the top,
  // and on title changes so renames propagate to the menu label. No-op
  // outside Tauri.
  useEffect(() => {
    if (!activeNote) return;
    void addRecent(activeNote.id, activeNote.title || "Untitled");
  }, [activeNote?.id, activeNote?.title]);

  // ── Canvas callbacks ────────────────────────────────────────────────────

  const handleNoteChange = useCallback((changed: NoteItem) => {
    const existing = getNote(changed.id);
    // Preserve locked + title — canvas holds stale copies of both.
    const merged: NoteItem = existing
      ? { ...changed, locked: changed.locked ?? existing.locked, title: existing.title }
      : changed;
    void writeNote(merged);
  }, []);

  const handleCreateNote = useCallback((firstElement: NoteItem["elements"][number]): NoteItem | null => {
    const note: NoteItem = {
      ...makeNote(noteCounterRef.current++),
      elements: [firstElement],
    };
    void writeNoteCounter(noteCounterRef.current);
    void writeNote(note);
    router.replace(`/notes?id=${note.id}`, { scroll: false });
    return note;
  }, [router]);

  const handleToggleLock = useCallback(() => {
    if (!activeId) return;
    const existing = getNote(activeId);
    if (!existing) return;
    void writeNote({ ...existing, locked: !existing.locked });
  }, [activeId]);

  // `?id=<unknown>` after notes have loaded → render the 404 view in the
  // canvas area. The `notesLoaded` gate avoids flashing 404 during the brief
  // window before initializeNotesStorage() resolves.
  if (routeId && notesLoaded && !activeNote) {
    return (
      <NotFoundView
        message="No note with that id."
        backHref="/notes"
        backLabel="Back to notes"
      />
    );
  }

  return (
    <NotesCanvas
      note={activeNote}
      onNoteChange={handleNoteChange}
      onCreateNote={handleCreateNote}
      locked={activeNote?.locked ?? false}
      onToggleLock={handleToggleLock}
    />
  );
}

export default function NotesPage() {
  // useSearchParams requires a Suspense boundary for static rendering.
  return (
    <Suspense fallback={null}>
      <NotesPageInner />
    </Suspense>
  );
}
