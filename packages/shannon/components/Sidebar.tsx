"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import type { NoteItem } from "../lib/canvas-types";
import { prepareNotesForDisplay, stripNotesForPersist } from "../lib/canvas-blob-store";
import { exportNoteAsShannon, importShannonNote } from "../lib/canvas-export-shannon";
import {
  subscribeNotes,
  getNotesSnapshot,
  subscribeFolders,
  getFoldersSnapshot,
  getNote,
  writeNote,
  deleteNote as deleteNoteFromStore,
  writeFolders,
} from "../lib/platform/notes-storage";
import { saveBlobWithDialog } from "../lib/platform/save";
import { removeRecent, updateRecentTitle } from "../lib/platform/recents";
import { requestExportHtml } from "../lib/canvas-actions-store";

const navItems = [
  { icon: "dashboard", label: "Dashboard", href: "/" },
  { icon: "tune", label: "Model", href: "/model" },
  { icon: "settings", label: "Settings", href: "/settings" },
];

type SidebarNote = { id: string; title?: string };

function sanitizeFilename(name: string): string {
  return (name || "Untitled").replace(/[\\/?%*:|"<>]/g, "-").trim().slice(0, 100) || "Untitled";
}

async function loadFullNote(noteId: string): Promise<NoteItem | null> {
  const found = getNote(noteId);
  if (!found) return null;
  const { notes } = await prepareNotesForDisplay([found]);
  return notes[0] ?? null;
}

// Unified sidebar tree. Root holds notes and folders interleaved; folders hold
// only notes (no nesting). Order in the tree is the display order — this is
// the single source of truth for ordering.
type TreeNote = { type: "note"; id: string };
type TreeFolder = {
  type: "folder";
  id: string;
  name: string;
  expanded: boolean;
  children: TreeNote[];
};
type TreeItem = TreeNote | TreeFolder;

type DropTarget =
  | { kind: "root-end" }
  | { kind: "folder-end"; folderId: string }
  | {
      kind: "beside";
      parentFolderId: string | null;
      siblingId: string;
      position: "above" | "below";
    };

function sanitizeTree(raw: unknown): TreeItem[] {
  if (!Array.isArray(raw)) return [];
  const out: TreeItem[] = [];
  const seen = new Set<string>();
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    const t = (it as { type?: string }).type;
    const id = (it as { id?: string }).id;
    if (typeof id !== "string" || seen.has(id)) continue;
    if (t === "note") {
      seen.add(id);
      out.push({ type: "note", id });
    } else if (t === "folder") {
      const name = (it as { name?: string }).name;
      const expanded = !!(it as { expanded?: boolean }).expanded;
      const childrenRaw = (it as { children?: unknown }).children;
      const children = sanitizeTree(childrenRaw).filter(
        (c): c is TreeNote => c.type === "note" && !seen.has(c.id)
      );
      for (const c of children) seen.add(c.id);
      seen.add(id);
      out.push({
        type: "folder",
        id,
        name: typeof name === "string" ? name : "Folder",
        expanded,
        children,
      });
    }
  }
  return out;
}

function migrateOldFormat(
  oldFolders: unknown,
  noteFolder: unknown,
  noteIds: string[],
): TreeItem[] {
  if (!Array.isArray(oldFolders)) return [];
  const nf: Record<string, string> =
    noteFolder && typeof noteFolder === "object"
      ? Object.fromEntries(
          Object.entries(noteFolder as Record<string, unknown>).filter(
            ([, v]) => typeof v === "string"
          ) as [string, string][]
        )
      : {};
  const tree: TreeItem[] = [];
  const folderMap = new Map<string, TreeFolder>();
  for (const f of oldFolders as unknown[]) {
    if (!f || typeof f !== "object") continue;
    const id = (f as { id?: unknown }).id;
    const name = (f as { name?: unknown }).name;
    const expanded = !!(f as { expanded?: unknown }).expanded;
    if (typeof id !== "string" || typeof name !== "string") continue;
    const tf: TreeFolder = { type: "folder", id, name, expanded, children: [] };
    tree.push(tf);
    folderMap.set(id, tf);
  }
  for (const nid of noteIds) {
    const fid = nf[nid];
    const target = fid ? folderMap.get(fid) : null;
    if (target) target.children.push({ type: "note", id: nid });
    else tree.push({ type: "note", id: nid });
  }
  return tree;
}

function parseTree(raw: unknown, noteIds: string[]): TreeItem[] {
  if (!raw || typeof raw !== "object") return [];
  if (Array.isArray((raw as { tree?: unknown }).tree)) {
    return sanitizeTree((raw as { tree: unknown }).tree);
  }
  // Old {folders, noteFolder} → migrate lazily.
  const oldFolders = (raw as { folders?: unknown }).folders;
  const oldMap = (raw as { noteFolder?: unknown }).noteFolder;
  if (Array.isArray(oldFolders)) return migrateOldFormat(oldFolders, oldMap, noteIds);
  return [];
}

function cloneTree(tree: TreeItem[]): TreeItem[] {
  return tree.map((n) =>
    n.type === "folder"
      ? { ...n, children: n.children.map((c) => ({ ...c })) }
      : { ...n }
  );
}

function reconcileTree(
  tree: TreeItem[],
  noteIds: Set<string>
): { tree: TreeItem[]; dirty: boolean } {
  let dirty = false;
  const seen = new Set<string>();
  const clean = (items: TreeItem[]): TreeItem[] => {
    const out: TreeItem[] = [];
    for (const it of items) {
      if (it.type === "note") {
        if (noteIds.has(it.id) && !seen.has(it.id)) {
          seen.add(it.id);
          out.push(it);
        } else {
          dirty = true;
        }
      } else {
        const children = clean(it.children) as TreeNote[];
        if (children.length !== it.children.length) dirty = true;
        seen.add(it.id);
        out.push({ ...it, children });
      }
    }
    return out;
  };
  const cleaned = clean(tree);
  // Prepend new notes (notes array is newest-first, so preserving that order
  // here puts the newest at the top of the tree).
  const toAdd: TreeNote[] = [];
  for (const nid of noteIds) {
    if (!seen.has(nid)) {
      toAdd.push({ type: "note", id: nid });
      dirty = true;
    }
  }
  if (toAdd.length > 0) cleaned.unshift(...toAdd);
  return { tree: cleaned, dirty };
}

function moveItem(
  tree: TreeItem[],
  itemId: string,
  target: DropTarget
): TreeItem[] {
  if (target.kind === "beside" && target.siblingId === itemId) return tree;
  const t = cloneTree(tree);
  let item: TreeItem | null = null;
  const removeFrom = (arr: TreeItem[]): boolean => {
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].id === itemId) {
        item = arr[i];
        arr.splice(i, 1);
        return true;
      }
    }
    return false;
  };
  if (!removeFrom(t)) {
    for (const n of t) {
      if (n.type === "folder" && removeFrom(n.children)) break;
    }
  }
  if (!item) return tree;
  const theItem = item as TreeItem;

  if (target.kind === "root-end") {
    t.push(theItem);
  } else if (target.kind === "folder-end") {
    if (theItem.type !== "note") return tree;
    const folder = t.find(
      (n): n is TreeFolder => n.type === "folder" && n.id === target.folderId
    );
    if (!folder) return tree;
    folder.children.push(theItem);
  } else {
    if (target.parentFolderId === null) {
      const idx = t.findIndex((n) => n.id === target.siblingId);
      if (idx < 0) return tree;
      t.splice(target.position === "above" ? idx : idx + 1, 0, theItem);
    } else {
      if (theItem.type !== "note") return tree;
      const folder = t.find(
        (n): n is TreeFolder =>
          n.type === "folder" && n.id === target.parentFolderId
      );
      if (!folder) return tree;
      const idx = folder.children.findIndex((n) => n.id === target.siblingId);
      if (idx < 0) return tree;
      folder.children.splice(
        target.position === "above" ? idx : idx + 1,
        0,
        theItem
      );
    }
  }
  return t;
}

function updateFolder(
  tree: TreeItem[],
  folderId: string,
  patch: Partial<Omit<TreeFolder, "type" | "id" | "children">>
): TreeItem[] {
  return tree.map((n) =>
    n.type === "folder" && n.id === folderId ? { ...n, ...patch } : n
  );
}

function removeFolder(tree: TreeItem[], folderId: string): TreeItem[] {
  // Folder's children spill back to root at the folder's position.
  const out: TreeItem[] = [];
  for (const n of tree) {
    if (n.type === "folder" && n.id === folderId) {
      for (const c of n.children) out.push(c);
    } else {
      out.push(n);
    }
  }
  return out;
}

function removeNoteFromTree(tree: TreeItem[], noteId: string): TreeItem[] {
  const out: TreeItem[] = [];
  for (const n of tree) {
    if (n.type === "note") {
      if (n.id !== noteId) out.push(n);
    } else {
      out.push({ ...n, children: n.children.filter((c) => c.id !== noteId) });
    }
  }
  return out;
}

interface Props {
  collapsed: boolean;
  onToggle: () => void;
}

export default function Sidebar(props: Props) {
  // useSearchParams requires a Suspense boundary on any caller that might
  // be statically rendered. Sidebar lives in the root layout and so renders
  // for every route — including `/_not-found`, which Next prerenders during
  // build. Wrapping the body keeps the requirement localized.
  return (
    <Suspense fallback={null}>
      <SidebarBody {...props} />
    </Suspense>
  );
}

function SidebarBody({ collapsed, onToggle }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The active note id is `?id=<noteId>` on /notes. Derived, no local state.
  const activeNoteId = pathname.startsWith("/notes")
    ? searchParams.get("id")
    : null;

  const currentIcon =
    pathname.startsWith("/notes")
      ? "edit_note"
      : navItems.find(
          (item) =>
            pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href))
        )?.icon ?? "dashboard";

  // Notes and folder tree come straight from the storage layer's pub/sub.
  // No local copy, no event listeners, no localStorage round-trip — every
  // mutation goes through writeNote/deleteNoteFromStore/writeFolders, which
  // updates the cache and notifies subscribers.
  const allNotes = useSyncExternalStore(subscribeNotes, getNotesSnapshot, () => []);
  const notes = useMemo<SidebarNote[]>(
    () => allNotes.map((n) => ({ id: n.id, title: n.title })),
    [allNotes],
  );
  const notesRef = useRef<SidebarNote[]>(notes);
  notesRef.current = notes;

  const foldersRaw = useSyncExternalStore(subscribeFolders, getFoldersSnapshot<unknown>, () => null);
  const tree = useMemo<TreeItem[]>(
    () => parseTree(foldersRaw, notes.map((n) => n.id)),
    [foldersRaw, notes],
  );
  const writeTree = (next: TreeItem[]) => { void writeFolders({ tree: next }); };

  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  const [folderMenuOpenId, setFolderMenuOpenId] = useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [folderRenameValue, setFolderRenameValue] = useState("");
  const folderMenuRef = useRef<HTMLDivElement>(null);

  // Drag source: exactly one of these is non-null during a drag.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [draggingKind, setDraggingKind] = useState<"note" | "folder" | null>(null);

  // Drop indicators — keyed by target id + position.
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<"above" | "below" | null>(null);
  // When dragging a note onto a folder header (to append inside).
  const [dropIntoFolderId, setDropIntoFolderId] = useState<string | null>(null);
  const [dragOverRoot, setDragOverRoot] = useState(false);

  // Tracks the currently hovered row so we can clear highlights on drag start.
  // CSS :hover alone isn't enough — browsers lock :hover on the drag source.
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Row-options dropdown flips above the button when there isn't enough room
  // below inside the scrollable nav.
  const [menuFlipUp, setMenuFlipUp] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState<
    { kind: "note" | "folder"; id: string; name: string } | null
  >(null);

  const openRowMenu = (
    btn: HTMLElement,
    open: (flipUp: boolean) => void,
    estimatedMenuHeight = 84,
  ) => {
    const btnRect = btn.getBoundingClientRect();
    const nav = btn.closest("nav");
    const bottomEdge = nav
      ? nav.getBoundingClientRect().bottom
      : window.innerHeight;
    open(bottomEdge - btnRect.bottom < estimatedMenuHeight);
  };

  const handleImportNote = () => {
    if (typeof window === "undefined") return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".shannon,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const imported = await importShannonNote(file);
        const persisted = stripNotesForPersist([imported])[0];
        await writeNote(persisted);
        router.push(`/notes?id=${imported.id}`, { scroll: false });
      } catch (err) {
        console.error("Import failed:", err);
        alert(
          "Failed to import note: " +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    };
    input.click();
  };

  const handleExportShannon = async (noteId: string) => {
    const note = await loadFullNote(noteId);
    if (!note) return;
    const blob = await exportNoteAsShannon(note);
    await saveBlobWithDialog(
      blob,
      `${sanitizeFilename(note.title)}.shannon`,
      [{ name: "Shannon Note", extensions: ["shannon"] }],
    );
  };

  const handleExportHtml = (noteId: string) => {
    if (typeof window === "undefined") return;
    // Park the request in the canvas-actions store and navigate (or just
    // re-fire if we're already on the target note). The canvas subscribes
    // to the store and consumes the request once its active id matches.
    requestExportHtml(noteId);
    if (activeNoteId !== noteId) {
      router.push(`/notes?id=${noteId}`, { scroll: false });
    }
  };

  // Reconcile: add new notes to root, strip nodes for deleted notes. The
  // store already drives re-renders when notes/folders change; this effect
  // just persists the diff back when the live `notes` set has drifted from
  // the tree (note added/deleted elsewhere).
  useEffect(() => {
    const ids = new Set(notes.map((n) => n.id));
    const { tree: next, dirty } = reconcileTree(tree, ids);
    if (dirty) writeTree(next);
    // Depend only on notes to avoid reconcile loops when tree changes are
    // already consistent with notes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes]);

  useEffect(() => {
    if (!menuOpenId) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpenId(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpenId]);

  useEffect(() => {
    if (!folderMenuOpenId) return;
    const handler = (e: MouseEvent) => {
      if (
        folderMenuRef.current &&
        !folderMenuRef.current.contains(e.target as Node)
      ) {
        setFolderMenuOpenId(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [folderMenuOpenId]);

  const commitRename = (noteId: string) => {
    const trimmed = renameValue.trim();
    setRenamingId(null);
    const newTitle = trimmed || "Untitled";
    const existing = getNote(noteId);
    if (existing) void writeNote({ ...existing, title: newTitle });
    // Keep the native File → Open Recent label in sync when renaming a
    // non-active note (the active-note path is covered by page.tsx's
    // effect on activeNote.title).
    void updateRecentTitle(noteId, newTitle);
  };

  const deleteNote = (noteId: string) => {
    void deleteNoteFromStore(noteId);
    void removeRecent(noteId);
    if (activeNoteId === noteId) {
      router.replace("/notes", { scroll: false });
    }
    const next = removeNoteFromTree(tree, noteId);
    if (next !== tree) writeTree(next);
  };

  const createFolder = () => {
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `f_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const folder: TreeFolder = {
      type: "folder",
      id,
      name: "New Folder",
      expanded: true,
      children: [],
    };
    const next = [folder, ...tree];
    writeTree(next);
    setFolderRenameValue(folder.name);
    setRenamingFolderId(id);
  };

  const toggleFolder = (folderId: string) => {
    const current = tree.find(
      (n): n is TreeFolder => n.type === "folder" && n.id === folderId
    );
    if (!current) return;
    const next = updateFolder(tree, folderId, { expanded: !current.expanded });
    writeTree(next);
  };

  const commitFolderRename = (folderId: string) => {
    const trimmed = folderRenameValue.trim();
    setRenamingFolderId(null);
    const name = trimmed || "Untitled";
    const next = updateFolder(tree, folderId, { name });
    writeTree(next);
  };

  const deleteFolder = (folderId: string) => {
    const next = removeFolder(tree, folderId);
    writeTree(next);
  };

  const applyMove = (itemId: string, target: DropTarget) => {
    // Auto-expand a destination folder so the move lands in view.
    let working = tree;
    if (target.kind === "folder-end") {
      working = updateFolder(working, target.folderId, { expanded: true });
    } else if (target.kind === "beside" && target.parentFolderId) {
      working = updateFolder(working, target.parentFolderId, { expanded: true });
    }
    const next = moveItem(working, itemId, target);
    if (next === working && working === tree) return;
    writeTree(next);
  };

  const clearDragState = () => {
    setDraggingId(null);
    setDraggingKind(null);
    setDropTargetId(null);
    setDropPosition(null);
    setDropIntoFolderId(null);
    setDragOverRoot(false);
    setHoveredId(null);
  };

  // Which folder (if any) currently contains a given note id in the tree.
  const noteParentFolderId = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const n of tree) {
      if (n.type === "note") map.set(n.id, null);
      else for (const c of n.children) map.set(c.id, n.id);
    }
    return map;
  }, [tree]);

  const renderNote = (noteId: string, parentFolderId: string | null) => {
    const note = notes.find((n) => n.id === noteId);
    if (!note) return null;
    const indent = parentFolderId !== null;
    const isActive = activeNoteId === note.id;
    const isRenaming = renamingId === note.id;
    const isMenuOpen = menuOpenId === note.id;
    const isDragging = draggingId === note.id && draggingKind === "note";
    const isHovered = hoveredId === note.id && !draggingId;
    const showAbove =
      dropTargetId === note.id && dropPosition === "above" && !!draggingId;
    const showBelow =
      dropTargetId === note.id && dropPosition === "below" && !!draggingId;

    return (
      <div
        key={note.id}
        draggable={!isRenaming}
        onMouseEnter={() => setHoveredId(note.id)}
        onMouseLeave={() =>
          setHoveredId((p) => (p === note.id ? null : p))
        }
        onDragStart={(e) => {
          setDraggingId(note.id);
          setDraggingKind("note");
          setHoveredId(null);
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", note.id);
        }}
        onDragEnd={clearDragState}
        onDragOver={(e) => {
          if (!draggingId || draggingId === note.id) return;
          // Folders can't be dropped inside a note-row position.
          if (draggingKind === "folder" && parentFolderId !== null) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
          const rect = e.currentTarget.getBoundingClientRect();
          const pos: "above" | "below" =
            e.clientY < rect.top + rect.height / 2 ? "above" : "below";
          if (dropTargetId !== note.id || dropPosition !== pos) {
            setDropTargetId(note.id);
            setDropPosition(pos);
          }
          if (dropIntoFolderId) setDropIntoFolderId(null);
          if (dragOverRoot) setDragOverRoot(false);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          if (dropTargetId === note.id) {
            setDropTargetId(null);
            setDropPosition(null);
          }
        }}
        onDrop={(e) => {
          if (!draggingId || draggingId === note.id) return;
          if (draggingKind === "folder" && parentFolderId !== null) return;
          e.preventDefault();
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          const pos: "above" | "below" =
            e.clientY < rect.top + rect.height / 2 ? "above" : "below";
          applyMove(draggingId, {
            kind: "beside",
            parentFolderId,
            siblingId: note.id,
            position: pos,
          });
          clearDragState();
        }}
        className={`relative flex items-center gap-2 rounded-lg transition-colors duration-150 ${
          isActive
            ? "bg-[var(--th-surface-raised)] shadow-[inset_2px_0_0_var(--th-border-30)]"
            : isHovered
            ? "bg-[var(--th-surface-hover)]"
            : ""
        } ${isDragging ? "opacity-50" : ""}`}
        style={{ paddingLeft: indent ? 16 : 0 }}
      >
        {(showAbove || showBelow) && (
          <div
            className="absolute pointer-events-none rounded-full"
            style={{
              left: indent ? 20 : 8,
              right: 8,
              height: 2,
              background: "var(--th-text-secondary)",
              top: showAbove ? -3 : undefined,
              bottom: showBelow ? -3 : undefined,
            }}
          />
        )}
        {isRenaming ? (
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={() => commitRename(note.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename(note.id);
              if (e.key === "Escape") setRenamingId(null);
            }}
            className="min-w-0 flex-1 mx-3 my-1.5 px-1.5 py-0.5 bg-[var(--th-surface-raised)] border border-[var(--th-border-30)] rounded text-[0.75rem] font-lexend tracking-tight text-[var(--th-text-secondary)] outline-none focus:border-[var(--th-text-faint)]"
          />
        ) : (
          <Link
            href={`/notes?id=${note.id}`}
            draggable={false}
            scroll={false}
            className={`min-w-0 flex-1 px-3 py-2 text-[0.75rem] font-lexend tracking-tight truncate ${
              isActive
                ? "text-[var(--th-text-secondary)] font-semibold"
                : "text-[var(--th-text-secondary)]"
            }`}
          >
            {note.title?.trim() || "Untitled"}
          </Link>
        )}
        {!isRenaming && (
          <div className="relative" ref={isMenuOpen ? menuRef : undefined}>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (isMenuOpen) {
                  setMenuOpenId(null);
                  return;
                }
                openRowMenu(e.currentTarget, setMenuFlipUp, 148);
                setMenuOpenId(note.id);
              }}
              className={`mr-2 h-6 w-6 flex items-center justify-center rounded text-[var(--th-text-faint)] hover:text-[var(--th-text-secondary)] hover:bg-[var(--th-surface-hover)] transition-all ${
                isHovered || isMenuOpen ? "opacity-100" : "opacity-0"
              }`}
              title="Note options"
              aria-label="Note options"
            >
              <span className="material-symbols-outlined text-[14px]">more_horiz</span>
            </button>
            {isMenuOpen && (
              <div className={`absolute right-0 ${menuFlipUp ? "bottom-full mb-1" : "top-full mt-1"} z-[60] w-40 bg-[var(--th-surface-raised)] border border-[var(--th-border-30)] rounded-md shadow-xl py-1`}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpenId(null);
                    setRenameValue(note.title?.trim() || "");
                    setRenamingId(note.id);
                  }}
                  className="w-full px-3 py-1.5 text-left text-[0.7rem] font-lexend text-[var(--th-text-secondary)] hover:bg-[var(--th-surface-hover)] flex items-center gap-2"
                >
                  <span className="material-symbols-outlined text-[14px]">edit</span>
                  Rename
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpenId(null);
                    handleExportHtml(note.id);
                  }}
                  className="w-full px-3 py-1.5 text-left text-[0.7rem] font-lexend text-[var(--th-text-secondary)] hover:bg-[var(--th-surface-hover)] flex items-center gap-2"
                >
                  <span className="material-symbols-outlined text-[14px]">html</span>
                  Export HTML
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpenId(null);
                    void handleExportShannon(note.id);
                  }}
                  className="w-full px-3 py-1.5 text-left text-[0.7rem] font-lexend text-[var(--th-text-secondary)] hover:bg-[var(--th-surface-hover)] flex items-center gap-2"
                >
                  <span className="material-symbols-outlined text-[14px]">download</span>
                  Export Shannon
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpenId(null);
                    setConfirmDelete({
                      kind: "note",
                      id: note.id,
                      name: note.title?.trim() || "Untitled",
                    });
                  }}
                  className="w-full px-3 py-1.5 text-left text-[0.7rem] font-lexend text-red-400 hover:bg-[var(--th-surface-hover)] flex items-center gap-2"
                >
                  <span className="material-symbols-outlined text-[14px]">delete</span>
                  Delete
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderFolder = (folder: TreeFolder) => {
    const isRenaming = renamingFolderId === folder.id;
    const isMenuOpen = folderMenuOpenId === folder.id;
    const isDragging = draggingId === folder.id && draggingKind === "folder";
    const isHovered = hoveredId === folder.id && !draggingId;
    const isDropInto = dropIntoFolderId === folder.id;
    const showAbove =
      dropTargetId === folder.id && dropPosition === "above" && !!draggingId;
    const showBelow =
      dropTargetId === folder.id && dropPosition === "below" && !!draggingId;

    return (
      <div key={folder.id}>
        <div
          draggable={!isRenaming}
          onMouseEnter={() => setHoveredId(folder.id)}
          onMouseLeave={() =>
            setHoveredId((p) => (p === folder.id ? null : p))
          }
          onDragStart={(e) => {
            setDraggingId(folder.id);
            setDraggingKind("folder");
            setHoveredId(null);
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", folder.id);
          }}
          onDragEnd={clearDragState}
          onDragOver={(e) => {
            if (!draggingId || draggingId === folder.id) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            const rect = e.currentTarget.getBoundingClientRect();
            const third = rect.height / 3;
            // For notes: top third = above folder, bottom third = below folder,
            // middle = drop INTO folder. For folders: above/below only.
            let mode: "above" | "into" | "below";
            if (draggingKind === "folder") {
              mode = e.clientY < rect.top + rect.height / 2 ? "above" : "below";
            } else {
              if (e.clientY < rect.top + third) mode = "above";
              else if (e.clientY > rect.bottom - third) mode = "below";
              else mode = "into";
            }
            if (mode === "into") {
              if (dropIntoFolderId !== folder.id) setDropIntoFolderId(folder.id);
              if (dropTargetId) {
                setDropTargetId(null);
                setDropPosition(null);
              }
            } else {
              if (dropTargetId !== folder.id || dropPosition !== mode) {
                setDropTargetId(folder.id);
                setDropPosition(mode);
              }
              if (dropIntoFolderId) setDropIntoFolderId(null);
            }
            if (dragOverRoot) setDragOverRoot(false);
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node)) return;
            if (dropTargetId === folder.id) {
              setDropTargetId(null);
              setDropPosition(null);
            }
            if (dropIntoFolderId === folder.id) setDropIntoFolderId(null);
          }}
          onDrop={(e) => {
            if (!draggingId || draggingId === folder.id) return;
            e.preventDefault();
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            const third = rect.height / 3;
            if (draggingKind === "folder") {
              const pos: "above" | "below" =
                e.clientY < rect.top + rect.height / 2 ? "above" : "below";
              applyMove(draggingId, {
                kind: "beside",
                parentFolderId: null,
                siblingId: folder.id,
                position: pos,
              });
            } else {
              let mode: "above" | "into" | "below";
              if (e.clientY < rect.top + third) mode = "above";
              else if (e.clientY > rect.bottom - third) mode = "below";
              else mode = "into";
              if (mode === "into") {
                applyMove(draggingId, { kind: "folder-end", folderId: folder.id });
              } else {
                applyMove(draggingId, {
                  kind: "beside",
                  parentFolderId: null,
                  siblingId: folder.id,
                  position: mode,
                });
              }
            }
            clearDragState();
          }}
          className={`relative flex items-center gap-1 rounded-lg transition-colors duration-150 ${
            isDropInto
              ? "bg-[var(--th-surface-hover)] ring-1 ring-[var(--th-border-30)]"
              : isHovered
              ? "bg-[var(--th-surface-hover)]"
              : ""
          } ${isDragging ? "opacity-50" : ""}`}
        >
          {(showAbove || showBelow) && (
            <div
              className="absolute pointer-events-none rounded-full"
              style={{
                left: 8,
                right: 8,
                height: 2,
                background: "var(--th-text-secondary)",
                top: showAbove ? -3 : undefined,
                bottom: showBelow ? -3 : undefined,
              }}
            />
          )}
          <button
            type="button"
            onClick={() => toggleFolder(folder.id)}
            className="ml-1 h-6 w-6 flex items-center justify-center rounded text-[var(--th-text-faint)] hover:text-[var(--th-text-secondary)] transition-colors flex-shrink-0"
            aria-label={folder.expanded ? "Collapse folder" : "Expand folder"}
          >
            <span className="material-symbols-outlined text-[16px]">
              {folder.expanded ? "keyboard_arrow_down" : "chevron_right"}
            </span>
          </button>
          <span className="material-symbols-outlined text-[16px] flex-shrink-0 text-[var(--th-text-muted)]">
            {folder.expanded ? "folder_open" : "folder"}
          </span>
          {isRenaming ? (
            <input
              autoFocus
              value={folderRenameValue}
              onChange={(e) => setFolderRenameValue(e.target.value)}
              onBlur={() => commitFolderRename(folder.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitFolderRename(folder.id);
                if (e.key === "Escape") setRenamingFolderId(null);
              }}
              className="min-w-0 flex-1 ml-1 mr-2 my-1.5 px-1.5 py-0.5 bg-[var(--th-surface-raised)] border border-[var(--th-border-30)] rounded text-[0.75rem] font-lexend tracking-tight text-[var(--th-text-secondary)] outline-none focus:border-[var(--th-text-faint)]"
            />
          ) : (
            <button
              type="button"
              onClick={() => toggleFolder(folder.id)}
              className="min-w-0 flex-1 px-1 py-2 text-left text-[0.75rem] font-lexend tracking-tight truncate text-[var(--th-text-secondary)] font-medium"
            >
              {folder.name}
            </button>
          )}
          {!isRenaming && (
            <div
              className="relative"
              ref={isMenuOpen ? folderMenuRef : undefined}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (isMenuOpen) {
                    setFolderMenuOpenId(null);
                    return;
                  }
                  openRowMenu(e.currentTarget, setMenuFlipUp);
                  setFolderMenuOpenId(folder.id);
                }}
                className={`mr-2 h-6 w-6 flex items-center justify-center rounded text-[var(--th-text-faint)] hover:text-[var(--th-text-secondary)] hover:bg-[var(--th-surface-hover)] transition-all ${
                  isHovered || isMenuOpen ? "opacity-100" : "opacity-0"
                }`}
                title="Folder options"
                aria-label="Folder options"
              >
                <span className="material-symbols-outlined text-[14px]">more_horiz</span>
              </button>
              {isMenuOpen && (
                <div className={`absolute right-0 ${menuFlipUp ? "bottom-full mb-1" : "top-full mt-1"} z-[60] w-32 bg-[var(--th-surface-raised)] border border-[var(--th-border-30)] rounded-md shadow-xl py-1`}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setFolderMenuOpenId(null);
                      setFolderRenameValue(folder.name);
                      setRenamingFolderId(folder.id);
                    }}
                    className="w-full px-3 py-1.5 text-left text-[0.7rem] font-lexend text-[var(--th-text-secondary)] hover:bg-[var(--th-surface-hover)] flex items-center gap-2"
                  >
                    <span className="material-symbols-outlined text-[14px]">edit</span>
                    Rename
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setFolderMenuOpenId(null);
                      setConfirmDelete({
                        kind: "folder",
                        id: folder.id,
                        name: folder.name,
                      });
                    }}
                    className="w-full px-3 py-1.5 text-left text-[0.7rem] font-lexend text-red-400 hover:bg-[var(--th-surface-hover)] flex items-center gap-2"
                  >
                    <span className="material-symbols-outlined text-[14px]">delete</span>
                    Delete
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        {folder.expanded && folder.children.length > 0 && (
          <div className="space-y-1 mt-1">
            {folder.children.map((c) => renderNote(c.id, folder.id))}
          </div>
        )}
      </div>
    );
  };

  // Prevent unused-var warning; noteParentFolderId is kept for future use.
  void noteParentFolderId;

  return (
    <aside
      id="sidebar"
      onClick={collapsed ? onToggle : undefined}
      className="fixed z-50 flex flex-col overflow-hidden transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]"
      style={{
        width: collapsed ? 44 : 220,
        height: collapsed ? 44 : "calc(100vh - 24px)",
        top: collapsed ? 16 : 12,
        left: collapsed ? 16 : 12,
        background: collapsed ? "var(--th-sidebar-collapsed)" : "var(--th-sidebar)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        border: "1px solid var(--th-border-subtle)",
        borderRadius: collapsed ? 9999 : 16,
        boxShadow: collapsed ? `0 4px 16px var(--th-shadow)` : `0 8px 32px var(--th-shadow)`,
        cursor: collapsed ? "pointer" : undefined,
      }}
    >
      <div
        className="absolute inset-0 flex items-center justify-center transition-opacity duration-200"
        style={{ opacity: collapsed ? 1 : 0, pointerEvents: collapsed ? "auto" : "none" }}
      >
        <span className="material-symbols-outlined text-[20px] text-[var(--th-text-muted)]">
          {currentIcon}
        </span>
      </div>

      <div
        className="flex flex-col h-full transition-opacity duration-200"
        style={{ opacity: collapsed ? 0 : 1, pointerEvents: collapsed ? "none" : "auto" }}
      >
        <div className="py-5 px-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img
              src="/shannon-logo.png"
              alt=":D"
              aria-hidden
              className="w-8 h-8 flex-shrink-0 object-contain select-none"
              draggable={false}
            />
            <div>
              <h1 className="font-lexend font-bold text-[var(--th-text-secondary)] text-lg tracking-tighter leading-none">
                Shannon
              </h1>
              <p className="font-lexend text-[0.6875rem] font-medium tracking-tight text-[var(--th-text-muted)] mt-0.5">
                Intelligent Notes
              </p>
            </div>
          </div>
          <button
            className="text-[var(--th-text-faint)] hover:text-[var(--th-text-secondary)] transition-colors"
            onClick={onToggle}
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        <nav className="flex-1 px-2 overflow-y-auto">
          <div className="space-y-1">
            {navItems.map((item) => {
              const isActive =
                pathname === item.href ||
                (item.href !== "/" && pathname.startsWith(item.href));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg text-[0.75rem] font-lexend tracking-tight transition-colors duration-150 ${
                    isActive
                      ? "bg-[var(--th-surface-hover)] text-[var(--th-text-secondary)] font-semibold shadow-[inset_2px_0_0_var(--th-border-15)]"
                      : "text-[var(--th-text-muted)] hover:text-[var(--th-text-secondary)] hover:bg-[var(--th-surface-hover)] hover:shadow-[inset_2px_0_0_var(--th-border-10)]"
                  }`}
                >
                  <span className="material-symbols-outlined text-[20px] flex-shrink-0">
                    {item.icon}
                  </span>
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>

          <div className="mt-4 pt-3 border-t border-[var(--th-border-10)]">
            <button
              type="button"
              onClick={() => router.replace("/notes", { scroll: false })}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-[0.75rem] font-lexend tracking-tight text-[var(--th-text-secondary)] hover:bg-[var(--th-surface-hover)] transition-colors duration-150"
            >
              <span className="material-symbols-outlined text-[20px] flex-shrink-0">edit_note</span>
              <span>New Note</span>
            </button>
            <button
              type="button"
              onClick={createFolder}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-[0.75rem] font-lexend tracking-tight text-[var(--th-text-secondary)] hover:bg-[var(--th-surface-hover)] transition-colors duration-150"
            >
              <span className="material-symbols-outlined text-[20px] flex-shrink-0">create_new_folder</span>
              <span>New Folder</span>
            </button>
            <button
              type="button"
              onClick={handleImportNote}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-[0.75rem] font-lexend tracking-tight text-[var(--th-text-secondary)] hover:bg-[var(--th-surface-hover)] transition-colors duration-150"
            >
              <span className="material-symbols-outlined text-[20px] flex-shrink-0">file_upload</span>
              <span>Import Note</span>
            </button>
            <div
              className={`mt-3 pt-3 space-y-1 rounded-lg border-t border-[var(--th-border-10)] transition-colors ${
                dragOverRoot ? "ring-1 ring-[var(--th-border-20)]" : ""
              }`}
              onDragOver={(e) => {
                if (!draggingId) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (!dragOverRoot) setDragOverRoot(true);
              }}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                if (dragOverRoot) setDragOverRoot(false);
              }}
              onDrop={(e) => {
                if (!draggingId) return;
                e.preventDefault();
                applyMove(draggingId, { kind: "root-end" });
                clearDragState();
              }}
            >
              {tree.map((item) =>
                item.type === "folder"
                  ? renderFolder(item)
                  : renderNote(item.id, null)
              )}
            </div>
          </div>
        </nav>

        <div className="mt-auto pt-4 border-t border-[var(--th-border-10)] px-2 pb-2">
          <a
            href="https://github.com/myxamediyar/shannon"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 px-3 py-2 text-[var(--th-text-muted)] hover:text-[var(--th-text-secondary)] hover:bg-[var(--th-surface-hover)] rounded-lg transition-colors duration-150"
          >
            <svg
              viewBox="0 0 16 16"
              width="20"
              height="20"
              fill="currentColor"
              className="flex-shrink-0"
              aria-hidden="true"
            >
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            <span className="font-lexend text-[0.75rem] tracking-tight">GitHub repo</span>
          </a>
        </div>
      </div>
      {confirmDelete && typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm"
            onClick={() => setConfirmDelete(null)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setConfirmDelete(null);
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
              className="w-[320px] rounded-xl border border-[var(--th-border-30)] bg-[var(--th-surface-raised)] p-5 shadow-2xl"
            >
              <h2 className="font-lexend text-[0.95rem] font-semibold tracking-tight text-[var(--th-text-secondary)]">
                Delete {confirmDelete.kind}?
              </h2>
              <p className="mt-2 font-lexend text-[0.75rem] tracking-tight text-[var(--th-text-muted)]">
                {confirmDelete.kind === "folder" ? (
                  <>
                    &ldquo;{confirmDelete.name}&rdquo; will be removed. Notes
                    inside will move back to the top level.
                  </>
                ) : (
                  <>
                    &ldquo;{confirmDelete.name}&rdquo; will be permanently
                    deleted. This cannot be undone.
                  </>
                )}
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  autoFocus
                  onClick={() => setConfirmDelete(null)}
                  className="px-3 py-1.5 rounded-md text-[0.75rem] font-lexend tracking-tight text-[var(--th-text-secondary)] hover:bg-[var(--th-surface-hover)]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (confirmDelete.kind === "note") {
                      deleteNote(confirmDelete.id);
                    } else {
                      deleteFolder(confirmDelete.id);
                    }
                    setConfirmDelete(null);
                  }}
                  className="px-3 py-1.5 rounded-md text-[0.75rem] font-lexend tracking-tight text-white bg-red-500/90 hover:bg-red-500"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </aside>
  );
}
