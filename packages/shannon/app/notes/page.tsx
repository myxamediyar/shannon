"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import NotesCanvas from "../../components/NotesCanvas";
import { NotFoundView } from "../../components/NotFoundView";
import { makeNote } from "../../lib/canvas-utils";
import type { NoteItem, CanvasEl } from "../../lib/canvas-types";
import { gcOrphanedBlobs, prepareNotesForDisplay, stripNotesForPersist } from "../../lib/canvas-blob-store";
import {
  initializeNotesStorage,
  getAllNotes,
  saveAllNotes,
  readNoteCounter,
  writeNoteCounter,
} from "../../lib/platform/notes-storage";

/** Merge hydrated srcs back into the current note, leaving every other field
 *  alone. Protects user edits made during the hydration window. */
function patchWithHydratedSrcs(current: NoteItem, hydrated: NoteItem): NoteItem {
  const srcByBlobId = new Map<string, string>();
  for (const el of hydrated.elements) {
    if ((el.type === "image" || el.type === "pdf") && el.blobId && el.src) {
      srcByBlobId.set(el.blobId, el.src);
    }
  }
  if (srcByBlobId.size === 0) return current;
  const elements = current.elements.map((el) => {
    if ((el.type === "image" || el.type === "pdf") && el.blobId && !el.src) {
      const src = srcByBlobId.get(el.blobId);
      if (src) return { ...el, src };
    }
    return el;
  });
  return { ...current, elements };
}

/** Persist notes via the platform adapter (one .shannon file per note in
 *  Tauri / via /api/notes in web mode). Image/pdf `src` is stripped first
 *  because blobs still live in IndexedDB until Phase 3b. */
function saveNotesToStorage(notes: NoteItem[]) {
  saveAllNotes(stripNotesForPersist(notes)).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn("Failed to persist notes:", err);
  });
}

function NotesPageInner() {
  const router = useRouter();
  // Active note is identified by `?id=<noteId>`. Using a search param (not a
  // path segment) keeps `/notes` and `/notes?id=…` resolving to the *same*
  // page route file, so the component instance is preserved across selection
  // changes — no remount, no canvas state wipe, no flicker.
  const searchParams = useSearchParams();
  const routeId = searchParams.get("id");
  const routeIdRef = useRef(routeId);
  routeIdRef.current = routeId;

  const [notes, setNotes] = useState<NoteItem[]>([]);
  /** True once the structural load effect below has run at least once. Until
   *  then `notes` is empty for reasons of "we haven't checked yet", not "no
   *  match" — so we shouldn't show the 404 view based on `notes.find` misses. */
  const [notesLoaded, setNotesLoaded] = useState(false);
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const noteCounterRef = useRef<number>(1);
  /** Note ids whose image/pdf blobs have been pulled from IDB in this session. */
  const hydratedRef = useRef<Set<string>>(new Set());

  const activeNote: NoteItem | null = routeId
    ? notes.find((n) => n.id === routeId) ?? null
    : null;
  const activeId = activeNote?.id ?? null;

  // ── Async structural load ────────────────────────────────────────────────
  // Hydrates the platform adapter (reads ~/.shannon/notes/*.shannon in Tauri
  // or fetches /api/notes in web mode), then sets notes from the cache.
  // Image/pdf elements will have `blobId` but no `src` until the lazy-hydrate
  // effect below fills them in for the active note.

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await initializeNotesStorage();
        if (cancelled) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const loaded = getAllNotes() as any[];

        const counter = await readNoteCounter();
        if (cancelled) return;
        if (counter > 1) {
          noteCounterRef.current = counter;
        } else if (loaded.length > 0) {
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

        const shapeNormalized: NoteItem[] = loaded.map((n) => ({
          id: n.id,
          title: n.title ?? "Untitled",
          updatedAt: n.updatedAt ?? Date.now(),
          elements: Array.isArray(n.elements)
            ? n.elements
            : Array.isArray(n.blocks)
            ? n.blocks.map((b: { type?: string; [k: string]: unknown }) => ({
                ...b,
                type: b.type ?? "text",
              }))
            : n.content
            ? [{ id: crypto.randomUUID(), type: "text", x: 120, y: 140, text: n.content }]
            : [],
          locked: !!n.locked,
          pageRegions: Array.isArray(n.pageRegions) ? n.pageRegions : undefined,
        }));

        if (!cancelled) setNotes(shapeNormalized);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("Failed to load notes:", e);
        if (!cancelled) setNotes([]);
      } finally {
        if (!cancelled) setNotesLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Lazy hydrate: only fetch the active note's blobs from IDB ────────────
  // Other notes stay structural until the user switches to them.

  useEffect(() => {
    if (!activeId) return;
    if (hydratedRef.current.has(activeId)) return;
    const note = notesRef.current.find((n) => n.id === activeId);
    if (!note) return;
    hydratedRef.current.add(activeId);
    let cancelled = false;
    (async () => {
      const { notes: [hydrated], migrated } = await prepareNotesForDisplay([note]);
      if (cancelled || !hydrated) return;
      setNotes((prev) =>
        prev.map((n) => (n.id === activeId ? patchWithHydratedSrcs(n, hydrated) : n)),
      );
      if (migrated) {
        // Persist post-migration so inline data: URLs get flushed out of localStorage.
        setTimeout(() => saveNotesToStorage(notesRef.current), 0);
      }
    })();
    return () => { cancelled = true; };
  }, [activeId]);

  // ── GC orphaned IDB blobs once per session, deferred past first paint ──

  useEffect(() => {
    const timer = setTimeout(() => {
      void gcOrphanedBlobs(notesRef.current);
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  // ── Sync with sidebar (notes:updated = sidebar changed localStorage) ────
  // Structural reload only. Already-hydrated srcs are preserved by patching
  // them onto the reloaded notes; deleted notes drop out of hydratedRef.
  // If the active route points at a note that no longer exists (e.g. deleted
  // in another tab), drop the search param.

  useEffect(() => {
    const reload = () => {
      // Cache is already up-to-date — whoever fired notes:updated wrote
      // through the platform adapter, which mutated the cache before
      // dispatching. Just re-read it.
      const loaded = getAllNotes().map((n) => ({
        id: n.id,
        title: n.title ?? "Untitled",
        updatedAt: n.updatedAt ?? Date.now(),
        elements: Array.isArray(n.elements) ? n.elements : ([] as CanvasEl[]),
        locked: !!n.locked,
        pageRegions: Array.isArray(n.pageRegions) ? n.pageRegions : undefined,
      })) as NoteItem[];
      // Preserve already-hydrated blob srcs across the structural reload.
      const prevById = new Map(notesRef.current.map((n) => [n.id, n]));
      const merged = loaded.map((n) => {
        const prev = prevById.get(n.id);
        return prev ? patchWithHydratedSrcs(n, prev) : n;
      });
      setNotes(merged);
      const existingIds = new Set(merged.map((n) => n.id));
      for (const id of [...hydratedRef.current]) {
        if (!existingIds.has(id)) hydratedRef.current.delete(id);
      }
      const rid = routeIdRef.current;
      if (rid && !existingIds.has(rid)) {
        router.replace("/notes", { scroll: false });
      }
    };
    window.addEventListener("notes:updated", reload);
    return () => window.removeEventListener("notes:updated", reload);
  }, [router]);

  // ── Callbacks for canvas ────────────────────────────────────────────────

  const saveNotes = useCallback((updated: NoteItem[]) => {
    saveNotesToStorage(updated);
    setTimeout(() => window.dispatchEvent(new Event("notes:updated")), 0);
  }, []);

  const handleNoteChange = useCallback((changed: NoteItem) => {
    setNotes((prev) => {
      const next = prev.map((n) => {
        if (n.id !== changed.id) return n;
        // Preserve locked + title — canvas holds stale copies of both
        return { ...changed, locked: changed.locked ?? n.locked, title: n.title };
      });
      saveNotes(next);
      return next;
    });
  }, [saveNotes]);

  const handleCreateNote = useCallback((firstElement: CanvasEl): NoteItem | null => {
    const note: NoteItem = {
      ...makeNote(noteCounterRef.current++),
      elements: [firstElement],
    };
    void writeNoteCounter(noteCounterRef.current);
    setNotes((prev) => {
      const next = [note, ...prev];
      saveNotes(next);
      return next;
    });
    router.replace(`/notes?id=${note.id}`, { scroll: false });
    return note;
  }, [saveNotes, router]);

  const handleToggleLock = useCallback(() => {
    if (!activeId) return;
    setNotes((prev) => {
      const next = prev.map((n) =>
        n.id === activeId ? { ...n, locked: !n.locked } : n
      );
      saveNotes(next);
      return next;
    });
  }, [activeId, saveNotes]);

  // `?id=<unknown>` after notes have loaded → render the 404 view in the
  // canvas area. The `notesLoaded` gate avoids flashing 404 during the brief
  // window before the structural load effect has parsed localStorage.
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
