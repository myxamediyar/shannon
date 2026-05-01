"use client";

import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import NotesCanvas from "../../components/NotesCanvas";
import { NotFoundView } from "../../components/NotFoundView";
import { STORAGE_KEY } from "../../lib/canvas-types";

const NOTE_COUNTER_KEY = "shannon_note_counter";
import { makeNote } from "../../lib/canvas-utils";
import type { NoteItem, CanvasEl } from "../../lib/canvas-types";
import { gcOrphanedBlobs, prepareNotesForDisplay, stripNotesForPersist } from "../../lib/canvas-blob-store";

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

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

/** Save notes to localStorage with image/pdf `src` stripped (blobs live in IDB). */
function saveNotesToStorage(notes: NoteItem[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stripNotesForPersist(notes)));
  } catch (err) {
    // Shouldn't happen once blobs are in IDB, but log for visibility.
    console.warn("Failed to persist notes:", err);
  }
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

  // ── Sync structural load (pre-paint) ─────────────────────────────────────
  // Parses localStorage and sets notes without waiting for IDB. Image/pdf
  // elements will have `blobId` but no `src` until the lazy-hydrate effect
  // below fills them in for the active note.

  useIsoLayoutEffect(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsed: any[] = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");

      const saved = localStorage.getItem(NOTE_COUNTER_KEY);
      if (saved) {
        noteCounterRef.current = parseInt(saved, 10);
      } else if (parsed.length > 0) {
        const maxNum = Math.max(0, ...parsed.map((n) => {
          const m = /^Note #(\d+)$/.exec(n.title ?? "");
          return m ? parseInt(m[1], 10) : 0;
        }));
        noteCounterRef.current = maxNum + 1;
        localStorage.setItem(NOTE_COUNTER_KEY, String(noteCounterRef.current));
      }

      if (parsed.length === 0) return;

      const shapeNormalized: NoteItem[] = parsed.map((n) => ({
        id: n.id,
        title: n.title ?? "Untitled",
        updatedAt: n.updatedAt ?? Date.now(),
        elements: Array.isArray(n.elements)
          ? n.elements
          : Array.isArray(n.blocks)
          ? n.blocks.map((b: { type?: string; [k: string]: unknown }) => ({ ...b, type: b.type ?? "text" }))
          : n.content
          ? [{ id: crypto.randomUUID(), type: "text", x: 120, y: 140, text: n.content }]
          : [],
        locked: !!n.locked,
        pageRegions: Array.isArray(n.pageRegions) ? n.pageRegions : undefined,
      }));

      setNotes(shapeNormalized);
    } catch {
      setNotes([]);
    } finally {
      setNotesLoaded(true);
    }
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
      try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
        if (!Array.isArray(parsed)) return;
        const loaded: NoteItem[] = parsed.map((n: Record<string, unknown>) => ({
          id: n.id as string,
          title: (n.title as string) ?? "Untitled",
          updatedAt: (n.updatedAt as number) ?? Date.now(),
          elements: Array.isArray(n.elements) ? (n.elements as CanvasEl[]) : [],
          locked: !!n.locked,
          pageRegions: Array.isArray(n.pageRegions) ? (n.pageRegions as NoteItem["pageRegions"]) : undefined,
        }));
        // Preserve already-hydrated blob srcs across the structural reload.
        const prevById = new Map(notesRef.current.map((n) => [n.id, n]));
        const merged = loaded.map((n) => {
          const prev = prevById.get(n.id);
          return prev ? patchWithHydratedSrcs(n, prev) : n;
        });
        setNotes(merged);
        // Drop hydratedRef entries for notes that no longer exist.
        const existingIds = new Set(merged.map((n) => n.id));
        for (const id of [...hydratedRef.current]) {
          if (!existingIds.has(id)) hydratedRef.current.delete(id);
        }
        const rid = routeIdRef.current;
        if (rid && !existingIds.has(rid)) {
          router.replace("/notes", { scroll: false });
        }
      } catch { /* ignore */ }
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
    localStorage.setItem(NOTE_COUNTER_KEY, String(noteCounterRef.current));
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
