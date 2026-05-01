"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import RBush, { type BBox } from "rbush";
import "katex/dist/katex.min.css";
import {
  Chart as ChartJS, CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend,
  ArcElement, LineElement, PointElement, Filler, RadialLinearScale,
} from "chart.js";

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend, ArcElement, LineElement, PointElement, Filler, RadialLinearScale);
if (typeof document !== "undefined") {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--font-lexend").trim();
  ChartJS.defaults.font.family = v ? `${v}, sans-serif` : "'Lexend Deca', sans-serif";
}
ChartJS.defaults.font.size = 11;

import { TiptapTextAdapter, charOffsetToPmPos } from "./RichTextEditor";
import type { Editor } from "@tiptap/react";
import ChatContainer from "./ChatContainer";
import GraphContainer, { validateGraphScale, validateGraphDelete, validateGraphPlace, useGraphFlash } from "./GraphContainer";
import PdfContainer from "./PdfContainer";
import EmbedContainer from "./EmbedContainer";
import TableContainer from "./TableContainer";
import ChecklistContainer from "./ChecklistContainer";
import { ToolPickerToolbar, type ShapeSubTool } from "./canvas/toolbars/ToolPickerToolbar";
import { CanvasElement } from "./canvas/CanvasElement";
import { SingleDraw } from "./canvas/DrawLayer";
import { ArrowLayer } from "./canvas/ArrowLayer";
import { PageRegionLayer } from "./canvas/PageRegionLayer";
import { PageRegionToolbar } from "./canvas/toolbars/PageRegionToolbar";
import { AlignmentToolbar } from "./canvas/toolbars/AlignmentToolbar";
import { ChatToolbar } from "./canvas/toolbars/ChatToolbar";
import { CropOverlay } from "./canvas/CropOverlay";
import { ImageResizeOverlay } from "./canvas/toolbars/ImageResizeOverlay";
import { InlineTextToolbar } from "./canvas/toolbars/InlineTextToolbar";
import { TextMarqueeToolbar } from "./canvas/toolbars/TextMarqueeToolbar";
import { type Snapshot } from "../lib/canvas-history";
import { useCanvasHistory } from "../hooks/useCanvasHistory";
import { useCanvasPanZoom } from "../hooks/useCanvasPanZoom";
import { useMarquee } from "../hooks/useMarquee";
import { useLatest } from "../hooks/useLatest";
import {
  rasterizeShapeGroups,
  serializeElements,
} from "../lib/canvas-serialize";
import { stripBlobSrcsForPersist } from "../lib/canvas-blob-store";
import * as drags from "../lib/canvas-drags";
import type { DragDeps, ImageResizeDragState } from "../lib/canvas-drags";
import { dispatchSlashCommand } from "../lib/canvas-commands";
import * as tableOps from "../lib/canvas-table-ops";
import type { TableOpsDeps } from "../lib/canvas-table-ops";
import * as checklistOps from "../lib/canvas-checklist-ops";
import type { ChecklistOpsDeps } from "../lib/canvas-checklist-ops";
import { stripChecklistItemMeasures } from "../lib/canvas-checklist-ops";
import { placeImageBlob as placeImageBlobLib, placePdfBlob as placePdfBlobLib } from "../lib/canvas-file-drop";
import { printPageRegion as printPageRegionLib } from "../lib/canvas-print";
import {
  handleTextBackspace,
  handleTextEscape,
  handleTextTab,
  handleTextCmdArrowLR,
  handleTextCmdArrowUD,
  handleTextArrow,
  type TextEventResult,
  type TextInteractionDeps,
} from "../lib/text-interactions";
import {
  MIN_SCALE,
  MAX_SCALE,
  DEFAULT_SCALE,
  TEXT_LINE_HEIGHT,
  OPTION_BACKSPACE_CHAR_STEPS,
  TOOLS,
  BG_DOT_RADIUS,
  BG_DOT_SPACING,
  STORAGE_KEY,
} from "../lib/canvas-types";

import { useSettings, uiToRealOpacity } from "../lib/use-settings";
import { useResolvedBgImage } from "../lib/custom-backgrounds";

import type {
  ToolId,
  TextEl,

  ImageEl,
  ShapeEl,
  DrawEl,
  ArrowEl,
  ChartEl,
  ChatEl,
  MathEl,
  NoteRefEl,
  GraphEl,
  PdfEl,
  EmbedEl,
  TableEl,
  TableCell,
  ChecklistEl,
  CanvasEl,
  NoteItem,
  CanvasAabb,
  PlacementOp,
  PlacementResponse,
  PageRegion,
  PageSize,
  PageRotation,
} from "../lib/canvas-types";
import { pageRegionDims, PAGE_PRINT_SCALE, isTextBlank, CHAT_INDICATOR_MARGIN } from "../lib/canvas-types";

import {
  snapTextLineY,
  approxCharWidthCanvas,

  eraseWithinBoxFully,
  canvasCaretIndexAtPoint,
  elementTightCanvasAabb,
  canvasPointHitsSingleEl,
  canvasPointHitsAnySelectedEl,
  translateCanvasElBy,
  snapMovedCanvasEl,
  findFreeSpotInAiColumn,
  mergeTouchingCanvasAABBs,
  isInteractive,
  isNativeFormControl,
  isCanvasElement,
  toCanvas,
  executePlacement,
  horizontalTextPush,
  verticalEnterPush,
  dragResolvePush,
  placeNewLine,
  placeChain,
  migrateChains,
  textElementAabb,
  spawnText,
  spawnDraw,
  spawnShape,
  spawnArrow,
  spawnNoteRef,
  resolveTextClick,
  matchCommand,
  COMMAND_TRIE,
  commandsWithPrefix,
  spawnChat,
  spawnSideq,
  spawnQuickChat,
  assignChatNumbers,
  spawnMathFromCommand,
  spawnShapeFromCommand,
  spawnArrowFromCommand,
  spawnTableFromCommand,
  stripTableCellMeasures,
  escapeCellHtml,
  migrateLegacyTableRows,
} from "../lib/canvas-utils";

interface NotesCanvasProps {
  /** The note to display. When its id changes the canvas resets viewport. */
  note: NoteItem | null;
  /** Called (possibly debounced) when elements change. Parent persists. */
  onNoteChange?: (note: NoteItem) => void;
  /** Canvas needs a new note (blank-click). Parent creates it with the right number, returns it. */
  onCreateNote?: (firstElement: CanvasEl) => NoteItem | null;
  /** When true, the canvas is read-only (pan/zoom still work). */
  locked?: boolean;
  /** Toggle the lock state. When provided, a lock icon is shown. */
  onToggleLock?: () => void;
}


// ── Spatial index (RBush) ───────────────────────────────────────────────────

interface SpatialItem extends BBox { id: string }

const ELEMENT_TYPES = ["text", "image", "shape", "draw", "arrow", "chart", "math", "chat", "noteRef", "graph", "pdf", "embed", "table", "checklist"] as const;
type ElType = (typeof ELEMENT_TYPES)[number];

type SpatialIndices = Record<ElType, RBush<SpatialItem>>;

function emptySpatialIndices(): SpatialIndices {
  return Object.fromEntries(ELEMENT_TYPES.map(t => [t, new RBush<SpatialItem>()])) as SpatialIndices;
}

function nextGraphNum(elements: CanvasEl[]): number {
  let max = 0;
  for (const el of elements) {
    if (el.type === "graph" && el.graphNum > max) max = el.graphNum;
  }
  return max + 1;
}

function rebuildSpatialIndices(elements: CanvasEl[], indices: SpatialIndices) {
  for (const tree of Object.values(indices)) tree.clear();
  for (const el of elements) {
    const aabb = elementTightCanvasAabb(el);
    if (!aabb) continue;
    indices[el.type].insert({
      minX: aabb.x,
      minY: aabb.y,
      maxX: aabb.x + aabb.w,
      maxY: aabb.y + aabb.h,
      id: el.id,
    });
  }
}

/** 50% of viewport dimensions on each side — elements enter DOM before scrolling into view. */
const VIEWPORT_BUFFER_RATIO = 0.2;

function computeViewportAabb(
  off: { x: number; y: number },
  sc: number,
  containerW: number,
  containerH: number,
): BBox {
  const minX = -off.x / sc;
  const minY = -off.y / sc;
  const maxX = (containerW - off.x) / sc;
  const maxY = (containerH - off.y) / sc;
  const bufX = (maxX - minX) * VIEWPORT_BUFFER_RATIO;
  const bufY = (maxY - minY) * VIEWPORT_BUFFER_RATIO;
  return { minX: minX - bufX, minY: minY - bufY, maxX: maxX + bufX, maxY: maxY + bufY };
}

export default function NotesCanvas({ note: noteProp, onNoteChange, onCreateNote, locked = false, onToggleLock }: NotesCanvasProps) {
  const { settings } = useSettings();
  const resolvedBgImage = useResolvedBgImage(settings.bgImage);
  const [notes, setNotes] = useState<NoteItem[]>(noteProp ? [noteProp] : []);
  const [activeId, setActiveId] = useState<string | null>(noteProp?.id ?? null);

  // ── Viewport-culling refs ───────────────────────────────────────────────
  /** Source of truth: ALL elements for the active note. */
  const allElementsRef = useRef<CanvasEl[]>(migrateChains(noteProp?.elements ?? []));
  /** Source of truth: page regions for the active note (separate from elements). */
  const pageRegionsRef = useRef<PageRegion[]>(noteProp?.pageRegions ?? []);
  /** Visible subset: elements whose AABB intersects the buffered viewport. */
  const visibleElementsRef = useRef<CanvasEl[]>(migrateChains(noteProp?.elements ?? []));
  /** Bumped to signal React that visibleElementsRef changed and DOM needs updating. */
  const [renderTick, setRenderTick] = useState(0);
  const viewportAabbRef = useRef<BBox | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [activeTool, setActiveTool] = useState<ToolId | null>("text");
  const [isCanvasTyping, setIsCanvasTyping] = useState(false);
  /** ID of the text element currently being edited (has focus). null = display mode for all. */
  const [focusedTextId, setFocusedTextId] = useState<string | null>(null);
  const [tableContextMenu, setTableContextMenu] = useState<{ tableId: string; row: number; col: number; left: number; top: number } | null>(null);
  const [checklistContextMenu, setChecklistContextMenu] = useState<{ checklistId: string; index: number; left: number; top: number } | null>(null);
  useEffect(() => {
    if (!tableContextMenu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setTableContextMenu(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tableContextMenu]);
  useEffect(() => {
    if (!checklistContextMenu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setChecklistContextMenu(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [checklistContextMenu]);
  /** Right-click on empty canvas space opens this menu. */
  const [canvasContextMenu, setCanvasContextMenu] = useState<{
    screenX: number; screenY: number; canvasX: number; canvasY: number; canPaste: boolean;
  } | null>(null);
  useEffect(() => {
    if (!canvasContextMenu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setCanvasContextMenu(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canvasContextMenu]);
  const graphFlash = useGraphFlash();
  const focusedTextIdRef = useRef<string | null>(null);
  const editorMapRef = useRef(new Map<string, Editor>());
  if (focusedTextId !== focusedTextIdRef.current) {
    focusedTextIdRef.current = focusedTextId;
  }
  /** Bumped with flushSync on ⌘/Ctrl fragment jump so layout effect runs even when activeTool stays "text". */
  const [cmdCaretLayoutKey, setCmdCaretLayoutKey] = useState(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedPageRegionId, setSelectedPageRegionId] = useState<string | null>(null);
  const canvasWorldRef = useRef<HTMLDivElement | null>(null);
  const pageRegionDragRef = useRef<{ id: string; originClient: { x: number; y: number }; originPr: { x: number; y: number }; lastXY?: { x: number; y: number } } | null>(null);
  const pageMarginDragRef = useRef<{ id: string; axis: "x" | "y"; side: "start" | "end"; originClient: number; startMargin: number; w: number; h: number; last?: number } | null>(null);
  /** True while marquee selection is being dragged in move mode (unsnapped preview; snap on release). */
  const [selectionMoveLive, setSelectionMoveLive] = useState(false);
  /** Per-element character highlight from text-tool marquee selection.
   *  Map of element id → array of { lineIdx, startChar, endChar }. */
  const [textMarqueeSelectedIds, setTextMarqueeSelectedIds] = useState<Set<string>>(new Set());
  const textMarqueeSelectedIdsRef = useLatest(textMarqueeSelectedIds);

  // Track inline text selection within focused editor (for formatting toolbar)
  const [inlineToolbarPos, setInlineToolbarPos] = useState<{ left: number; top: number } | null>(null);
  const [selectedImage, setSelectedImage] = useState<{ editorId: string; pos: number; rect: DOMRect; width: number } | null>(null);

  useEffect(() => {
    if (!focusedTextId) { setSelectedImage(null); setInlineToolbarPos(null); return; }
    const editor = editorMapRef.current.get(focusedTextId);
    if (!editor) { setSelectedImage(null); setInlineToolbarPos(null); return; }

    const refresh = () => {
      const sel = editor.state.selection;
      // NodeSelection on an image?
      const maybeNode = (sel as unknown as { node?: { type: { name: string }; attrs: { width?: number | string | null } } }).node;
      if (maybeNode && maybeNode.type.name === "image") {
        const dom = editor.view.nodeDOM(sel.from) as HTMLElement | null;
        if (dom) {
          const rect = dom.getBoundingClientRect();
          const widthAttr = maybeNode.attrs.width;
          const width = typeof widthAttr === "number" ? widthAttr
            : typeof widthAttr === "string" ? parseInt(widthAttr, 10) || rect.width
            : rect.width;
          setSelectedImage({ editorId: focusedTextId, pos: sel.from, rect, width });
          setInlineToolbarPos(null);
          return;
        }
      }
      setSelectedImage(null);
      const { from, to } = sel;
      if (from === to) { setInlineToolbarPos(null); return; }
      const domSel = window.getSelection();
      if (domSel && domSel.rangeCount > 0) {
        const rect = domSel.getRangeAt(0).getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) {
          setInlineToolbarPos({ left: rect.left + rect.width / 2, top: rect.top });
        }
      }
    };

    const onSelChange = () => refresh();
    editor.on("selectionUpdate", refresh);
    editor.on("transaction", refresh);
    document.addEventListener("selectionchange", onSelChange);
    refresh();
    return () => {
      editor.off("selectionUpdate", refresh);
      editor.off("transaction", refresh);
      document.removeEventListener("selectionchange", onSelChange);
    };
  }, [focusedTextId]);

  // Clear text marquee selection when switching away from text tool
  useEffect(() => {
    if (activeTool !== "text" && textMarqueeSelectedIdsRef.current.size > 0) {
      setTextMarqueeSelectedIds(new Set());
    }
  }, [activeTool]);

  // Live drawing previews (React state so they trigger re-renders)
  const [drawPreview, setDrawPreview] = useState<string | null>(null);
  const [shapePreview, setShapePreview] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [arrowPreview, setArrowPreview] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  // Shape sub-tool: which shape type is active when shape tool is selected
  const [shapeSubTool, setShapeSubTool] = useState<ShapeSubTool>("rect");

  // ── Chat message history keyed by chatId ────────────────────────────────────
  const chatHistoriesRef = useRef<Map<string, { role: "user" | "assistant"; content: string }[]>>(new Map());
  // Track last-sent visible elements snapshot per chatId to detect changes (owned by useChatStream via deps)
  const lastSentVisibleRef = useRef<Map<string, string>>(new Map());
  // Auto-incrementing chat number counter (derived from existing elements on init)
  const chatCounterRef = useRef<number>(
    Math.max(0, ...((noteProp?.elements ?? []).filter(el => el.type === "chat" && !(el as ChatEl).ephemeral) as ChatEl[]).map(el => el.chatNumber ?? 0)) + 1
  );

  // ── Note picker state (for noteRef tool) ─────────────────────────────────
  const [notePickerPos, setNotePickerPos] = useState<{ cx: number; cy: number; screenX: number; screenY: number } | null>(null);
  const [notePickerSearch, setNotePickerSearch] = useState("");
  const notePickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!notePickerPos) return;
    const onDown = (e: MouseEvent) => {
      if (notePickerRef.current?.contains(e.target as Node)) return;
      setNotePickerPos(null);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [notePickerPos]);

  // Always-current refs (avoid stale closures in event handlers)
  const stateRef = useLatest({ activeId, activeTool, offset, scale, isCanvasTyping });

  const viewportRef = useRef<HTMLDivElement>(null);

  const { transformRef, scheduleTransform, viewportCenter, zoomByDiscrete, zoomCenterNormalized, zoomPct } =
    useCanvasPanZoom({
      viewportRef,
      scale,
      offset,
      setScale,
      setOffset,
      onTransform: () => recomputeVisible(),
    });

  const isPanning = useRef(false);
  /** If pan moved more than a few px, ignore the following click (avoid placing text after pan). */
  const panDistanceRef = useRef(0);

  /** Swallow the native click that fires after a gesture-consuming mouseup
   *  (marquee finalize, selection-move finalize, draw stroke). Checked + cleared
   *  at the top of handleClick. Note: shape creation uses its own ref so shift-
   *  click-to-center still fires after a shape-tool drag (existing behavior). */
  const suppressNextClickRef = useRef(false);
  /** Two-finger touch: last pinch distance and screen centroid (for pan + zoom). */
  const touchTwoRef = useRef<{ dist: number; cx: number; cy: number } | null>(null);
  const isDrawing = useRef(false);
  const drawPts = useRef<{ x: number; y: number }[]>([]);
  const dragStart = useRef<{ cx: number; cy: number } | null>(null);
  /** Arrow tip drag: tracks which arrow + endpoint is being dragged, plus last canvas position. */
  const arrowTipDrag = useRef<{ arrowId: string; endpoint: "start" | "end"; cx: number; cy: number } | null>(null);
  /** True when mouseUp just created a shape/arrow — suppresses the subsequent click from switching to text. */
  const shapeJustCreatedRef = useRef(false);
  /** Shape corner resize drag: tracks which shape + corner is being dragged, plus current rect. */
  const shapeResizeDrag = useRef<{ shapeId: string; corner: "tl" | "tr" | "bl" | "br"; x: number; y: number; w: number; h: number } | null>(null);
  const imageResizeDrag = useRef<ImageResizeDragState | null>(null);
  const [imageDragOver, setImageDragOver] = useState<{ x: number; y: number } | null>(null);
  /** ID of the image currently in crop-edit mode. Suppresses regular image
   *  resize handle + AlignmentToolbar while the cropper is open. */
  const [cropEditingId, setCropEditingId] = useState<string | null>(null);
  const dragOverCounter = useRef(0);
  /** Text selection drag: when mouseDown on a display-mode text element, records the element + anchor caret so mouseMove can extend the selection. */
  const textSelectDrag = useRef<{ elId: string; anchor: number } | null>(null);
  const lastMouse = useRef({ x: 0, y: 0 });
  const lastClientPos = useRef<{ clientX: number; clientY: number }>({ clientX: 0, clientY: 0 });
  /** Live drag delta in canvas-space px — used for CSS-only transform during selection move. */
  const dragDeltaRef = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const newElIdRef = useRef<string | null>(null);
  const mergeCaretRef = useRef<{ id: string; caret: number } | null>(null);
  /** Tab-completion state for commands: tracks the original prefix and cycle index. */
  const cmdTabRef = useRef<{ prefix: string; matches: string[]; index: number } | null>(null);
  /** ⌘/Ctrl + ←/→ jump: selection in layout effect (see merge order + post-paint reassert). */
  const cmdArrowCaretRef = useRef<{ id: string; caret: number } | null>(null);
  /** Same payload as cmdArrowCaretRef; cleared in useEffect after rAF reapply (browser/React reset selection after layout). */
  const cmdCaretPostPaintRef = useRef<{ id: string; caret: number } | null>(null);
  /** Fixed canvas x for ↑/↓ so movement stays plumb; cleared on horizontal arrows / blur / typing / note change. */
  const canvasVerticalColumnXRef = useRef<number | null>(null);
  const elDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedIdsRef = useLatest(selectedIds);
  /** Internal clipboard for non-text elements (drawings, images, etc.) that can't go to system clipboard. */
  const canvasClipboardRef = useRef<CanvasEl[]>([]);
  /** Exact text we last wrote to the OS clipboard from a canvas Cmd+C. `null` = we didn't touch
   *  the OS clipboard (copied non-text only). On paste, if OS clipboard text differs from this,
   *  some other source overwrote it — treat the internal clipboard as stale. */
  const lastCanvasCopyTextRef = useRef<string | null>(null);
  /** Move tool: drag all marquee-selected elements together (canvas space). */
  const selectionMoveDragRef = useRef<{
    originCanvas: { x: number; y: number };
    lastCanvas: { x: number; y: number };
    snapshots: Record<string, CanvasEl>;
  } | null>(null);
  const isSelectionMoveDragging = useRef(false);
  const finalizeSelectionMoveDragRef = useRef<() => void>(() => {});
  const onNoteChangeRef = useLatest(onNoteChange);
  const onCreateNoteRef = useLatest(onCreateNote);

  // ── Undo / Redo history ──────────────────────────────────────────────────
  const history = useCanvasHistory();

  const activeNote = notes.find((n) => n.id === activeId) ?? null;
  const activeNoteRef = useLatest(activeNote);

  // HTML export: sidebar (or any code) dispatches `notes:export-html` with a
  // note id. We run the export against the live world DOM if that note is the
  // currently-active one. Cross-page navigation is handled via sessionStorage.
  useEffect(() => {
    const run = async (noteId: string) => {
      const current = activeNoteRef.current;
      if (!current || current.id !== noteId) return;
      const world = canvasWorldRef.current;
      if (!world) return;
      try {
        const { exportNoteAsHtml } = await import("../lib/canvas-export-html");
        const blob = await exportNoteAsHtml(world, current);
        const safeName = (current.title || "Untitled").replace(/[\\/?%*:|"<>]/g, "-").trim().slice(0, 100) || "Untitled";
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${safeName}.html`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (err) {
        console.error("HTML export failed:", err);
      }
    };
    const onEvent = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (id) void run(id);
    };
    window.addEventListener("notes:export-html", onEvent);
    return () => window.removeEventListener("notes:export-html", onEvent);
  }, [activeNoteRef]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const pending = sessionStorage.getItem("shannon_export_html_pending");
    if (!pending || activeNote?.id !== pending) return;
    sessionStorage.removeItem("shannon_export_html_pending");
    requestAnimationFrame(() => {
      window.dispatchEvent(
        new CustomEvent("notes:export-html", { detail: pending }),
      );
    });
  }, [activeNote]);

  // ── Spatial indices (one RBush per element type) ──
  const spatialRef = useRef<SpatialIndices>(emptySpatialIndices());

  // Tables that just left the viewport are held in DOM while TableContainer
  // sheds its Tiptap editors one per idle callback. Symmetric to mount: avoids
  // the N-editor synchronous destroy stall on scroll-away.
  const despawningTableIdsRef = useRef(new Set<string>());
  // Same pattern for checklists — hold in DOM while items shed Tiptap editors.
  const despawningChecklistIdsRef = useRef(new Set<string>());

  // ── Progressive mount pacing ─────────────────────────────────────────────
  // The r-tree gives us every id that *should* be in the DOM (the "ideal"
  // set). Committing all of them at once causes FPS drops on fast pan/zoom
  // because each wrapper instantiates a Tiptap editor / chart / Konva layer.
  // Instead, we split the work:
  //   - committed: ids actually rendered right now (visibleElementsRef)
  //   - pending:   ideal ids waiting to mount, drained one-per-rIC ordered by
  //                distance from viewport center (nearest first).
  // Selected/focused/despawning ids bypass the queue and commit immediately.
  const committedIdsRef = useRef<Set<string>>(new Set());
  const pendingIdsRef = useRef<Set<string>>(new Set());
  const idleCommitHandleRef = useRef<number | null>(null);

  function scheduleIdleCommit() {
    if (idleCommitHandleRef.current != null) return;
    type IdleCb = (cb: IdleRequestCallback, opts?: IdleRequestOptions) => number;
    type CancelCb = (h: number) => void;
    const win = window as unknown as { requestIdleCallback?: IdleCb; cancelIdleCallback?: CancelCb };
    const ric: IdleCb = win.requestIdleCallback
      ?? ((cb) => window.setTimeout(() => cb({
        didTimeout: true,
        timeRemaining: () => 8,
      } as IdleDeadline), 16) as unknown as number);
    idleCommitHandleRef.current = ric((deadline) => {
      idleCommitHandleRef.current = null;
      flushPendingCommits(deadline);
    }, { timeout: 120 });
  }

  function flushPendingCommits(deadline: IdleDeadline) {
    const pending = pendingIdsRef.current;
    if (pending.size === 0) return;

    const vp = viewportRef.current;
    const { offset: off, scale: sc } = transformRef.current;
    const cx = vp ? (-off.x + vp.clientWidth / 2) / sc : 0;
    const cy = vp ? (-off.y + vp.clientHeight / 2) / sc : 0;

    const byId = new Map<string, CanvasEl>();
    for (const el of allElementsRef.current) byId.set(el.id, el);

    const sorted = [...pending].map(id => {
      const el = byId.get(id);
      if (!el) return { id, d: Infinity };
      const a = elementTightCanvasAabb(el);
      if (!a) return { id, d: Infinity };
      const ex = a.x + a.w / 2;
      const ey = a.y + a.h / 2;
      return { id, d: (ex - cx) * (ex - cx) + (ey - cy) * (ey - cy) };
    }).sort((a, b) => a.d - b.d);

    const committed = committedIdsRef.current;
    let committedAny = false;
    for (const { id } of sorted) {
      if (!(deadline.didTimeout || deadline.timeRemaining() > 2)) break;
      if (!pending.has(id)) continue;
      pending.delete(id);
      committed.add(id);
      committedAny = true;
    }

    if (committedAny) {
      visibleElementsRef.current = allElementsRef.current.filter(el => committed.has(el.id));
      setRenderTick(t => t + 1);
    }
    if (pending.size > 0) scheduleIdleCommit();
  }

  /** Recompute visibleElementsRef by querying the R-tree against the buffered viewport AABB. */
  function recomputeVisible() {
    const vp = viewportRef.current;
    if (!vp) {
      visibleElementsRef.current = allElementsRef.current;
      committedIdsRef.current = new Set(allElementsRef.current.map(el => el.id));
      pendingIdsRef.current.clear();
      return;
    }
    const { offset: off, scale: sc } = transformRef.current;
    const aabb = computeViewportAabb(off, sc, vp.clientWidth, vp.clientHeight);
    viewportAabbRef.current = aabb;

    const idealIds = new Set<string>();
    for (const tree of Object.values(spatialRef.current)) {
      for (const h of tree.search(aabb)) idealIds.add(h.id);
    }
    // Force-include selected elements (may span viewport boundary)
    for (const id of selectedIdsRef.current) idealIds.add(id);
    // Force-include focused textarea (element being typed into)
    const focused = document.activeElement;
    if (focused instanceof HTMLTextAreaElement && focused.id.startsWith("el-")) {
      idealIds.add(focused.id.slice(3));
    }

    // Diff against what's *currently* in DOM to detect tables that just left.
    const despawning = despawningTableIdsRef.current;
    for (const el of visibleElementsRef.current) {
      if (el.type !== "table") continue;
      if (!idealIds.has(el.id) && !despawning.has(el.id)) {
        despawning.add(el.id);
      }
    }
    // If a despawning table re-enters the viewport, cancel its despawn —
    // hydratedCount inside TableContainer will climb back up on its own.
    for (const id of despawning) {
      if (idealIds.has(id)) despawning.delete(id);
    }
    for (const id of despawning) idealIds.add(id);

    // Same despawn protocol for checklists.
    const despawningCl = despawningChecklistIdsRef.current;
    for (const el of visibleElementsRef.current) {
      if (el.type !== "checklist") continue;
      if (!idealIds.has(el.id) && !despawningCl.has(el.id)) {
        despawningCl.add(el.id);
      }
    }
    for (const id of despawningCl) {
      if (idealIds.has(id)) despawningCl.delete(id);
    }
    for (const id of despawningCl) idealIds.add(id);

    // Ids that must mount immediately (user intent / system invariants):
    // selected, focused, despawning-tables.
    const mustCommitNow = new Set<string>();
    for (const id of selectedIdsRef.current) mustCommitNow.add(id);
    if (focused instanceof HTMLTextAreaElement && focused.id.startsWith("el-")) {
      mustCommitNow.add(focused.id.slice(3));
    }
    for (const id of despawning) mustCommitNow.add(id);
    for (const id of despawningCl) mustCommitNow.add(id);

    const committed = committedIdsRef.current;
    const pending = pendingIdsRef.current;

    // Drop ids that left the buffered viewport from both committed and pending.
    for (const id of [...committed]) if (!idealIds.has(id)) committed.delete(id);
    for (const id of [...pending]) if (!idealIds.has(id)) pending.delete(id);

    // Queue or immediately-commit ids that just entered.
    for (const id of idealIds) {
      if (committed.has(id)) continue;
      if (mustCommitNow.has(id)) {
        committed.add(id);
        pending.delete(id);
      } else if (!pending.has(id)) {
        pending.add(id);
      }
    }

    visibleElementsRef.current = allElementsRef.current.filter(el => committed.has(el.id));
    if (pending.size > 0) scheduleIdleCommit();
  }

  // Called by TableContainer when it has finished shedding all its cells.
  // Remove the table from the despawn-hold set and re-run visibility so React
  // finally unmounts the now-empty container.
  const handleTableDespawned = useCallback((tableId: string) => {
    if (!despawningTableIdsRef.current.delete(tableId)) return;
    recomputeVisible();
    setRenderTick((t) => t + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChecklistDespawned = useCallback((checklistId: string) => {
    if (!despawningChecklistIdsRef.current.delete(checklistId)) return;
    recomputeVisible();
    setRenderTick((t) => t + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stable prop identities for <TableContainer>. Handlers below close over
  // state and change every render; passing them directly busts React.memo so
  // every canvas tick re-renders every table and every cell. Pin the latest
  // versions to a ref and forward through empty-deps wrappers — the props
  // the table sees are frozen for the component's lifetime.
  const tableLatestRef = useRef({
    onResize: (_id: string, _changes: Partial<TableEl>) => {},
    onCellChange: (_id: string, _r: number, _c: number, _html: string) => {},
    onCellFocus: (_id: string, _r: number, _c: number) => {},
    onCellMeasure: (_id: string, _r: number, _c: number, _w: number, _h: number) => {},
    onCellKeyDown: (_e: KeyboardEvent, _a: TiptapTextAdapter, _tableId: string, _r: number, _c: number): boolean => false,
    onCellContextMenu: (_id: string, _r: number, _c: number, _cx: number, _cy: number) => {},
    registerCellEditor: (_cellKey: string, _editor: Editor | null) => {},
  });
  const tableOpsDeps: TableOpsDeps = {
    readAllElements: () => allElementsRef.current,
    execPlace,
    getCellEditor: (tid, r, c) => editorMapRef.current.get(`${tid}:${r}:${c}`),
  };

  // Mirror of tableLatestRef for ChecklistContainer.
  const checklistLatestRef = useRef({
    onResize: (_id: string, _changes: Partial<ChecklistEl>) => {},
    onItemChange: (_id: string, _i: number, _html: string) => {},
    onItemFocus: (_id: string, _i: number) => {},
    onItemMeasure: (_id: string, _i: number, _w: number, _h: number) => {},
    onItemKeyDown: (_e: KeyboardEvent, _a: TiptapTextAdapter, _id: string, _i: number): boolean => false,
    onItemContextMenu: (_id: string, _i: number, _cx: number, _cy: number) => {},
    onItemToggle: (_id: string, _i: number) => {},
    onItemInsert: (_id: string, _atIndex: number) => {},
    registerItemEditor: (_itemKey: string, _editor: Editor | null) => {},
  });
  const checklistOpsDeps: ChecklistOpsDeps = {
    readAllElements: () => allElementsRef.current,
    execPlace,
    getItemEditor: (cid, i) => editorMapRef.current.get(`${cid}:${i}`),
  };

  const dragDeps: DragDeps = {
    canvasWorldRef,
    viewportRef,
    getScale: () => transformRef.current.scale,
    toCanvasPoint,
    readAllElements: () => allElementsRef.current,
    getTextEditor: (elId) => editorMapRef.current.get(elId),
    execPlace,
    commitPageRegions,
  };
  tableLatestRef.current = {
    onResize: (id, changes) => { execPlace({ kind: "mutate", id, changes, resolve: dragResolvePush() }); },
    onCellChange: (id, r, c, html) => tableOps.cellChange(tableOpsDeps, id, r, c, html),
    onCellFocus: (id, r, c) => {
      if (!locked && activeTool !== "mover") setActiveTool("text");
      setFocusedTextId(`${id}:${r}:${c}`);
    },
    onCellMeasure: (id, r, c, w, h) => tableOps.cellMeasure(tableOpsDeps, id, r, c, w, h),
    onCellKeyDown: (e, a, tid, r, c) => tableOps.cellKeyDown(tableOpsDeps, e, a, tid, r, c),
    onCellContextMenu: (id, r, c, cx, cy) => {
      setTableContextMenu({ tableId: id, row: r, col: c, left: cx, top: cy });
    },
    registerCellEditor: (cellKey, editor) => {
      if (editor) editorMapRef.current.set(cellKey, editor);
      else editorMapRef.current.delete(cellKey);
    },
  };
  const stableTableProps = useMemo(() => ({
    onResize: (id: string, changes: Partial<TableEl>) => tableLatestRef.current.onResize(id, changes),
    onCellChange: (id: string, r: number, c: number, html: string) => tableLatestRef.current.onCellChange(id, r, c, html),
    onCellBlur: (id: string, r: number, c: number, html: string) => tableLatestRef.current.onCellChange(id, r, c, html),
    onCellFocus: (id: string, r: number, c: number) => tableLatestRef.current.onCellFocus(id, r, c),
    onCellMeasure: (id: string, r: number, c: number, w: number, h: number) => tableLatestRef.current.onCellMeasure(id, r, c, w, h),
    onCellKeyDown: (e: KeyboardEvent, a: TiptapTextAdapter, tableId: string, r: number, c: number) => tableLatestRef.current.onCellKeyDown(e, a, tableId, r, c),
    onCellContextMenu: (id: string, r: number, c: number, cx: number, cy: number) => tableLatestRef.current.onCellContextMenu(id, r, c, cx, cy),
    registerCellEditor: (cellKey: string, editor: Editor | null) => tableLatestRef.current.registerCellEditor(cellKey, editor),
  }), []);

  checklistLatestRef.current = {
    onResize: (id, changes) => { execPlace({ kind: "mutate", id, changes, resolve: dragResolvePush() }); },
    onItemChange: (id, i, html) => checklistOps.itemChange(checklistOpsDeps, id, i, html),
    onItemFocus: (id, i) => {
      if (!locked && activeTool !== "mover") setActiveTool("text");
      setFocusedTextId(`${id}:${i}`);
    },
    onItemMeasure: (id, i, w, h) => checklistOps.itemMeasure(checklistOpsDeps, id, i, w, h),
    onItemKeyDown: (e, a, cid, i) => checklistOps.itemKeyDown(checklistOpsDeps, e, a, cid, i),
    onItemContextMenu: (id, i, cx, cy) => {
      setChecklistContextMenu({ checklistId: id, index: i, left: cx, top: cy });
    },
    onItemToggle: (id, i) => checklistOps.itemToggle(checklistOpsDeps, id, i),
    onItemInsert: (id, atIndex) => checklistOps.insertItem(checklistOpsDeps, id, atIndex),
    registerItemEditor: (itemKey, editor) => {
      if (editor) editorMapRef.current.set(itemKey, editor);
      else editorMapRef.current.delete(itemKey);
    },
  };
  const stableChecklistProps = useMemo(() => ({
    onResize: (id: string, changes: Partial<ChecklistEl>) => checklistLatestRef.current.onResize(id, changes),
    onItemChange: (id: string, i: number, html: string) => checklistLatestRef.current.onItemChange(id, i, html),
    onItemBlur: (id: string, i: number, html: string) => checklistLatestRef.current.onItemChange(id, i, html),
    onItemFocus: (id: string, i: number) => checklistLatestRef.current.onItemFocus(id, i),
    onItemMeasure: (id: string, i: number, w: number, h: number) => checklistLatestRef.current.onItemMeasure(id, i, w, h),
    onItemKeyDown: (e: KeyboardEvent, a: TiptapTextAdapter, cid: string, i: number) => checklistLatestRef.current.onItemKeyDown(e, a, cid, i),
    onItemContextMenu: (id: string, i: number, cx: number, cy: number) => checklistLatestRef.current.onItemContextMenu(id, i, cx, cy),
    onItemToggle: (id: string, i: number) => checklistLatestRef.current.onItemToggle(id, i),
    onItemInsert: (id: string, atIndex: number) => checklistLatestRef.current.onItemInsert(id, atIndex),
    registerItemEditor: (itemKey: string, editor: Editor | null) => checklistLatestRef.current.registerItemEditor(itemKey, editor),
  }), []);

  // Consume renderTick so React re-reads refs when it changes
  void renderTick;
  const visibleElements = visibleElementsRef.current;

  const selectionUnionRects = useMemo(() => {
    if (selectedIds.length === 0) return [];
    const set = new Set(selectedIds);
    const parts: (CanvasAabb & { elId: string })[] = [];
    for (const el of allElementsRef.current) {
      if (!set.has(el.id)) continue;
      if (el.type === "text") {
        const box = textElementAabb(el as TextEl);
        const adj = selectionMoveLive ? { ...box, y: box.y - snapTextLineY(el.y) + el.y } : box;
        parts.push({ ...adj, elId: el.id });
      } else {
        const a = elementTightCanvasAabb(el);
        if (!a) continue;
        const adj = (el.type === "chat") && selectionMoveLive ? { ...a, y: el.y } : a;
        parts.push({ ...adj, elId: el.id });
      }
    }
    return parts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderTick, selectedIds, selectionMoveLive]);

  const selectionToolbarScreenPos = useMemo(() => {
    if (activeTool !== "mover" || selectedIds.length === 0 || selectionUnionRects.length === 0) return null;
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    for (const r of selectionUnionRects) {
      left = Math.min(left, r.x);
      right = Math.max(right, r.x + r.w);
      top = Math.min(top, r.y);
    }
    if (!Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(top)) return null;
    const cx = (left + right) / 2;
    return {
      left: offset.x + cx * scale,
      top: offset.y + top * scale,
    };
  }, [activeTool, offset.x, offset.y, scale, selectedIds.length, selectionUnionRects]);

  const textMarqueeToolbarPos = useMemo(() => {
    if (textMarqueeSelectedIds.size === 0) return null;
    let left = Infinity, right = -Infinity, top = Infinity;
    for (const el of allElementsRef.current) {
      if (!textMarqueeSelectedIds.has(el.id)) continue;
      let box: { x: number; y: number; w: number; h: number } | null = null;
      if (el.type === "text") box = textElementAabb(el as TextEl);
      else if (el.type === "table") box = { x: el.x, y: el.y, w: el.w, h: el.h };
      else if (el.type === "checklist") box = { x: el.x, y: el.y, w: el.w, h: el.h };
      if (!box) continue;
      left = Math.min(left, box.x);
      right = Math.max(right, box.x + box.w);
      top = Math.min(top, box.y);
    }
    if (!Number.isFinite(left)) return null;
    return {
      left: offset.x + ((left + right) / 2) * scale,
      top: offset.y + top * scale,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textMarqueeSelectedIds, offset.x, offset.y, scale, renderTick]);

  /** Expand a marquee selection into the flat list of editor IDs to format.
   *  Tables expand to `${tableId}:${r}:${c}` for every cell; text elements pass through. */
  const expandTextMarqueeToEditorIds = useCallback((ids: Set<string>): string[] => {
    const out: string[] = [];
    for (const id of ids) {
      const el = allElementsRef.current.find((e) => e.id === id);
      if (!el) continue;
      if (el.type === "text") out.push(id);
      else if (el.type === "table") {
        for (let r = 0; r < el.cells.length; r++) {
          const row = el.cells[r];
          for (let c = 0; c < row.length; c++) out.push(`${id}:${r}:${c}`);
        }
      }
      else if (el.type === "checklist") {
        for (let i = 0; i < el.items.length; i++) out.push(`${id}:${i}`);
      }
    }
    return out;
  }, []);

  /** Canvas bounds (in canvas space) of the latest marquee selection rectangle. Used for character-accurate erase on Backspace/Delete. */
  const selectionEraseBoundsRef = useRef<{ leftCanvas: number; rightCanvas: number; topCanvas: number; bottomCanvas: number } | null>(null);

  // ── Persistence (delegated to parent via onNoteChange) ──────────────────

  /** Persist using allElementsRef as the source of truth for elements. */
  function persistFromRef(immediate = false) {
    if (elDebounce.current) clearTimeout(elDebounce.current);
    // Read via ref so the second op in a same-tick rapid-create sequence
    // sees the just-created note rather than the stale closure-captured
    // `notes` from before the create. flushSync in the create paths updates
    // activeId synchronously; useLatest keeps activeNoteRef in step.
    const envelope = activeNoteRef.current;
    if (!envelope || !onNoteChangeRef.current) return;
    // Strip transient fields before persisting. Image/PDF `src` is also
    // dropped here (kept only in IDB under `blobId`) so localStorage stays
    // within its ~5-10 MB quota.
    const elements = stripBlobSrcsForPersist(allElementsRef.current).map(el => {
      if (el.type === "chat") return (({ isStreaming: _, estimatedOutputTokens: __, pendingSubmit: ___, pendingSubmitIsQuick: ____, ...c }) => c)(el as ChatEl) as ChatEl;
      if (el.type === "math") return (({ measuredW: _, measuredH: __, ...m }) => m)(el as MathEl) as MathEl;
      if (el.type === "table") return { ...el, cells: stripTableCellMeasures(el.cells) };
      if (el.type === "checklist") return { ...el, items: stripChecklistItemMeasures(el.items) };
      return el;
    });

    // Strip `locked` so the canvas never overwrites the parent's lock state
    const { locked: _stripLocked, ...rest } = envelope;
    const note = { ...rest, elements, pageRegions: pageRegionsRef.current } as NoteItem;
    if (immediate) { setTimeout(() => onNoteChangeRef.current?.(note), 0); return; }
    elDebounce.current = setTimeout(() => onNoteChangeRef.current?.(note), 400);
  }

  /**
   * Central mutation pipeline: mutate allElementsRef → rebuild R-tree → recompute visible → signal re-render → persist.
   * All element mutations go through here instead of calling setNotes directly.
   */
  function reconcileChatIds() {
    allElementsRef.current = assignChatNumbers(allElementsRef.current);
    chatCounterRef.current = Math.max(0, ...(allElementsRef.current.filter(el => el.type === "chat" && !(el as ChatEl).ephemeral) as ChatEl[]).map(el => el.chatNumber ?? 0)) + 1;
    const existingChatNums = new Set(
      (allElementsRef.current.filter(el => el.type === "chat" && !(el as ChatEl).ephemeral) as ChatEl[]).map(el => el.chatNumber)
    );
    allElementsRef.current = allElementsRef.current.map(el => {
      if (el.type !== "chat") return el;
      const chat = el as ChatEl;
      if (chat.parentChatNumber != null && chat.parentChatNumber !== -1 && !existingChatNums.has(chat.parentChatNumber)) {
        return { ...chat, parentChatNumber: -1 };
      }
      if (!chat.ephemeral && chat.parentChatNumber != null && chat.parentChatNumber === chat.chatNumber) {
        return { ...chat, parentChatNumber: -1 };
      }
      return el;
    });
    visibleElementsRef.current = allElementsRef.current;
  }

  /** Shared finalization: chat re-ID, spatial rebuild, history, render tick, persist. */
  function finalizeElements(opts: {
    prevSnapshot?: Snapshot;
    prevChatCount?: number;
    immediate: boolean;
    changedId?: string;
  }) {
    const aid = stateRef.current.activeId;
    if (!aid) return;
    if (opts.prevChatCount != null) {
      const newChatCount = allElementsRef.current.filter(el => el.type === "chat").length;
      if (newChatCount < opts.prevChatCount) reconcileChatIds();
    }
    rebuildSpatialIndices(allElementsRef.current, spatialRef.current);
    recomputeVisible();
    if (opts.prevSnapshot) {
      const current: Snapshot = { elements: allElementsRef.current, pageRegions: pageRegionsRef.current };
      history.record(aid, opts.prevSnapshot, current, opts.changedId);
    }
    setNotes(ns => ns.map(n => n.id === aid ? { ...n, updatedAt: Date.now() } : n));
    setRenderTick(t => t + 1);
    persistFromRef(opts.immediate);
  }

  function commitElements(
    mutator: (elements: CanvasEl[]) => CanvasEl[],
    opts?: { immediate?: boolean; skipHistory?: boolean; changedId?: string },
  ) {
    const aid = stateRef.current.activeId;
    if (!aid) return;
    const prevSnapshot = opts?.skipHistory ? undefined : {
      elements: structuredClone(allElementsRef.current),
      pageRegions: structuredClone(pageRegionsRef.current),
    };
    const prevChatCount = allElementsRef.current.filter(el => el.type === "chat").length;
    allElementsRef.current = mutator(allElementsRef.current);
    finalizeElements({ prevSnapshot, prevChatCount, immediate: opts?.immediate ?? false, changedId: opts?.changedId });
  }

  function commitPageRegions(
    mutator: (regions: PageRegion[]) => PageRegion[],
    opts?: { skipHistory?: boolean },
  ) {
    if (locked) return;
    const aid = stateRef.current.activeId;
    if (!aid) return;
    const prevSnapshot: Snapshot | undefined = opts?.skipHistory ? undefined : {
      elements: structuredClone(allElementsRef.current),
      pageRegions: structuredClone(pageRegionsRef.current),
    };
    const nextRegions = mutator(pageRegionsRef.current);
    pageRegionsRef.current = nextRegions;
    if (prevSnapshot) {
      const current: Snapshot = { elements: allElementsRef.current, pageRegions: nextRegions };
      history.record(aid, prevSnapshot, current);
    }
    setNotes(ns => {
      const next = ns.map(n => n.id === aid ? { ...n, pageRegions: nextRegions, updatedAt: Date.now() } : n);
      // Persist synchronously off the fresh copy — persistFromRef reads a stale closure.
      const updated = next.find(n => n.id === aid);
      if (updated && onNoteChangeRef.current) {
        const { locked: _drop, ...rest } = updated;
        setTimeout(() => onNoteChangeRef.current?.(rest as NoteItem), 0);
      }
      return next;
    });
  }

  function applyHistorySnapshot(aid: string, snapshot: Snapshot) {
    // Snapshot chats carry only outer state (x/y/w/h). Merge that onto each
    // live chat's inner state so messages/inputText/streaming survive undo.
    // Chats created after the snapshot are preserved (silent creation); chats
    // deleted after the snapshot are not resurrected (silent deletion).
    const liveChatMap = new Map(
      allElementsRef.current.filter((e): e is ChatEl => e.type === "chat").map((e) => [e.id, e]),
    );
    const snapIds = new Set(snapshot.elements.map((e) => e.id));

    const merged: CanvasEl[] = [];
    for (const el of snapshot.elements) {
      if (el.type === "chat") {
        const live = liveChatMap.get(el.id);
        if (!live) continue;
        merged.push({ ...live, x: el.x, y: el.y, w: el.w, h: el.h });
      } else {
        merged.push(el);
      }
    }
    for (const chat of liveChatMap.values()) {
      if (!snapIds.has(chat.id)) merged.push(chat);
    }

    allElementsRef.current = gcEmptyTextElements(merged);
    pageRegionsRef.current = snapshot.pageRegions;
    setSelectedPageRegionId(prev => prev && pageRegionsRef.current.some(r => r.id === prev) ? prev : null);
    setNotes(ns => ns.map(n => n.id === aid ? { ...n, pageRegions: pageRegionsRef.current } : n));
    finalizeElements({ immediate: true });
  }

  // Empty text elements should not persist in canvas space — blur normally
  // sweeps them, but undo/redo and note loads can revive snapshots that contain
  // them, and they would then pollute marquee selection / spatial queries.
  // Guards: keep the currently-focused element and any just-spawned element
  // (newElIdRef is set right after spawn, before its editor mounts and focuses).
  function gcEmptyTextElements(elements: CanvasEl[]): CanvasEl[] {
    const focusedId = focusedTextIdRef.current;
    const newId = newElIdRef.current;
    return elements.filter((el) => {
      if (el.type !== "text") return true;
      if (!isTextBlank((el as TextEl).text)) return true;
      if (el.id === focusedId) return true;
      if (el.id === newId) return true;
      return false;
    });
  }

  function handleUndo() {
    const aid = stateRef.current.activeId;
    if (!aid) return;
    const current: Snapshot = {
      elements: structuredClone(allElementsRef.current),
      pageRegions: structuredClone(pageRegionsRef.current),
    };
    const snapshot = history.undo(aid, current);
    if (snapshot) applyHistorySnapshot(aid, snapshot);
  }

  function handleRedo() {
    const aid = stateRef.current.activeId;
    if (!aid) return;
    const current: Snapshot = {
      elements: structuredClone(allElementsRef.current),
      pageRegions: structuredClone(pageRegionsRef.current),
    };
    const snapshot = history.redo(aid, current);
    if (snapshot) applyHistorySnapshot(aid, snapshot);
  }

  const handleUndoRef = useLatest(handleUndo);
  const handleRedoRef = useLatest(handleRedo);

  // Uses stateRef so it's always fresh even in refs/closures
  function createNoteWithElement(el: CanvasEl) {
    const aid = stateRef.current.activeId;
    if (!aid) {
      if (onCreateNoteRef.current) {
        const note = onCreateNoteRef.current(el);
        if (note) {
          allElementsRef.current = note.elements;
          rebuildSpatialIndices(allElementsRef.current, spatialRef.current);
          recomputeVisible();
          // flushSync forces the render before this function returns, so
          // stateRef.current.activeId reflects the new id immediately. Without
          // it, a second create call in the same tick (rapid paste, drag
          // commit, key repeat) would re-enter the !aid branch and produce a
          // duplicate note. Setting prevNoteIdRef *before* flushSync keeps the
          // prop-sync effect from also resetting state when noteProp catches up.
          prevNoteIdRef.current = note.id;
          flushSync(() => {
            setNotes([note]);
            setActiveId(note.id);
          });
          setRenderTick(t => t + 1);
        }
      }
      return;
    }
    commitElements(els => [...els, el], { immediate: true });
  }

  // ── Mid-level abstractions ──────────────────────────────────────────────

  /** Convert a mouse/pointer event to canvas coordinates using current viewport state. */
  function toCanvasPoint(e: { clientX: number; clientY: number }) {
    const rect = viewportRef.current!.getBoundingClientRect();
    const { offset, scale } = stateRef.current;
    return toCanvas(e.clientX, e.clientY, rect, offset, scale);
  }

  /** Walk up from a DOM node to the nearest [data-el-id] wrapper and return the matching CanvasEl, or null. */
  function getElementAtTarget(target: HTMLElement): CanvasEl | null {
    const wrapper = target.closest<HTMLElement>("[data-el-id]");
    const id = wrapper?.getAttribute("data-el-id");
    return id ? allElementsRef.current.find((x) => x.id === id) ?? null : null;
  }

  /** Execute a placement operation on the active note: mutate → resolve collisions → respond. */
  function execPlace(
    op: PlacementOp,
    response?: PlacementResponse & { immediate?: boolean; skipHistory?: boolean; changedId?: string }
  ) {
    if (locked) return;
    const aid = stateRef.current.activeId;
    if (!aid) {
      if (op.kind !== "spawn" || !onCreateNoteRef.current) return;
      const note = onCreateNoteRef.current(op.element);
      if (!note) return;
      allElementsRef.current = note.elements;
      committedIdsRef.current.add(op.element.id);
      rebuildSpatialIndices(allElementsRef.current, spatialRef.current);
      recomputeVisible();
      // See createNoteWithElement: flushSync prevents duplicate-create race
      // for back-to-back spawn ops in the same tick, prevNoteIdRef keeps the
      // prop-sync effect from resetting state when noteProp catches up.
      prevNoteIdRef.current = note.id;
      flushSync(() => {
        setNotes([note]);
        setActiveId(note.id);
      });
      setRenderTick(t => t + 1);
      return;
    }
    const prevSnapshot: Snapshot | undefined = response?.skipHistory ? undefined : {
      elements: structuredClone(allElementsRef.current),
      pageRegions: structuredClone(pageRegionsRef.current),
    };
    const prevChatCount = allElementsRef.current.filter(el => el.type === "chat").length;
    const prevIds = new Set(allElementsRef.current.map(el => el.id));
    const result = executePlacement(allElementsRef.current, op, response);
    mergeCaretRef.current = result.caretFocus
      ?? (response?.merge ? { id: response.merge.focusId, caret: response.merge.caret ?? 0 } : null);
    allElementsRef.current = result.elements;
    // Force-commit any brand-new element IDs so viewport culling doesn't queue
    // them to pendingIdsRef — otherwise pasted/spawned elements appear only
    // after the next idle callback / pan / tool switch.
    for (const el of result.elements) {
      if (!prevIds.has(el.id)) committedIdsRef.current.add(el.id);
    }
    finalizeElements({ prevSnapshot, prevChatCount, immediate: response?.immediate ?? true, changedId: response?.changedId });
  }


  function removeAllSelected() {
    const aid = activeId;
    if (!aid || selectedIds.length === 0) return;
    const rm = new Set(selectedIds);
    const bounds = selectionEraseBoundsRef.current;
    const isDrawTool = activeTool === "draw";
    execPlace({
      kind: "transform",
      fn: (elements) => {
        const nextElements: CanvasEl[] = [];
        for (const el of elements) {
          if (!rm.has(el.id)) {
            nextElements.push(el);
            continue;
          }
          // Draw-tool Backspace is scoped to draw elements only; any non-draw
          // survivors from a prior tool's selection stay put.
          if (el.type !== "draw" && isDrawTool) {
            nextElements.push(el);
            continue;
          }
          if (el.type === "text") {
            const frags = bounds
              ? eraseWithinBoxFully(el, bounds.leftCanvas, bounds.rightCanvas, bounds.topCanvas, bounds.bottomCanvas)
              : eraseWithinBoxFully(el, -Infinity, Infinity, -Infinity, Infinity);
            nextElements.push(...frags);
            continue;
          }
          // No highlight: erase whole element.
        }
        return nextElements;
      },
    });
    setSelectedIds([]);
    selectionEraseBoundsRef.current = null;
  }
  const removeAllSelectedRef = useLatest(removeAllSelected);

  // ── Sync from parent prop ────────────────────────────────────────────────

  const prevNoteIdRef = useRef(noteProp?.id ?? null);
  useEffect(() => {
    const newId = noteProp?.id ?? null;
    if (newId === prevNoteIdRef.current) return;
    prevNoteIdRef.current = newId;
    const els = gcEmptyTextElements(migrateChains(noteProp?.elements ?? []));
    allElementsRef.current = els;
    pageRegionsRef.current = noteProp?.pageRegions ?? [];
    rebuildSpatialIndices(els, spatialRef.current);
    // Resync chat counter from loaded elements
    chatCounterRef.current = Math.max(0, ...(els.filter(el => el.type === "chat" && !(el as ChatEl).ephemeral) as ChatEl[]).map(el => el.chatNumber ?? 0)) + 1;
    setNotes(noteProp ? [noteProp] : []);
    setActiveId(newId);
    setOffset({ x: 0, y: 0 });
    setScale(DEFAULT_SCALE);
    setSelectedIds([]);
    canvasVerticalColumnXRef.current = null;
    // Populate visibleElementsRef so the new note actually paints. Originally
    // this was deferred to onTransform after setOffset/setScale settled, but
    // when the new note happens to land at the same offset/scale (e.g. fresh
    // remount on route change with default 0/0/DEFAULT_SCALE) the pan-zoom
    // hook sees no change and onTransform never fires. Do it explicitly.
    recomputeVisible();
    setRenderTick((t) => t + 1);
  }, [noteProp?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Same-id prop updates: parent's lazy IDB hydration (app/notes/page.tsx)
  // patches blob `src` onto image/pdf elements without changing the note id,
  // so the effect above short-circuits. Merge any newly-arrived srcs into our
  // ref so the elements actually render.
  useEffect(() => {
    if (!noteProp || noteProp.id !== prevNoteIdRef.current) return;
    const propEls = noteProp.elements;
    if (!propEls?.length) return;
    const srcByElementId = new Map<string, string>();
    for (const el of propEls) {
      if ((el.type === "image" || el.type === "pdf") && el.src) {
        srcByElementId.set(el.id, el.src);
      }
    }
    if (srcByElementId.size === 0) return;
    let changed = false;
    const merged = allElementsRef.current.map(el => {
      if ((el.type === "image" || el.type === "pdf") && !el.src) {
        const src = srcByElementId.get(el.id);
        if (src) { changed = true; return { ...el, src }; }
      }
      return el;
    });
    if (!changed) return;
    allElementsRef.current = merged;
    rebuildSpatialIndices(merged, spatialRef.current);
    recomputeVisible();
    setRenderTick(t => t + 1);
  }, [noteProp]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setSelectedIds([]);
    setSelectionMoveLive(false);
    setCropEditingId(null);
  }, [activeId]);

  // Cropper assumes the target image is the one being interacted with; if it
  // leaves the selection (deselect, marquee replacement, deletion), close it.
  useEffect(() => {
    if (!cropEditingId) return;
    if (!selectedIds.includes(cropEditingId)) setCropEditingId(null);
  }, [cropEditingId, selectedIds]);

  // Recompute visible elements when viewport container resizes
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const ro = new ResizeObserver(() => { recomputeVisible(); setRenderTick(t => t + 1); });
    ro.observe(vp);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selectedIds.length === 0) selectionEraseBoundsRef.current = null;
  }, [selectedIds.length]);

  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      if (e.target instanceof HTMLTextAreaElement && e.target.id.startsWith("el-")) {
        setIsCanvasTyping(true);
      }
    };
    const onFocusOut = (e: FocusEvent) => {
      if (e.target instanceof HTMLTextAreaElement && e.target.id.startsWith("el-")) {
        setIsCanvasTyping(false);
      }
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  function blurCanvasLineTextareaIfFocused() {
    const ae = document.activeElement;
    if (ae instanceof HTMLTextAreaElement && ae.id.startsWith("el-")) {
      const elId = ae.id.slice(3);
      if (allElementsRef.current.some((e) => e.id === elId && e.type === "text")) ae.blur();
    }
    let blurredEditor = false;
    for (const ed of editorMapRef.current.values()) {
      if (ed.isFocused) { ed.commands.blur(); blurredEditor = true; }
    }
    if (blurredEditor) setFocusedTextId(null);
  }

  // Delete selected canvas elements (Backspace / Delete) when not typing in an input
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (locked) return;
      if (e.key !== "Backspace" && e.key !== "Delete") return;
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      if (selectedIdsRef.current.length === 0) return;
      e.preventDefault();
      removeAllSelectedRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ⌘Z / ⌘⇧Z (undo/redo), ⌘A (select all), ⌘C (copy text)
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      // Backspace/Delete with text marquee selection: delete selected elements
      if ((e.key === "Backspace" || e.key === "Delete") && textMarqueeSelectedIdsRef.current.size > 0) {
        e.preventDefault();
        execPlace({ kind: "remove", ids: new Set(textMarqueeSelectedIdsRef.current) });
        setTextMarqueeSelectedIds(new Set());
        return;
      }

      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();

      if (key === "z") {
        e.preventDefault();
        if (e.shiftKey) handleRedoRef.current();
        else handleUndoRef.current();
        return;
      }

      if (key === "a") {
        const t = e.target as HTMLElement | null;
        if (t?.closest("[data-chat-container]")) return;
        // Don't intercept Cmd+A when focus is outside the canvas (e.g. sidebar, topbar)
        if (t && !t.closest("[data-notes-canvas]")) return;

        if (!stateRef.current.activeId) return;

        // If a Tiptap editor with text is focused, let Tiptap handle Cmd+A natively
        if (t?.closest(".tiptap-display-wrap")) {
          // Inside a table cell: always defer to Tiptap so Cmd+A selects cell text.
          if (t.closest("[data-table-cell]")) return;
          const elWrapper = t.closest("[data-el-id]");
          if (elWrapper) {
            const elId = elWrapper.getAttribute("data-el-id")!;
            const el = allElementsRef.current.find(x => x.id === elId);
            if (el?.type === "text" && (el as TextEl).text !== "") return;
          }
        }

        e.preventDefault();
        setSelectedIds(allElementsRef.current.filter(el => el.type === "text").map(el => el.id));
        return;
      }

      if (key === "c") {
        const t = e.target as HTMLElement | null;
        if (t?.closest("[data-chat-container]")) return;

        // Text marquee selection: copy full text of selected elements
        if (textMarqueeSelectedIdsRef.current.size > 0) {
          const sel = textMarqueeSelectedIdsRef.current;
          const texts = allElementsRef.current
            .filter((el): el is TextEl => sel.has(el.id) && el.type === "text")
            .sort((a, b) => a.y - b.y || a.x - b.x)
            .map(el => (el as TextEl).text);
          if (texts.length > 0) {
            e.preventDefault();
            navigator.clipboard.writeText(texts.join("\n"));
          }
          return;
        }

        const isCanvasTiptap = t?.closest(".tiptap-display-wrap") && t.closest("[data-el-id]");
        // Non-canvas inputs: let browser handle. Tiptap editors: only let browser handle if no mover selection.
        if (!isCanvasTiptap && t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        if (isCanvasTiptap && selectedIdsRef.current.length === 0) return;

        if (!stateRef.current.activeId || selectedIdsRef.current.length === 0) return;

        const sel = new Set(selectedIdsRef.current);

        // Structured copy: every selected element (incl. text) goes into the
        // in-memory clipboard so paste reconstructs positions. Text also gets
        // mirrored to the OS clipboard as plain lines for cross-app paste.
        const selectedEls = allElementsRef.current.filter(el => sel.has(el.id));
        canvasClipboardRef.current = selectedEls.map(el => structuredClone(el));

        const lines = selectedEls
          .filter((el): el is TextEl => el.type === "text" && !isTextBlank(el.text))
          .sort((a, b) => a.y - b.y || a.x - b.x)
          .map(el => el.text);

        e.preventDefault();
        if (lines.length > 0) {
          const joined = lines.join("\n");
          navigator.clipboard.writeText(joined);
          lastCanvasCopyTextRef.current = joined;
        } else {
          // Didn't touch the OS clipboard — skip the staleness check on next paste.
          lastCanvasCopyTextRef.current = null;
        }
        return;
      }

      // Cmd+X on marquee-selected text: copy then delete
      if (key === "x" && textMarqueeSelectedIdsRef.current.size > 0) {
        e.preventDefault();
        const sel = textMarqueeSelectedIdsRef.current;
        const texts = allElementsRef.current
          .filter((el): el is TextEl => sel.has(el.id) && el.type === "text")
          .sort((a, b) => a.y - b.y || a.x - b.x)
          .map(el => el.text);
        if (texts.length > 0) navigator.clipboard.writeText(texts.join("\n"));
        execPlace({ kind: "remove", ids: new Set(sel) });
        setTextMarqueeSelectedIds(new Set());
        return;
      }

      // Cmd+B/I/U/S on marquee-selected text: apply formatting to all selected elements
      if (textMarqueeSelectedIdsRef.current.size > 0 && (key === "b" || key === "i" || key === "u" || key === "s")) {
        e.preventDefault();
        for (const elId of expandTextMarqueeToEditorIds(textMarqueeSelectedIdsRef.current)) {
          const editor = editorMapRef.current.get(elId);
          if (!editor) continue;
          // Select all content, toggle mark, then deselect
          editor.commands.selectAll();
          if (key === "b") editor.commands.toggleBold();
          else if (key === "i") editor.commands.toggleItalic();
          else if (key === "u") editor.commands.toggleUnderline?.();
          else if (key === "s") editor.commands.toggleStrike();
          editor.commands.setTextSelection(1);
        }
        return;
      }

      if (key === "v") {
        const t = e.target as HTMLElement | null;
        // Chat: let browser handle
        if (t?.closest("[data-chat-container]")) return;
        // Canvas textarea: the paste event listener handles it (single-line = browser, multi-line = chain splice)
        const isCanvasTextarea = t instanceof HTMLTextAreaElement && t.id.startsWith("el-");
        if (isCanvasTextarea) {
          // EXCEPT when there's a selection — intercept here to delete selection + paste
          if (selectedIdsRef.current.length === 0) return;
        }
        // Other inputs/contenteditable: let browser handle (but not canvas textareas we already checked)
        if (!isCanvasTextarea && t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

        e.preventDefault();

        // Staleness: if we previously wrote text to the OS clipboard and it now
        // differs, some other source overwrote it — drop the internal clip so
        // the OS clipboard wins. Runs async; paste continues on next microtask.
        if (canvasClipboardRef.current.length > 0 && lastCanvasCopyTextRef.current !== null) {
          try {
            const osText = await navigator.clipboard.readText();
            if (osText !== lastCanvasCopyTextRef.current) {
              canvasClipboardRef.current = [];
              lastCanvasCopyTextRef.current = null;
            }
          } catch {
            // Clipboard read unavailable (permissions/insecure origin) — fall through with internal clip.
          }
        }

        // ── Paste non-text elements from internal clipboard ──
        const clip = canvasClipboardRef.current;
        if (clip.length > 0) {
          const { activeId: aid3 } = stateRef.current;
          if (!aid3) return;

          // Place at cursor position
          const cp = toCanvasPoint(lastClientPos.current);

          // Compute bounding box center of clipped elements
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const el of clip) {
            const aabb = elementTightCanvasAabb(el);
            if (!aabb) continue;
            minX = Math.min(minX, aabb.x);
            minY = Math.min(minY, aabb.y);
            maxX = Math.max(maxX, aabb.x + aabb.w);
            maxY = Math.max(maxY, aabb.y + aabb.h);
          }
          const clipCx = (minX + maxX) / 2;
          const clipCy = (minY + maxY) / 2;
          const dx = cp.x - clipCx;
          const dy = cp.y - clipCy;

          const newEls = clip.map(el => {
            const moved = translateCanvasElBy(el, dx, dy);
            return { ...moved, id: crypto.randomUUID() };
          });

          // All existing elements are anchors; only pasted elements get pushed
          const existingIds = new Set(allElementsRef.current.map(el => el.id));
          execPlace({
            kind: "transform",
            fn: (els) => [...els, ...newEls],
            anchorIds: existingIds,
            resolve: dragResolvePush(),
          });
          setSelectedIds(newEls.map(el => el.id));
          return;
        }

        // ── Paste PDF, image, or text from system clipboard ──
        navigator.clipboard.read().then(async (items) => {
          // PDF first — macOS often exposes both application/pdf and a JPEG
          // thumbnail; without this, the image loop below grabs the thumbnail.
          for (const item of items) {
            if (item.types.includes("application/pdf")) {
              const blob = await item.getType("application/pdf");
              setActiveTool("mover");
              placePdfBlob(blob, "Pasted.pdf");
              return;
            }
          }
          // Then images
          for (const item of items) {
            const imageType = item.types.find(t => t.startsWith("image/"));
            if (imageType) {
              const blob = await item.getType(imageType);
              setActiveTool("mover");
              placeImageBlob(blob);
              return;
            }
          }

          // Fall back to text
          const textItem = items.find(i => i.types.includes("text/plain"));
          if (!textItem) return;
          const textBlob = await textItem.getType("text/plain");
          const clipText = await textBlob.text();
          if (!clipText) return;
          const lines = clipText.split("\n").filter(l => l.length > 0);
          if (lines.length === 0) return;

          // Place at cursor position
          const cp = toCanvasPoint(lastClientPos.current);
          const chain = placeChain(lines, cp.x, snapTextLineY(cp.y));

          // Selection active: remove selected, paste at cursor
          if (selectedIdsRef.current.length > 0) {
            if (!stateRef.current.activeId) return;
            const rm = new Set(selectedIdsRef.current);
            const existingIds = new Set(allElementsRef.current.filter(el => !rm.has(el.id)).map(el => el.id));

            execPlace({
              kind: "transform",
              fn: (elements) => {
                const kept = elements.filter(el => !rm.has(el.id));
                return [...kept, chain.elements[0]];
              },
              anchorIds: existingIds,
              resolve: verticalEnterPush(),
            }, chain.response);
            setSelectedIds([]);
            return;
          }

          // No active note: create one
          if (!stateRef.current.activeId) {
            createNoteWithElement(chain.elements[0]);
            mergeCaretRef.current = { id: chain.elements[0].id, caret: lines[0].length };
            return;
          }

          // Active note, no selection, no text focus: paste at cursor
          // All existing elements are anchors; only pasted text gets pushed
          const existingIds2 = new Set(allElementsRef.current.map(el => el.id));
          execPlace({
            kind: "transform",
            fn: (els) => [...els, chain.elements[0]],
            anchorIds: existingIds2,
            resolve: verticalEnterPush(),
          }, chain.response);
        }).catch((err) => { console.warn("Clipboard read failed:", err); });
        return;
      }

    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Paste: multi-line paste into a focused text element inserts newlines ────
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      // Chat: let browser handle
      if (t?.closest("[data-chat-container]")) return;

      // PDF paste (from Finder/Explorer/Preview): place as pdf element on canvas.
      // macOS often exposes the PDF only via clipboardData.items (with a JPEG
      // thumbnail also present) — without this fallback the image-paste loop
      // below would grab the thumbnail instead.
      const pdfFromFiles = Array.from(e.clipboardData?.files ?? []).find(f => f.type === "application/pdf");
      const pdfFromItems = !pdfFromFiles
        ? Array.from(e.clipboardData?.items ?? []).find(i => i.kind === "file" && i.type === "application/pdf")?.getAsFile() ?? null
        : null;
      const pdfFile = pdfFromFiles ?? pdfFromItems;
      if (pdfFile) {
        e.preventDefault();
        placePdfBlob(pdfFile, pdfFile.name || "Pasted.pdf");
        return;
      }

      // Image paste from any context: place as image element on canvas
      const items = e.clipboardData?.items;
      if (items) {
        for (const item of Array.from(items)) {
          if (item.type.startsWith("image/")) {
            // Focused canvas text element? — covers both legacy textarea and Tiptap contenteditable (both use id `el-<uuid>`)
            const ae = document.activeElement as HTMLElement | null;
            const focusedId = ae?.id?.startsWith("el-") ? ae.id.slice(3) : null;

            // Table cell focus: cell editor id is `el-<tableId>:<r>:<c>`.
            // Insert the image inline into the cell instead of creating a canvas ImageEl.
            const cellMatch = focusedId?.match(/^(.+):(\d+):(\d+)$/);
            if (cellMatch) {
              const cellKey = cellMatch[0];
              const cellEditor = editorMapRef.current.get(cellKey);
              if (cellEditor) {
                e.preventDefault();
                e.stopPropagation();
                const blob = item.getAsFile();
                if (blob) {
                  const reader = new FileReader();
                  reader.onload = () => {
                    cellEditor.chain().focus().setImage({ src: String(reader.result) }).run();
                    // setImage's onUpdate routes through cellChange → execPlace
                    // with immediate:false (debounced text typing). For an image
                    // paste we want the bytes hitting localStorage immediately.
                    persistFromRef(true);
                  };
                  reader.readAsDataURL(blob);
                }
                return;
              }
            }

            const focusedTextEl = focusedId
              ? (allElementsRef.current.find(x => x.id === focusedId && x.type === "text") as TextEl | undefined)
              : undefined;
            // Don't intercept if focus is in a non-canvas input (e.g. sidebar search)
            if (!focusedTextEl && t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
            e.preventDefault();
            e.stopPropagation();
            const blob = item.getAsFile();
            if (blob) {
              setActiveTool("mover");
              placeImageBlob(blob, focusedTextEl ? { x: focusedTextEl.x, y: focusedTextEl.y } : undefined);
            }
            return;
          }
        }
      }

      // Text paste into Tiptap editors is handled natively by ProseMirror.
      // The onUpdate callback will sync html/text back to el.
      // (Google Docs/Sheets/Slides URLs no longer auto-embed on paste — use /embed.)
    };
    window.addEventListener("paste", onPaste, true);
    return () => window.removeEventListener("paste", onPaste, true);
  }, []);

  // Track mouse position globally so paste/keyboard actions know where the cursor is
  useEffect(() => {
    const onMove = (e: MouseEvent) => { lastClientPos.current = { clientX: e.clientX, clientY: e.clientY }; };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  // Space key: start/stop freehand drawing when draw tool is active
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.key !== " ") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (stateRef.current.activeTool !== "draw") return;
      e.preventDefault();
      const cp = toCanvasPoint(lastClientPos.current);
      isDrawing.current = true;
      drawPts.current = [cp];
      setDrawPreview(`${cp.x},${cp.y}`);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key !== " ") return;
      if (!isDrawing.current || stateRef.current.activeTool !== "draw") return;
      isDrawing.current = false;
      if (drawPts.current.length > 1) {
        const { op } = spawnDraw(drawPts.current);
        execPlace(op);
      }
      drawPts.current = [];
      setDrawPreview(null);
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, []);

  // ── Tool selection function (used by toolbar + keyboard shortcuts) ──────────
  const selectTool = useCallback((id: ToolId) => {
    if (id === "eraser") {
      if (activeTool === "text") blurCanvasLineTextareaIfFocused();
      setActiveTool(activeTool === "eraser" ? null : "eraser");
      return;
    }
    setActiveTool((cur) => {
      const next = cur === id ? null : id;
      if (cur === "text") blurCanvasLineTextareaIfFocused();
      if (next === "mover" && cur !== "mover") blurCanvasLineTextareaIfFocused();
      if (next === "text") setSelectedIds([]);
      return next;
    });
  }, [activeTool]);

  // ── Single-key toolbar shortcuts (V, T, D, S, A, E, H, N, I, U) ───────────
  useEffect(() => {
    const KEY_TO_TOOL: Record<string, ToolId> = {
      v: "mover", t: "text", d: "draw", s: "shape",
      e: "eraser",
      i: "image", l: "noteRef", g: "graph",
    };
    const onToolKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.repeat) return;
      if (locked) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (stateRef.current.isCanvasTyping) return;

      const tool = KEY_TO_TOOL[e.key.toLowerCase()];
      if (!tool) return;

      e.preventDefault();
      selectTool(tool);
    };
    window.addEventListener("keydown", onToolKey);
    return () => window.removeEventListener("keydown", onToolKey);
  }, [locked, selectTool]);

  /** Marquee (or any) selection → Move tool so typing doesn’t fight select/drag; blur line editors. */
  useEffect(() => {
    if (selectedIds.length === 0) return;
    if (activeTool === "draw") return;
    setActiveTool("mover");
    blurCanvasLineTextareaIfFocused();
  }, [selectedIds]);

  // Touch: one finger → marquee select; two fingers → pan + pinch zoom (same as trackpad semantics)
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent) => {
      const tool = stateRef.current.activeTool;
      if (tool === "draw" || tool === "shape") return;

      if (tool === "eraser") {
        const target = e.target as HTMLElement;
        if (target.closest("button, a")) return;
        const t = e.touches[0];
        const rect = el.getBoundingClientRect();
        marquee.start("eraser", { vx: t.clientX - rect.left, vy: t.clientY - rect.top });
        return;
      }

      if (e.touches.length === 2) {
        e.preventDefault();
        const t0 = e.touches[0];
        const t1 = e.touches[1];
        const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        const cx = (t0.clientX + t1.clientX) / 2;
        const cy = (t0.clientY + t1.clientY) / 2;
        touchTwoRef.current = { dist, cx, cy };
        // Cancel any in-progress single-touch marquee — the hook clears preview + state.
        marquee.finalize();
        return;
      }
      if (e.touches.length !== 1) return;
      const target = e.target as HTMLElement;
      const moverCanvasTa =
        tool === "mover" &&
        target.tagName === "TEXTAREA" &&
        target.id.startsWith("el-") &&
        !!target.closest("[data-el]");
      if (isInteractive(target) && !moverCanvasTa) return;
      const t = e.touches[0];
      const rect = el.getBoundingClientRect();
      marquee.start("select", { vx: t.clientX - rect.left, vy: t.clientY - rect.top }, { touchMode: true });
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && touchTwoRef.current) {
        e.preventDefault();
        const t0 = e.touches[0];
        const t1 = e.touches[1];
        const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        const cx = (t0.clientX + t1.clientX) / 2;
        const cy = (t0.clientY + t1.clientY) / 2;
        const prev = touchTwoRef.current;
        const rect = el.getBoundingClientRect();
        let { offset, scale } = transformRef.current;

        offset = { x: offset.x + (cx - prev.cx), y: offset.y + (cy - prev.cy) };

        if (prev.dist > 10 && dist > 10) {
          const factor = dist / prev.dist;
          const ns = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
          const mx = cx - rect.left;
          const my = cy - rect.top;
          offset = { x: mx - (mx - offset.x) * (ns / scale), y: my - (my - offset.y) * (ns / scale) };
          scale = ns;
        }

        touchTwoRef.current = { dist, cx, cy };
        scheduleTransform(offset, scale);
        return;
      }
      if (e.touches.length === 1 && marquee.isActive()) {
        e.preventDefault();
        const t = e.touches[0];
        const rect = el.getBoundingClientRect();
        marquee.move({ vx: t.clientX - rect.left, vy: t.clientY - rect.top });
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) touchTwoRef.current = null;
      if (e.touches.length === 0) marquee.finalize();
    };

    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);

  // Two code paths assign focus/selection after `notes` updates:
  // - mergeCaretRef: Enter, merges, typing-driven merge (handleCanvasTextChange), etc.
  // - cmdArrowCaretRef: ⌘/Ctrl arrow fragment jump (caret after controlled textarea re-render from onFocus)
  // - newElIdRef: click-to-place empty text
  // mergeCaretRef must run first; otherwise a stale newElIdRef causes return early and Enter's
  // target is never applied (laggy / wrong textarea).
  useLayoutEffect(() => {
    // ⌘/Ctrl fragment jump must run before mergeCaretRef — a stale merge ref would otherwise steal this frame
    // and focus the wrong box with the wrong caret (often end-of-string).
    const cmd = cmdArrowCaretRef.current;
    if (cmd) {
      cmdArrowCaretRef.current = null;
      mergeCaretRef.current = null;
      newElIdRef.current = null;
      const ed = editorMapRef.current.get(cmd.id);
      if (ed) {
        ed.commands.focus(null, { scrollIntoView: false });
        const el = allElementsRef.current.find(x => x.id === cmd.id) as TextEl | undefined;
        const maxChar = el?.text.length ?? ed.getText({ blockSeparator: "\n" }).length;
        const c = Math.max(0, Math.min(cmd.caret, maxChar));
        const pmPos = charOffsetToPmPos(ed.state.doc, c);
        ed.commands.setTextSelection(pmPos);
      }
      return;
    }
    const mc = mergeCaretRef.current;
    if (mc) {
      mergeCaretRef.current = null;
      newElIdRef.current = null;
      setFocusedTextId(mc.id);
      requestAnimationFrame(() => {
        const ed = editorMapRef.current.get(mc.id);
        if (ed) {
          ed.commands.focus(null, { scrollIntoView: false });
          const el = allElementsRef.current.find(x => x.id === mc.id) as TextEl | undefined;
          const maxChar = el?.text.length ?? ed.getText({ blockSeparator: "\n" }).length;
          const c = Math.max(0, Math.min(mc.caret, maxChar));
          const pmPos = charOffsetToPmPos(ed.state.doc, c);
          ed.commands.setTextSelection(pmPos);
        }
      });
      return;
    }
    if (newElIdRef.current) {
      const id = newElIdRef.current;
      newElIdRef.current = null;
      setFocusedTextId(id);
      requestAnimationFrame(() => {
        const ed = editorMapRef.current.get(id);
        if (ed) {
          ed.commands.focus(null, { scrollIntoView: false });
          ed.commands.setTextSelection(1);
        }
      });
    }
  }, [notes, activeTool, cmdCaretLayoutKey]);

  useEffect(() => {
    const p = cmdCaretPostPaintRef.current;
    if (!p) return;
    cmdCaretPostPaintRef.current = null;
    const { id, caret } = p;
    const apply = () => {
      const ed = editorMapRef.current.get(id);
      if (!ed || !ed.isFocused) return;
      const maxChar = ed.getText({ blockSeparator: "\n" }).length;
      const c = Math.max(0, Math.min(caret, maxChar));
      const pmPos = charOffsetToPmPos(ed.state.doc, c);
      ed.commands.setTextSelection(pmPos);
    };
    apply();
    requestAnimationFrame(() => {
      apply();
      requestAnimationFrame(apply);
    });
  }, [cmdCaretLayoutKey]);



  // ── Canvas interactions ───────────────────────────────────────────────────

  function toolCursor(): string {
    return activeTool ? TOOLS.find(t => t.id === activeTool)?.cursor ?? "default" : "default";
  }

  /** Append a new element; all existing elements act as anchors so only the new one gets pushed on collision. */
  function appendAsNewEl(newEl: CanvasEl) {
    execPlace({
      kind: "transform",
      fn: (els) => [...els, newEl],
      anchorIds: new Set(allElementsRef.current.map((el) => el.id)),
      resolve: dragResolvePush(),
    });
  }

  /** Snapshot `ids` from `pool`, arm the selection-move drag refs, and flip the viewport cursor.
   *  Returns true if the drag was armed (caller should `e.preventDefault(); return;`). */
  function startSelectionMoveDrag(
    cp: { x: number; y: number },
    ids: string[],
    pool: CanvasEl[],
    opts?: { setSelection?: boolean },
  ): boolean {
    const snapshots: Record<string, CanvasEl> = {};
    for (const id of ids) {
      const el = pool.find((x) => x.id === id);
      if (el) snapshots[id] = structuredClone(el) as CanvasEl;
    }
    if (Object.keys(snapshots).length === 0) return false;
    if (opts?.setSelection) setSelectedIds(ids);
    selectionMoveDragRef.current = {
      originCanvas: { x: cp.x, y: cp.y },
      lastCanvas: { x: cp.x, y: cp.y },
      snapshots,
    };
    isSelectionMoveDragging.current = true;
    if (viewportRef.current) viewportRef.current.style.cursor = "grabbing";
    return true;
  }

  /** Hit-then-drag: if click lands on an already-selected element, drag the
   *  whole selection; else if it lands on any element in `pool`, select + drag
   *  that one. Returns true if a drag was armed. */
  function trySelectionGrab(
    cp: { x: number; y: number },
    pool: CanvasEl[],
    opts?: { exclude?: Set<string>; checkSelected?: boolean },
  ): boolean {
    const { exclude } = opts ?? {};
    const checkSelected = opts?.checkSelected !== false;
    if (checkSelected && selectedIdsRef.current.length > 0) {
      const sel = new Set(selectedIdsRef.current);
      if (canvasPointHitsAnySelectedEl(cp.x, cp.y, pool, sel, exclude)) {
        if (startSelectionMoveDrag(cp, selectedIdsRef.current, pool)) return true;
      }
    }
    const hitId = canvasPointHitsSingleEl(cp.x, cp.y, pool, exclude);
    return !!(hitId && startSelectionMoveDrag(cp, [hitId], pool, { setSelection: true }));
  }

  const marquee = useMarquee(viewportRef, stateRef, allElementsRef, {
    onSelect: (ids, bounds) => {
      setSelectedIds(ids);
      selectionEraseBoundsRef.current = bounds;
    },
    onErase: (rm, eraseLeftCanvas, eraseRightCanvas) => {
      const removedIds = new Set<string>();
      commitElements(els => {
        const nextElements: CanvasEl[] = [];
        for (const el of els) {
          if (!rm.has(el.id)) { nextElements.push(el); continue; }
          if (el.type === "text") {
            const frags = eraseWithinBoxFully(el, eraseLeftCanvas, eraseRightCanvas);
            if (frags.length === 0) { removedIds.add(el.id); continue; }
            nextElements.push(...frags);
            continue;
          }
          removedIds.add(el.id);
        }
        return nextElements;
      }, { immediate: true });
      setSelectedIds(s => s.filter(id => !removedIds.has(id)));
    },
    onTextMarqueeChange: (ids) => setTextMarqueeSelectedIds(ids),
    onDismissClick: (dismiss) => { suppressNextClickRef.current = dismiss; },
    restoreCursor: () => {
      const vp = viewportRef.current;
      if (vp) vp.style.cursor = toolCursor();
    },
  });

  useEffect(() => {
    const onUp = () => {
      if (isSelectionMoveDragging.current) {
        finalizeSelectionMoveDragRef.current();
        const vp = viewportRef.current;
        if (vp) vp.style.cursor = toolCursor();
      }
      marquee.finalize();
      if (isPanning.current) {
        isPanning.current = false;
        if (viewportRef.current) viewportRef.current.style.cursor = toolCursor();
      }
    };
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (e.button === 1 || (locked && e.button === 0)) {
      if (!isInteractive(e.target as HTMLElement)) {
        // Empty-canvas click: start pan, swallow default to avoid selection drag.
        e.preventDefault();
        isPanning.current = true;
        panDistanceRef.current = 0;
        lastMouse.current = { x: e.clientX, y: e.clientY };
        viewportRef.current!.style.cursor = "grabbing";
      }
      // Click landed on a canvas element — let the browser start a native
      // selection so locked notes still allow text highlight + copy.
      return;
    }
    if (e.button !== 0) return;

    const rectVp = viewportRef.current!.getBoundingClientRect();
    const mdTarget = e.target as HTMLElement;
    // Clear page-region selection when mousedown lands outside ANY page region.
    // (Clicking a different region lets its own mousedown set selection.)
    if (selectedPageRegionId && !mdTarget.closest(`[data-page-region-id]`)) {
      setSelectedPageRegionId(null);
    }
    // Click inside a table container (but not on its resize handles) → let the cell
    // editors focus naturally instead of starting a canvas drag/marquee. The mover
    // tool is the exception: it must fall through so the table can be selected
    // and dragged as a whole.
    const tableContainer = mdTarget.closest("[data-table-container]");
    if (tableContainer && !mdTarget.closest("[data-table-handle]") && activeTool !== "mover") return;
    // Click inside a chat container — any tool switches to text
    const chatContainer = mdTarget.closest("[data-chat-container]");

    if (activeTool === "eraser") {
      if (chatContainer) {
        flushSync(() => { setActiveTool("text"); setSelectedIds([]); });
        return;
      }
      marquee.start("eraser", { vx: e.clientX - rectVp.left, vy: e.clientY - rectVp.top });
      viewportRef.current!.style.cursor = "crosshair";
      return;
    }
    if (chatContainer) {
      // If mover has this chat selected, let it fall through to drag logic
      const chatEl = getElementAtTarget(chatContainer as HTMLElement);
      const chatIsSelected = chatEl && selectedIdsRef.current.includes(chatEl.id);
      if (!(activeTool === "mover" && chatIsSelected)) {
        // Any other case: switch to text so user can type
        flushSync(() => {
          setActiveTool("text");
          setSelectedIds([]);
        });
        return;
      }
    }
    // Form control outside any canvas element (toolbar, overlay) → it owns its click.
    if (isNativeFormControl(mdTarget) && !isCanvasElement(mdTarget)) return;
    // Inside a canvas-element wrapper (e.g. table/checklist cell) → let the cell
    // handle it, unless mover wants to select/drag the whole element.
    if (isCanvasElement(mdTarget) && activeTool !== "mover") return;

    const cp = toCanvasPoint(e);

    if (activeTool === "shape") {
      isDrawing.current = true;
      dragStart.current = { cx: cp.x, cy: cp.y };
    } else if (activeTool === "draw") {
      const dragToDraw = settings.drawDragToDraw;
      const wantsDraw = dragToDraw && !e.shiftKey;

      if (wantsDraw) {
        // Drag-to-draw: start freehand drawing immediately
        isDrawing.current = true;
        drawPts.current = [cp];
        setDrawPreview(`${cp.x},${cp.y}`);
        e.preventDefault();
        return;
      }

      // Selection mode: select/drag draw elements, or marquee
      if (activeId) {
        const drawOnly = allElementsRef.current.filter((el) => el.type === "draw");
        if (trySelectionGrab(cp, drawOnly)) { e.preventDefault(); return; }
      }
      marquee.start("select", { vx: e.clientX - rectVp.left, vy: e.clientY - rectVp.top }, { shift: e.shiftKey });
      viewportRef.current!.style.cursor = "crosshair";
    } else {
      // Mover: allow clicking/dragging all element types including draw.
      // Other tools: exclude draw from single-click selection.
      const excludeFromClick = activeTool === "mover" ? new Set<string>() : new Set(["draw"]);

      if (activeTool === "mover" && activeId) {
        if (trySelectionGrab(cp, allElementsRef.current, { exclude: excludeFromClick })) {
          e.preventDefault();
          return;
        }
      }
      if (activeTool === "text" && e.shiftKey) {
        // Shift+drag with text tool: act like mover (select/drag elements).
        // checkSelected:false — ignore any existing selection, always pick the hit element.
        if (trySelectionGrab(cp, allElementsRef.current, { exclude: new Set(["draw"]), checkSelected: false })) {
          e.preventDefault();
          return;
        }
        // No element hit → fall through to the marquee-start below
      }
      const anchor = { vx: e.clientX - rectVp.left, vy: e.clientY - rectVp.top };
      // Three marquee flavors from this branch:
      //   - shift + text tool: select-mode with shift (no element hit, fell through)
      //   - text tool: text-marquee for character-level selection
      //   - anything else: plain select
      if (activeTool === "text" && !e.shiftKey) {
        marquee.start("text", anchor);
      } else {
        marquee.start("select", anchor, { shift: e.shiftKey });
      }
      viewportRef.current!.style.cursor = (activeTool === "text" && !e.shiftKey) ? "text" : "crosshair";
    }
  }

  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    lastClientPos.current = { clientX: e.clientX, clientY: e.clientY };

    if (pageMarginDragRef.current) { drags.pageMarginDrag.move(pageMarginDragRef.current, e, dragDeps); return; }
    if (pageRegionDragRef.current) { drags.pageRegionDrag.move(pageRegionDragRef.current, e, dragDeps); return; }
    if (textSelectDrag.current)    { drags.textSelectDrag.move(textSelectDrag.current, e, dragDeps); }

    if (isPanning.current) {
      const dx = e.clientX - lastMouse.current.x;
      const dy = e.clientY - lastMouse.current.y;
      panDistanceRef.current += Math.abs(dx) + Math.abs(dy);
      lastMouse.current = { x: e.clientX, y: e.clientY };
      const { offset: prev, scale: sc } = transformRef.current;
      scheduleTransform({ x: prev.x + dx, y: prev.y + dy }, sc);
      return;
    }

    if (arrowTipDrag.current)      { drags.arrowTipDrag.move(arrowTipDrag.current, e, dragDeps); return; }
    if (shapeResizeDrag.current)   { drags.shapeResizeDrag.move(shapeResizeDrag.current, e, dragDeps); return; }
    if (imageResizeDrag.current)   { drags.imageResizeDrag.move(imageResizeDrag.current, e, dragDeps); return; }

    if (isSelectionMoveDragging.current && selectionMoveDragRef.current && activeId) {
      const cp = toCanvasPoint(e);
      const d = selectionMoveDragRef.current;
      d.lastCanvas = { x: cp.x, y: cp.y };
      const dx = cp.x - d.originCanvas.x;
      const dy = cp.y - d.originCanvas.y;
      dragDeltaRef.current = { dx, dy };

      // Defer selectionMoveLive until actual movement to avoid chat bobbing on click
      if ((dx !== 0 || dy !== 0) && !selectionMoveLive) setSelectionMoveLive(true);

      // CSS-only transform — zero React re-renders during drag
      const vp = viewportRef.current;
      if (vp) {
        for (const id of selectedIdsRef.current) {
          const node = vp.querySelector(`[data-el-id="${id}"]`) as HTMLElement | SVGElement | null;
          if (!node) continue;
          if (node instanceof SVGElement) {
            node.setAttribute("transform", `translate(${dx}, ${dy})`);
          } else {
            node.style.transform = `translate(${dx}px, ${dy}px)`;
          }
        }
        vp.querySelectorAll("[data-sel-rect]").forEach((node) => {
          (node as HTMLElement).style.transform = `translate(${dx}px, ${dy}px)`;
        });
      }
      return;
    }

    if (marquee.isActive()) {
      const rect = viewportRef.current!.getBoundingClientRect();
      marquee.move({ vx: e.clientX - rect.left, vy: e.clientY - rect.top });
      return;
    }

    if (!isDrawing.current) return;
    const cp = toCanvasPoint(e);

    if (activeTool === "draw") {
      drawPts.current.push(cp);
      setDrawPreview(drawPts.current.map(p => `${p.x},${p.y}`).join(" "));
    } else if (activeTool === "shape" && dragStart.current) {
      if (shapeSubTool === "arrow") {
        setArrowPreview({ x1: dragStart.current.cx, y1: dragStart.current.cy, x2: cp.x, y2: cp.y });
      } else {
        const x = Math.min(dragStart.current.cx, cp.x);
        const y = Math.min(dragStart.current.cy, cp.y);
        const w = Math.abs(cp.x - dragStart.current.cx);
        const h = Math.abs(cp.y - dragStart.current.cy);
        setShapePreview({ x, y, w, h });
      }
    }
  }

  function handleMouseUp() {
    // Clear text selection drag
    textSelectDrag.current = null;

    if (pageMarginDragRef.current) {
      const ref = pageMarginDragRef.current; pageMarginDragRef.current = null;
      drags.pageMarginDrag.commit(ref, dragDeps);
      return;
    }
    if (pageRegionDragRef.current) {
      const ref = pageRegionDragRef.current; pageRegionDragRef.current = null;
      drags.pageRegionDrag.commit(ref, dragDeps);
      return;
    }
    if (arrowTipDrag.current) {
      const ref = arrowTipDrag.current; arrowTipDrag.current = null;
      drags.arrowTipDrag.commit(ref, dragDeps);
      if (viewportRef.current) viewportRef.current.style.cursor = toolCursor();
      return;
    }
    if (shapeResizeDrag.current) {
      const ref = shapeResizeDrag.current; shapeResizeDrag.current = null;
      drags.shapeResizeDrag.commit(ref, dragDeps);
      if (viewportRef.current) viewportRef.current.style.cursor = toolCursor();
      return;
    }
    if (imageResizeDrag.current) {
      const ref = imageResizeDrag.current; imageResizeDrag.current = null;
      drags.imageResizeDrag.commit(ref, dragDeps);
      if (viewportRef.current) viewportRef.current.style.cursor = toolCursor();
      return;
    }

    if (isSelectionMoveDragging.current) {
      finalizeSelectionMoveDragRef.current();
      if (viewportRef.current) viewportRef.current.style.cursor = toolCursor();
      return;
    }

    marquee.finalize();

    if (isPanning.current) {
      isPanning.current = false;
      viewportRef.current!.style.cursor = toolCursor();
      return;
    }

    if (isDrawing.current) {
      isDrawing.current = false;

      if (activeTool === "draw" && drawPts.current.length > 1) {
        const { op } = spawnDraw(drawPts.current);
        execPlace(op);
        suppressNextClickRef.current = true;
      } else if (activeTool === "shape" && shapeSubTool === "arrow" && arrowPreview) {
        const dx = arrowPreview.x2 - arrowPreview.x1, dy = arrowPreview.y2 - arrowPreview.y1;
        if (Math.sqrt(dx * dx + dy * dy) > 10) {
          const { op } = spawnArrow(arrowPreview.x1, arrowPreview.y1, arrowPreview.x2, arrowPreview.y2);
          execPlace(op);
          shapeJustCreatedRef.current = true;
        }
      } else if (activeTool === "shape" && shapePreview && shapePreview.w > 5 && shapePreview.h > 5) {
        const { op } = spawnShape(shapePreview, shapeSubTool as "rect" | "circle" | "triangle");
        execPlace(op);
        shapeJustCreatedRef.current = true;
      }

      drawPts.current = [];
      dragStart.current = null;
      setDrawPreview(null);
      setShapePreview(null);
      setArrowPreview(null);
    }
  }

  /** Click on empty canvas with a non-text tool: if selection exists, just
   *  deselect (one-step); else switch to text and place a text element
   *  (two-step: a second click will now place). */
  function clickEmptyCanvasToText(cx: number, cy: number) {
    if (selectedIdsRef.current.length > 0) {
      setSelectedIds([]);
      return;
    }
    flushSync(() => { setActiveTool("text"); });
    placeTextAtCanvas(cx, cy);
  }

  /** Place or focus a text element at canvas point (cx, cy). Shared by text-tool click and mover double-click. */
  function placeTextAtCanvas(cx: number, cy: number) {
    const aid = stateRef.current.activeId;
    if (!aid) {
      if (onCreateNoteRef.current) {
        const textId = crypto.randomUUID();
        const firstEl: CanvasEl = { id: textId, type: "text", x: cx, y: snapTextLineY(cy), text: "" };
        const note = onCreateNoteRef.current(firstEl);
        if (note) {
          allElementsRef.current = note.elements;
          committedIdsRef.current.add(textId);
          rebuildSpatialIndices(allElementsRef.current, spatialRef.current);
          recomputeVisible();
          // Order matters: prevNoteIdRef + newElIdRef must be set *before*
          // flushSync. The layout effect that consumes newElIdRef to focus
          // the just-spawned element runs synchronously during flushSync
          // (notes changed → deps changed). prevNoteIdRef keeps the
          // prop-sync effect from resetting state when noteProp catches up.
          // flushSync ensures stateRef.current.activeId is updated before
          // this returns, so a back-to-back placement does not re-enter
          // the !aid branch and create a duplicate note.
          prevNoteIdRef.current = note.id;
          newElIdRef.current = textId;
          flushSync(() => {
            setNotes([note]);
            setActiveId(note.id);
          });
          setRenderTick(t => t + 1);
        }
      }
      return;
    }
    canvasVerticalColumnXRef.current = null;
    const resolution = resolveTextClick(allElementsRef.current, cx, cy);
    switch (resolution.action) {
      case "focus":
        setFocusedTextId(resolution.id);
        requestAnimationFrame(() => {
          const ed = editorMapRef.current.get(resolution.id);
          if (ed) ed.commands.focus(null, { scrollIntoView: false });
        });
        return;
      case "caret": {
        setFocusedTextId(resolution.id);
        requestAnimationFrame(() => {
          const ed = editorMapRef.current.get(resolution.id);
          if (ed) {
            ed.commands.focus(null, { scrollIntoView: false });
            const pmPos = charOffsetToPmPos(ed.state.doc, resolution.caretIndex);
            ed.commands.setTextSelection(pmPos);
          }
        });
        return;
      }
      case "create": {
        const { op, id } = spawnText(resolution.x, resolution.y);
        execPlace(op);
        newElIdRef.current = id;
        return;
      }
    }
  }

  function handleDoubleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (locked) return;
    const target = e.target as HTMLElement;
    const isContainer = (e.target as HTMLElement).closest("[data-chat-container]");
    const dblClickTools = activeTool === "mover" || activeTool === "shape";
    if (dblClickTools && isContainer) {
      e.preventDefault();
      setActiveTool("text");
      const ta = (isContainer as Element).querySelector("textarea") as HTMLTextAreaElement | null;
      if (ta) {
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
      return;
    }
    // Table cell / checklist item: dbl-click in mover or shape tool re-routes
    // to the same path as a single click with the text tool — switch tool,
    // mount the cell's Tiptap if needed, and place the caret at click point.
    if (dblClickTools) {
      const cellLike = target.closest<HTMLElement>("[data-table-cell], [data-checklist-item]");
      if (cellLike) {
        e.preventDefault();
        flushSync(() => {
          setActiveTool("text");
          setSelectedIds([]);
        });
        const clientX = e.clientX;
        const clientY = e.clientY;
        const placeCaret = () => {
          const editorDom = cellLike.querySelector<HTMLElement>(".ProseMirror");
          if (!editorDom) return;
          editorDom.focus({ preventScroll: true });
          const doc = editorDom.ownerDocument;
          // Prefer the standardized caretPositionFromPoint; fall back to the
          // deprecated webkit caretRangeFromPoint for older Safari.
          type WithCaretPos = Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
          let range: Range | null = null;
          const caretPos = (doc as WithCaretPos).caretPositionFromPoint?.(clientX, clientY);
          if (caretPos) {
            range = doc.createRange();
            range.setStart(caretPos.offsetNode, caretPos.offset);
            range.collapse(true);
          } else if (typeof doc.caretRangeFromPoint === "function") {
            range = doc.caretRangeFromPoint(clientX, clientY);
          }
          if (range) {
            const sel = doc.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
          }
        };
        if (cellLike.querySelector(".ProseMirror")) {
          placeCaret();
        } else {
          // Empty cell — Tiptap hasn't mounted. Dispatch mousedown so the
          // cell's own activation logic runs, then place the caret after
          // mount + focus settle (two rAFs).
          cellLike.dispatchEvent(new MouseEvent("mousedown", {
            bubbles: true, cancelable: true, button: 0, clientX, clientY,
          }));
          requestAnimationFrame(() => requestAnimationFrame(placeCaret));
        }
        return;
      }
    }
    if (isContainer || !dblClickTools) return;
    // Double-click on a text textarea → switch to text tool and focus it
    if (target instanceof HTMLTextAreaElement && target.id.startsWith("el-")) {
      e.preventDefault();
      const elId = target.id.replace(/^el-/, "");
      const el = allElementsRef.current.find((x) => x.id === elId && x.type === "text") as TextEl | undefined;
      setActiveTool("text");
      setSelectedIds([]);
      target.focus();
      if (el) {
        const { x: canvasX, y: canvasY } = toCanvasPoint(e);
        const caret = canvasCaretIndexAtPoint(el, canvasX, canvasY);
        target.setSelectionRange(caret, caret);
      } else {
        target.setSelectionRange(target.value.length, target.value.length);
      }
      return;
    }
    // Double-click on a display-mode text element → switch to text tool and place caret
    const elWrapper = target.closest("[data-el-id]") as HTMLElement | null;
    if (elWrapper) {
      const elId = elWrapper.getAttribute("data-el-id")!;
      const el = allElementsRef.current.find((x) => x.id === elId);
      if (el && el.type === "text") {
        e.preventDefault();
        const { x: cx, y: cy } = toCanvasPoint(e);
        const caret = canvasCaretIndexAtPoint(el as TextEl, cx, cy);
        flushSync(() => {
          setActiveTool("text");
          setSelectedIds([]);
          setFocusedTextId(elId);
        });
        requestAnimationFrame(() => {
          const ed = editorMapRef.current.get(elId);
          if (ed) {
            ed.commands.focus(null, { scrollIntoView: false });
            const pmPos = charOffsetToPmPos(ed.state.doc, caret);
            ed.commands.setTextSelection(pmPos);
          }
        });
        return;
      }
    }
    if (isInteractive(target)) return;
    flushSync(() => {
      setActiveTool("text");
      setSelectedIds([]);
    });
    const { x: cx, y: cy } = toCanvasPoint(e);
    placeTextAtCanvas(cx, cy);
  }

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (locked) return;
    // Suppress click events that are part of a double-click (handled by handleDoubleClick)
    if ((activeTool === "mover" || activeTool === "shape" || activeTool === "eraser") && e.detail >= 2) return;
    if ((e.target as HTMLElement).closest("[data-chat-container]")) return;
    // Mover: handle before isInteractive so element clicks are processed
    if (activeTool === "mover") {
      if (suppressNextClickRef.current) { suppressNextClickRef.current = false; return; }
      // Click landed on a page region → its own mousedown handles selection; don't fall through.
      if ((e.target as HTMLElement).closest("[data-page-region-id]")) return;
      const targetEl = getElementAtTarget(e.target as HTMLElement);
      if (targetEl && targetEl.type === "chat") {
        // Click on chat → switch to text so user can type in it
        flushSync(() => { setActiveTool("text"); setSelectedIds([]); });
        return;
      }
      if (!targetEl) {
        // Click on a form control outside any canvas element (e.g. floating
        // toolbar button) → let that control handle it, don't spawn text.
        if (isNativeFormControl(e.target as HTMLElement)) return;
        const { x: cx, y: cy } = toCanvasPoint(e);
        clickEmptyCanvasToText(cx, cy);
      }
      return;
    }

    if (isInteractive(e.target as HTMLElement)) return;

    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    // Clear text char selection on any canvas click
    if (textMarqueeSelectedIdsRef.current.size > 0) setTextMarqueeSelectedIds(new Set());

    const priorTool = activeTool;
    const { x: cx, y: cy } = toCanvasPoint(e);

    if (priorTool === "shape" && shapeJustCreatedRef.current) {
      shapeJustCreatedRef.current = false;
      return;
    }

    if (priorTool === "eraser" || priorTool === "draw" || priorTool === "shape") {
      clickEmptyCanvasToText(cx, cy);
      return;
    }

    setSelectedIds([]);

    const skipPlacementAfterPan = panDistanceRef.current > 6;
    panDistanceRef.current = 0;

    const allowTextPlace = !priorTool || priorTool === "text";
    if (allowTextPlace) {
      if (skipPlacementAfterPan) return;
      placeTextAtCanvas(cx, cy);
      return;
    }

    if (priorTool === "noteRef") {
      if (skipPlacementAfterPan) return;
      // Don't open picker if click landed on toolbar or another overlay
      if ((e.target as HTMLElement).closest("[data-overlay-panel], button")) return;
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return;
      const { offset: off, scale: sc } = stateRef.current;
      const screenX = rect.left + off.x + cx * sc;
      const screenY = rect.top + off.y + cy * sc;
      setNotePickerPos({ cx, cy, screenX, screenY });
      setNotePickerSearch("");
      return;
    }

    if (priorTool === "image") {
      fileInputRef.current?.click();
      return;
    }

    if (priorTool === "pdf") {
      pdfInputRef.current?.click();
      return;
    }

    if (skipPlacementAfterPan) return;
    if (priorTool && spawnToolAt(priorTool, cx, cy)) {
      setActiveTool("mover");
    }
  }

  /** Spawn the element type associated with `tool` at canvas point (cx, cy).
   *  Returns true if a spawn happened. Used by single-click on empty canvas
   *  with a spawn-tool active. */
  function spawnToolAt(tool: ToolId, cx: number, cy: number): boolean {
    switch (tool) {
      case "graph": {
        const graphEl: GraphEl = {
          id: crypto.randomUUID(), type: "graph",
          x: cx, y: cy, w: 600, h: 400,
          graphNum: nextGraphNum(allElementsRef.current),
        };
        execPlace({ kind: "spawn", element: graphEl }, { immediate: true });
        return true;
      }
      case "print":
        spawnPageRegionAt(cx, cy);
        return true;
      case "chat":
        spawnChatAt(cx, cy);
        return true;
      case "table": {
        const rows = 3, cols = 3;
        const cells: TableCell[][] = Array.from({ length: rows }, () =>
          Array.from({ length: cols }, () => ({ html: "" })),
        );
        const MIN_CELL = 44, BORDER = 1;
        const w = cols * MIN_CELL + (cols + 1) * BORDER;
        const h = rows * MIN_CELL + (rows + 1) * BORDER;
        const el: TableEl = {
          id: crypto.randomUUID(), type: "table",
          x: cx - w / 2, y: cy,
          w, h, cells,
        };
        execPlace({ kind: "spawn", element: el, resolve: dragResolvePush() });
        return true;
      }
      case "checklist": {
        const w = 240, h = 56;
        const el: ChecklistEl = {
          id: crypto.randomUUID(), type: "checklist",
          x: cx - w / 2, y: cy,
          w, h,
          items: [{ html: "", checked: false }],
        };
        execPlace({ kind: "spawn", element: el, resolve: dragResolvePush() });
        return true;
      }
      default:
        return false;
    }
  }

  function spawnChatAt(cx: number, cy: number) {
    const chatElId = crypto.randomUUID();
    const chatId = crypto.randomUUID();
    const chatNumber = chatCounterRef.current++;
    const el: ChatEl = {
      id: chatElId,
      type: "chat",
      x: cx,
      y: snapTextLineY(cy),
      chatId,
      chatNumber,
      messages: [],
      inputText: "",
    };
    execPlace({ kind: "spawn", element: el, resolve: dragResolvePush() });
    focusChatInput(chatElId);
  }

  function spawnPageRegionAt(cx: number, cy: number, size: PageSize = "letter", rotation: PageRotation = 0) {
    const { w, h } = pageRegionDims(size, rotation);
    const region: PageRegion = {
      id: crypto.randomUUID(),
      x: cx - w / 2,
      y: cy - h / 2,
      size,
      rotation,
    };
    commitPageRegions(rs => [...rs, region]);
    setSelectedPageRegionId(region.id);
  }


  // ── Note management ───────────────────────────────────────────────────────

  function updateEl(elId: string, patch: Partial<CanvasEl>) {
    commitElements(
      els => els.map(el => el.id === elId ? { ...el, ...patch } as CanvasEl : el),
      { immediate: false, changedId: elId },
    );
  }

  function removeEl(elId: string) {
    commitElements(
      els => els.filter(el => el.id !== elId),
      { immediate: true },
    );
    setSelectedIds((prev) => prev.filter((id) => id !== elId));
  }

  function handleToggleLock() {
    if (onToggleLock) onToggleLock();
  }

  function handleCanvasTextChange(elId: string, html: string, plainText: string) {
    canvasVerticalColumnXRef.current = null;
    if (!activeId) return;
    execPlace(
      {
        kind: "transform",
        fn: (elements) => {
          return elements.map((el) => {
            if (el.id !== elId || el.type !== "text") return el;
            // Command matching: only for single-line text elements (first line)
            let cmdLen: number | undefined;
            const firstLine = plainText.split("\n")[0];
            const m = matchCommand(COMMAND_TRIE, firstLine);
            if (m.status === "matched") cmdLen = m.cmdLen;
            return { ...el, text: plainText, html, y: snapTextLineY(el.y), cmdLen };
          });
        },
      },
      { immediate: false, changedId: elId }
    );
  }

  // ── Shared chat submission: streams AI response into a ChatEl ──

  /** Mutate a chat element in both allElementsRef and visibleElementsRef, then bump renderTick. No R-tree rebuild (position unchanged). */
  function mutateChatEl(chatElId: string, fn: (chat: ChatEl) => ChatEl) {
    if (locked) return;
    const mapper = (el: CanvasEl) => {
      if (el.id !== chatElId || el.type !== "chat") return el;
      return fn(el as ChatEl);
    };
    allElementsRef.current = allElementsRef.current.map(mapper);
    visibleElementsRef.current = visibleElementsRef.current.map(mapper);
    setRenderTick(t => t + 1);
  }

  /** Focus the textarea inside a newly spawned chat element (next frame). */
  function focusChatInput(chatElId: string) {
    requestAnimationFrame(() => {
      const root = viewportRef.current?.querySelector<HTMLElement>(`[data-el-id="${chatElId}"]`);
      const ta = root?.querySelector<HTMLTextAreaElement>("textarea");
      if (ta) ta.focus({ preventScroll: true });
    });
  }


  // Find a free spot to the right of the chat element, stacking downward to avoid overlaps
  function findSpotNearChat(chatElId: string, elW: number, elH: number): { x: number; y: number } {
    const chatEl = allElementsRef.current.find(e => e.id === chatElId) as ChatEl | undefined;
    if (!chatEl) return findFreeSpotInAiColumn(allElementsRef.current, elH, elW);

    const chatAabb = elementTightCanvasAabb(chatEl);
    if (!chatAabb) return findFreeSpotInAiColumn(allElementsRef.current, elH, elW);

    const GAP = 40;
    const anchorX = chatAabb.x + chatAabb.w + GAP;
    let candidateY = chatAabb.y;

    // Get AABBs of all other elements to check for overlaps
    const others = allElementsRef.current
      .filter(e => e.id !== chatElId)
      .map(elementTightCanvasAabb)
      .filter((b): b is CanvasAabb => b !== null);

    // Scan downward until we find a gap that fits
    for (let i = 0; i < 200; i++) {
      const slotRight = anchorX + elW;
      const slotBottom = candidateY + elH;
      const blocker = others.find(
        b => b.x < slotRight + GAP && b.x + b.w > anchorX - GAP &&
             b.y < slotBottom + GAP && b.y + b.h > candidateY - GAP
      );
      if (!blocker) break;
      candidateY = blocker.y + blocker.h + GAP;
    }

    return { x: anchorX, y: candidateY };
  }

  /** If the model supplied x/y in canvas coords (smaller y = up), use them as-is. Otherwise fall back to auto-placement. */
  function resolvePos(chatElId: string, args: Record<string, unknown>, elW: number, elH: number): { x: number; y: number } {
    if (typeof args.x === "number" && typeof args.y === "number") {
      return { x: args.x as number, y: args.y as number };
    }
    return findSpotNearChat(chatElId, elW, elH);
  }


  /** Apply a TextEventResult's side effects. Returns true if the event was consumed. */
  function applyTextResult(result: TextEventResult, el: TextEl, adapter: TiptapTextAdapter): boolean {
    if (result.kind === "default") return false;
    if (result.kind === "handled") return true;
    if (result.blur) adapter.blur();
    if (result.replaceContent) {
      adapter.replaceAll(result.replaceContent.html);
      handleCanvasTextChange(el.id, result.replaceContent.html, result.replaceContent.plainText);
    }
    if (result.op) execPlace(result.op, result.response);
    if (result.setNewElId !== undefined) newElIdRef.current = result.setNewElId;
    if (result.setFocusedId) setFocusedTextId(result.setFocusedId);
    if (result.caret) {
      const caret = result.caret;
      if (caret.on === "cmdArrow") {
        mergeCaretRef.current = null;
        const payload = { id: caret.elId, caret: caret.caret };
        cmdArrowCaretRef.current = payload;
        cmdCaretPostPaintRef.current = payload;
        requestAnimationFrame(() => {
          const targetEditor = editorMapRef.current.get(caret.elId);
          if (!targetEditor) {
            cmdArrowCaretRef.current = null;
            cmdCaretPostPaintRef.current = null;
            return;
          }
          targetEditor.commands.focus();
          flushSync(() => setCmdCaretLayoutKey((k) => k + 1));
        });
      } else {
        requestAnimationFrame(() => {
          if (caret.on === "self") {
            adapter.setSelectionRange(caret.start, caret.end);
          } else {
            const target = editorMapRef.current.get(caret.elId);
            if (target) {
              target.commands.focus();
              const pmPos = charOffsetToPmPos(target.state.doc, caret.charOffset);
              target.commands.setTextSelection(pmPos);
            }
          }
        });
      }
    }
    return true;
  }

  function handleCanvasTextKeyDown(e: KeyboardEvent, el: TextEl, adapter: TiptapTextAdapter): boolean {
    const deps: TextInteractionDeps = {
      verticalColumnRef: canvasVerticalColumnXRef,
      cmdTabRef,
    };
    const hasNote = !!stateRef.current.activeId;

    if (e.key === "Escape") {
      return applyTextResult(handleTextEscape(e, deps), el, adapter);
    }
    // Route Cmd/Ctrl+Z (and Cmd+Shift+Z) to canvas-level undo/redo while typing.
    // Otherwise Tiptap's History extension handles it, fighting with the per-
    // keystroke canvas history record. stopPropagation prevents the window-level
    // keydown listener from running undo a second time.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) handleRedoRef.current();
      else handleUndoRef.current();
      return true;
    }
    if (e.key === "Tab" && !e.altKey && !e.metaKey && !e.ctrlKey) {
      const r = handleTextTab(e, adapter, el, allElementsRef.current, hasNote, deps);
      if (r.kind !== "default") return applyTextResult(r, el, adapter);
    }
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      const r = handleTextCmdArrowLR(e, adapter, el, allElementsRef.current, hasNote);
      if (r.kind !== "default") return applyTextResult(r, el, adapter);
    }
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey &&
        (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const r = handleTextCmdArrowUD(e, adapter, el, allElementsRef.current, hasNote, deps);
      if (r.kind !== "default") return applyTextResult(r, el, adapter);
    }
    if (!e.shiftKey && !e.metaKey && !e.ctrlKey &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const r = handleTextArrow(e, adapter, el, allElementsRef.current, editorMapRef.current, hasNote, deps);
      if (r.kind !== "default") return applyTextResult(r, el, adapter);
    }

    // Remaining in-shell handlers: Enter (slash command dispatch) and Backspace (dispatches to module below).

    if (e.key === "Enter" && !e.shiftKey) {
      // ── Slash command dispatch ─────────────────────────────────────
      if (el.cmdLen != null && el.cmdLen > 0) {
        const command = el.text.slice(0, el.cmdLen).trim().toLowerCase();
        const args = el.text.slice(el.cmdLen).trim();
        const handled = dispatchSlashCommand(command, args, el, {
          readAllElements: () => allElementsRef.current,
          chatHistoriesRef,
          nextChatNumber: () => chatCounterRef.current++,
          nextGraphNumber: () => nextGraphNum(allElementsRef.current),
          flashRed: (id) => graphFlash.flash(id),
          centerOn: (x, y) => zoomCenterNormalized(x, y, scale),
          mutateChatEl,
          execPlace,
          focusChatInput,
          openNotePicker: (cx, cy) => {
            const rect = viewportRef.current?.getBoundingClientRect();
            if (!rect) return;
            const { offset: off, scale: sc } = stateRef.current;
            const screenX = rect.left + off.x + cx * sc;
            const screenY = rect.top + off.y + cy * sc;
            setNotePickerPos({ cx, cy, screenX, screenY });
            setNotePickerSearch("");
          },
          spawnPageRegionAt,
          openImagePickerAt,
          openPdfPickerAt,
        });
        if (handled) {
          e.preventDefault();
          return true;
        }
        // fall through: unknown slash command acts like plain Enter
      }

      // Not a slash command — let Tiptap handle Enter natively (new paragraph)
      canvasVerticalColumnXRef.current = null;
      return false;
    }

    if (e.key === "Backspace") {
      const result = handleTextBackspace(e, adapter, el, allElementsRef.current, !!stateRef.current.activeId);
      return applyTextResult(result, el, adapter);
    }
    return false;
  }


  function handleTextBlur(elId: string, text: string, _blurEvent?: React.FocusEvent) {
    if (!isTextBlank(text)) return;
    const tryRemove = () => {
      // Don't remove if this element just received focus again — either via
      // arrow-key spawn race (newElIdRef) or a click that refocused it
      // (caret/focus action in placeTextAtCanvas updates focusedTextIdRef).
      if (newElIdRef.current === elId) return;
      if (focusedTextIdRef.current === elId) return;
      removeEl(elId);
    };
    // Blur fires at mousedown, but the replacement (if any) isn't spawned
    // until click (mouseup). Naive rAF crosses frame boundaries while the
    // user holds the button — empty1 disappears, paint shows the empty-state
    // placeholder, then click finally spawns empty2. Defer until mouseup so
    // the click handler runs first; fall back to a timeout for keyboard /
    // programmatic blurs that never see a mouseup.
    let done = false;
    const fire = () => {
      if (done) return;
      done = true;
      document.removeEventListener("mouseup", fire);
      clearTimeout(timeoutId);
      requestAnimationFrame(tryRemove);
    };
    document.addEventListener("mouseup", fire);
    const timeoutId = setTimeout(fire, 100); // hacky fix
  }

  const placeImageBlob = (blob: Blob, atCanvas?: { x: number; y: number }) =>
    placeImageBlobLib(blob, atCanvas, {
      viewport: viewportRef.current,
      toCanvasPoint,
      getCursorClientPos: () => lastClientPos.current,
      appendEl: (el) => appendAsNewEl(el),
    });

  const placePdfBlob = (blob: Blob, filename: string) =>
    placePdfBlobLib(blob, filename, {
      toCanvasPoint,
      getCursorClientPos: () => lastClientPos.current,
      appendEl: (el) => appendAsNewEl(el),
    });

  /** Set by /image command before opening the picker; consumed by handleImageFile. */
  const pendingImagePosRef = useRef<{ x: number; y: number } | null>(null);

  function handleImageFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const at = pendingImagePosRef.current;
    pendingImagePosRef.current = null;
    placeImageBlob(file, at ?? undefined);
    e.target.value = "";
  }

  const openImagePickerAt = (cx: number, cy: number) => {
    pendingImagePosRef.current = { x: cx, y: cy };
    fileInputRef.current?.click();
  };

  function handlePdfFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    placePdfBlob(file, file.name);
    e.target.value = "";
  }

  const openPdfPickerAt = (_cx: number, _cy: number) => {
    pdfInputRef.current?.click();
  };

  finalizeSelectionMoveDragRef.current = () => {
    if (!isSelectionMoveDragging.current || !selectionMoveDragRef.current) return;
    const d = selectionMoveDragRef.current;
    const snapshots = d.snapshots;
    const originCanvas = d.originCanvas;
    const lastCanvas = d.lastCanvas;
    selectionMoveDragRef.current = null;
    isSelectionMoveDragging.current = false;
    dragDeltaRef.current = { dx: 0, dy: 0 };

    // Clear CSS transforms applied during drag before React re-renders with final positions
    const vp = viewportRef.current;
    if (vp) {
      for (const id of selectedIdsRef.current) {
        const node = vp.querySelector(`[data-el-id="${id}"]`) as HTMLElement | SVGElement | null;
        if (!node) continue;
        if (node instanceof SVGElement) {
          node.removeAttribute("transform");
        } else {
          node.style.transform = "";
        }
      }
      vp.querySelectorAll("[data-sel-rect]").forEach((n) => {
        (n as HTMLElement).style.transform = "";
      });
    }

    setSelectionMoveLive(false);
    const dx = lastCanvas.x - originCanvas.x;
    const dy = lastCanvas.y - originCanvas.y;
    suppressNextClickRef.current = true;
    if (dx === 0 && dy === 0) {
      return;
    }
    const chW = approxCharWidthCanvas();
    const aid = stateRef.current.activeId;
    if (!aid || Object.keys(snapshots).length === 0) return;
    const draggedIds = new Set(Object.keys(snapshots));
    const allDrawings = Object.values(snapshots).every(
      (el) => el.type === "draw" || el.type === "shape" || el.type === "arrow"
    );
    execPlace({
      kind: "transform",
      fn: (elements) => {
        const out: CanvasEl[] = [];
        for (const el of elements) {
          const base = snapshots[el.id];
          if (base) {
            let moved = translateCanvasElBy(base, dx, dy);
            moved = snapMovedCanvasEl(moved, chW);
            out.push(moved);
          } else {
            out.push(el);
          }
        }
        return out;
      },
      anchorIds: draggedIds,
      ...(allDrawings ? {} : { resolve: dragResolvePush() }),
    });
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full overflow-hidden" data-notes-canvas
      onScroll={(e) => { e.currentTarget.scrollLeft = 0; e.currentTarget.scrollTop = 0; }}
    >
      {/* Hidden file input for images */}
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageFile} />
      <input ref={pdfInputRef} type="file" accept="application/pdf" className="hidden" onChange={handlePdfFile} />

      {/* Canvas Area */}
      <div className="flex-1 flex flex-col overflow-hidden"
        onScroll={(e) => { e.currentTarget.scrollLeft = 0; e.currentTarget.scrollTop = 0; }}
      >
        {/* Viewport */}
        <div
          ref={viewportRef}
          className="flex-1 overflow-hidden relative select-none"
          onScroll={(e) => {
            // Browser auto-scrolls overflow:hidden containers when a focused textarea caret
            // moves outside the visible area. Reset to 0 so toolbars don't shift —
            // canvas panning (offset state) handles viewport movement instead.
            const el = e.currentTarget;
            if (el.scrollLeft !== 0 || el.scrollTop !== 0) {
              el.scrollLeft = 0;
              el.scrollTop = 0;
            }
          }}
          style={{
            cursor: toolCursor(),
            backgroundColor: "var(--th-canvas-bg)",
            ...(settings.bgDots ? {
              backgroundImage: `radial-gradient(circle, var(--th-canvas-dot) ${BG_DOT_RADIUS}px, transparent ${BG_DOT_RADIUS}px)`,
              backgroundSize: `${BG_DOT_SPACING * scale}px ${BG_DOT_SPACING * scale}px`,
              backgroundPosition: `${offset.x % (BG_DOT_SPACING * scale)}px ${offset.y % (BG_DOT_SPACING * scale)}px`,
            } : {}),
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onDoubleClick={handleDoubleClick}
          onClick={handleClick}
          onContextMenu={(e) => {
            const target = e.target as HTMLElement;

            // Table cells own their own row/col context menu — let it through.
            if (target.closest("[data-table-cell]")) return;

            // Links inside chat output (markdown anchors, citation pills) —
            // let the native menu through so "Open in new tab" / "Copy link" work.
            if (target.closest("a[href]")) return;

            // Right-click on an existing element: select it, suppress the native menu.
            // Shift + right-click toggles the element in the current multi-selection.
            // Plain right-click preserves an existing multi-selection if the clicked
            // element is part of it, otherwise replaces with just the clicked one.
            const elWrapper = target.closest<HTMLElement>("[data-el-id]");
            if (elWrapper) {
              e.preventDefault();
              const elId = elWrapper.getAttribute("data-el-id");
              if (!elId) return;
              if (e.shiftKey) {
                setSelectedIds((prev) =>
                  prev.includes(elId) ? prev.filter((id) => id !== elId) : [...prev, elId],
                );
              } else if (!selectedIdsRef.current.includes(elId)) {
                setSelectedIds([elId]);
              }
              return;
            }

            // Empty canvas: open the spawn menu.
            e.preventDefault();
            const cp = toCanvasPoint({ clientX: e.clientX, clientY: e.clientY });
            const canPasteInternal = canvasClipboardRef.current.length > 0;
            setCanvasContextMenu({
              screenX: e.clientX, screenY: e.clientY,
              canvasX: cp.x, canvasY: cp.y,
              canPaste: canPasteInternal,
            });
            // Async probe of the OS clipboard — upgrade canPaste if it holds anything usable.
            if (!canPasteInternal) {
              (async () => {
                try {
                  const items = await navigator.clipboard.read();
                  const hasContent = items.some((i) =>
                    i.types.some((t) => t.startsWith("image/") || t === "text/plain")
                  );
                  if (hasContent) {
                    setCanvasContextMenu((prev) => prev ? { ...prev, canPaste: true } : prev);
                  }
                } catch { /* permission denied */ }
              })();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setImageDragOver({ x: e.clientX, y: e.clientY });
          }}
          onDragEnter={(e) => { e.preventDefault(); dragOverCounter.current++; }}
          onDragLeave={(e) => {
            e.preventDefault();
            dragOverCounter.current--;
            if (dragOverCounter.current === 0) setImageDragOver(null);
          }}
          onDrop={(e) => {
            e.preventDefault();
            dragOverCounter.current = 0;
            setImageDragOver(null);
            lastClientPos.current = { clientX: e.clientX, clientY: e.clientY };
            const files = Array.from(e.dataTransfer.files);
            const image = files.find(f => f.type.startsWith("image/"));
            if (image) { placeImageBlob(image); return; }
            const pdf = files.find(f => f.type === "application/pdf");
            if (pdf) placePdfBlob(pdf, pdf.name);
          }}
        >
          {/* Space background with parallax */}
          {settings.bgImage !== "none" && resolvedBgImage && (() => {
            const DECAY = 670;
            const RATE = 0.05;
            // Max parallax shift in px (DECAY * RATE asymptote)
            const MAX_SHIFT = DECAY * RATE;
            // Scale image up so the parallax margin never reveals the edge
            const MARGIN = MAX_SHIFT;
            const parallax = (v: number) => Math.sign(v) * DECAY * RATE * (1 - Math.exp(-Math.abs(v) / DECAY));
            // Use scale-invariant pan so zooming doesn't shift the background.
            const vc = viewportCenter();
            const purePanX = vc.x - (vc.x - offset.x) / scale;
            const purePanY = vc.y - (vc.y - offset.y) / scale;
            const px = parallax(purePanX);
            const py = parallax(purePanY);
            const dist = Math.sqrt(purePanX * purePanX + purePanY * purePanY);
            const fade = Math.exp(-dist / 15000);
            return (
              <div
                className="absolute pointer-events-none z-0"
                style={{
                  // Oversize the div by MARGIN on each side so the image never slides out
                  top: -MARGIN,
                  left: -MARGIN,
                  right: -MARGIN,
                  bottom: -MARGIN,
                  backgroundImage: `url(${resolvedBgImage})`,
                  backgroundSize: "cover",
                  backgroundPosition: `calc(50% + ${px}px) calc(50% + ${py}px)`,
                  backgroundRepeat: "no-repeat",
                  opacity: uiToRealOpacity(settings.bgOpacity) * fade,
                  filter: [settings.bgGrayscale && "grayscale(1)", settings.bgBlur && "blur(4px)"].filter(Boolean).join(" ") || "none",
                }}
              />
            );
          })()}

          {/* Draw tool hint */}
          {activeTool === "draw" && (
            <div className="absolute inset-x-0 top-24 flex justify-center z-30 pointer-events-none animate-draw-hint">
              <span className="text-xs font-bold text-[var(--th-text-faint)] tracking-widest uppercase font-lexend">
                Hold &apos;space&apos; to draw
              </span>
            </div>
          )}
          {activeTool !== "draw" && allElementsRef.current.length > 0 && (() => {
            // "Lost": no element's AABB intersects the unbuffered viewport. Computed fresh
            // so selected/focused force-included elements don't lie about what's on screen.
            const vp = viewportRef.current;
            if (!vp) return false;
            const { offset: off, scale: sc } = transformRef.current;
            const q = {
              minX: -off.x / sc,
              minY: -off.y / sc,
              maxX: (vp.clientWidth - off.x) / sc,
              maxY: (vp.clientHeight - off.y) / sc,
            };
            for (const tree of Object.values(spatialRef.current)) {
              if (tree.search(q).length > 0) return false;
            }
            return true;
          })() && (
            <div className="absolute inset-x-0 top-24 flex justify-center z-30 pointer-events-none animate-draw-hint">
              <span className="text-xs font-bold text-[var(--th-text-faint)] tracking-widest uppercase font-lexend">
                If you&apos;re lost, press on the zoom number twice
              </span>
            </div>
          )}

          {/* Image drag-and-drop outline preview */}
          {imageDragOver && viewportRef.current && (() => {
            const rect = viewportRef.current!.getBoundingClientRect();
            const w = Math.round(rect.width / 3);
            const h = Math.round(w * 0.75);
            const left = imageDragOver.x - rect.left - w / 2;
            const top = imageDragOver.y - rect.top - h / 2;
            return (
              <div
                className="absolute z-40 pointer-events-none rounded-lg border-2 border-dashed border-[var(--th-accent)] bg-[var(--th-accent)]/10"
                style={{ left, top, width: w, height: h }}
              />
            );
          })()}

          <div className="absolute top-4 right-6 z-20 flex items-center gap-3">
            {onToggleLock && (
              <button
                onClick={handleToggleLock}
                className={`h-8 w-8 rounded-full flex items-center justify-center transition-colors text-[11px] ${
                  locked
                    ? "bg-[#3a2a1a] text-amber-400 hover:bg-[#4a3a2a]"
                    : "bg-[var(--th-surface-raised)] text-[var(--th-text-secondary)] hover:bg-[var(--th-surface-hover)]"
                }`}
                title={locked ? "Unlock editing" : "Lock editing"}
              >
                <span className="material-symbols-outlined text-[16px]">
                  {locked ? "lock" : "lock_open"}
                </span>
              </button>
            )}
            <div className="flex items-center bg-[var(--th-surface-raised)] rounded-full px-3 py-1 gap-3">
              <button onClick={() => zoomByDiscrete(-1)} className="text-[var(--th-text-secondary)] active:scale-95 transition-transform">
                <span className="material-symbols-outlined text-lg">zoom_out</span>
              </button>
              <button onClick={() => zoomCenterNormalized()} className="text-[11px] font-bold text-[var(--th-text-secondary)] w-9 text-center font-lexend hover:text-[var(--th-text-secondary)] transition-colors" title="Reset zoom">{zoomPct}%</button>
              <button onClick={() => zoomByDiscrete(1)} className="text-[var(--th-text-secondary)] active:scale-95 transition-transform">
                <span className="material-symbols-outlined text-lg">zoom_in</span>
              </button>
            </div>
          </div>

          {!locked && (
            <ToolPickerToolbar
              activeTool={activeTool}
              isCanvasTyping={isCanvasTyping}
              shapeSubTool={shapeSubTool}
              selectTool={selectTool}
              setShapeSubTool={setShapeSubTool}
              setActiveTool={setActiveTool}
            />
          )}

          {marquee.preview && (
            <div
              className="absolute z-[12] pointer-events-none rounded-sm border border-dashed border-[var(--th-selection-border)] bg-[var(--th-selection-bg)]"
              style={{ left: marquee.preview.left, top: marquee.preview.top, width: marquee.preview.w, height: marquee.preview.h }}
            />
          )}

          {selectedPageRegionId && (() => {
            const pr = (activeNote?.pageRegions ?? []).find(r => r.id === selectedPageRegionId);
            if (!pr) return null;
            return (
              <PageRegionToolbar
                pageRegion={pr}
                offset={offset}
                scale={scale}
                onMutate={commitPageRegions}
                onPrint={(region) => {
                  const world = canvasWorldRef.current;
                  if (!world) return;
                  const prevSelected = selectedPageRegionId;
                  printPageRegionLib(region, {
                    world,
                    noteTitle: activeNote?.title,
                    hideSelection: () => setSelectedPageRegionId(null),
                    restoreSelection: () => setSelectedPageRegionId(prevSelected),
                  });
                }}
                onDeselect={() => setSelectedPageRegionId(null)}
              />
            );
          })()}

          {selectionToolbarScreenPos && selectedIds.length >= 1 && !cropEditingId && (
            <AlignmentToolbar
              screenPos={selectionToolbarScreenPos}
              selectedIds={selectedIds}
              allElements={allElementsRef.current}
              execPlace={execPlace}
              onStartCrop={(id) => setCropEditingId(id)}
            />
          )}

          {/* Per-chat toolbar — appears when exactly one chat is selected.
              Visual treatment matches PageRegionToolbar so per-element toolbars
              feel of-a-piece. AlignmentToolbar self-hides for a single chat
              (no align/z/ghost/crop/revert), so the two don't fight for space. */}
          {selectionToolbarScreenPos && selectedIds.length === 1 && !cropEditingId && (() => {
            const sel = allElementsRef.current.find(
              (el): el is ChatEl => el.id === selectedIds[0] && el.type === "chat",
            );
            if (!sel) return null;
            return (
              <ChatToolbar
                chatEl={sel}
                screenPos={selectionToolbarScreenPos}
                onToggleDim={(id) => {
                  const cur = allElementsRef.current.find(
                    (el): el is ChatEl => el.id === id && el.type === "chat",
                  );
                  if (!cur) return;
                  execPlace({
                    kind: "mutate",
                    id,
                    changes: { dimmed: cur.dimmed ? undefined : true } as Partial<ChatEl>,
                  });
                }}
              />
            );
          })()}

          {selectedImage && (
            <ImageResizeOverlay
              selectedImage={selectedImage}
              editorMapRef={editorMapRef}
              locked={locked}
            />
          )}

          {inlineToolbarPos && focusedTextId && !selectedImage && (
            <InlineTextToolbar
              pos={inlineToolbarPos}
              focusedTextId={focusedTextId}
              editorMapRef={editorMapRef}
            />
          )}

          {textMarqueeToolbarPos && textMarqueeSelectedIds.size > 0 && (
            <TextMarqueeToolbar
              pos={textMarqueeToolbarPos}
              editorIds={expandTextMarqueeToEditorIds(textMarqueeSelectedIds)}
              editorMapRef={editorMapRef}
            />
          )}

          {/* Empty state */}
          {(!activeNote || (allElementsRef.current.length === 0)) && (
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[var(--th-text-hint)] text-sm font-lexend pointer-events-none select-none text-center flex flex-col items-center gap-1">
              <p className="flex items-center justify-center gap-1.5 m-0">
                <span className="inline-block w-px h-[1.15em] shrink-0 bg-[var(--th-text-faint)] animate-caret-blink" aria-hidden />
                <span>Click to type</span>
              </p>
              <p className="m-0">or pick a tool above</p>
            </div>
          )}

          {/* Canvas World */}
          <div ref={canvasWorldRef} style={{ position: "absolute", top: 0, left: 0, transformOrigin: "0 0", transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}>
            {/* Page regions — printable capture frames in canvas space */}
            <PageRegionLayer
              regions={activeNote?.pageRegions ?? []}
              canvasScale={scale}
              locked={locked}
              selectedPageRegionId={selectedPageRegionId}
              onSelectRegion={(id) => setSelectedPageRegionId(id)}
              onStartMarginDrag={(init) => { pageMarginDragRef.current = init; }}
              onStartRegionDrag={(id, e, pr) => {
                pageRegionDragRef.current = { id, originClient: { x: e.clientX, y: e.clientY }, originPr: { x: pr.x, y: pr.y } };
              }}
            />

            {/* SVG layer for draw paths, shape previews, arrow previews */}
            <svg style={{ position: "absolute", left: 0, top: 0, width: 1, height: 1, overflow: "visible", pointerEvents: "none" }}>
              <defs>
                <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                  <polygon points="0 0, 8 3, 0 6" fill="var(--th-stroke)" />
                </marker>
              </defs>

              <ArrowLayer
                elements={visibleElements.filter((el): el is ArrowEl => el.type === "arrow")}
                canvasScale={scale}
                activeTool={activeTool}
                locked={locked}
                selectedIds={selectedIds}
                isEndpointBeingDragged={(arrowId) => arrowTipDrag.current?.arrowId === arrowId}
                onTipMouseDown={(el, endpoint, cx, cy) => {
                  arrowTipDrag.current = { arrowId: el.id, endpoint, cx, cy };
                  if (viewportRef.current) viewportRef.current.style.cursor = "grabbing";
                }}
              />


              {/* Live draw preview */}
              {drawPreview && <polyline points={drawPreview} fill="none" stroke="var(--th-stroke-strong)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}

              {/* Live shape preview */}
              {shapePreview && (
                shapeSubTool === "circle" ? (
                  <ellipse cx={shapePreview.x + shapePreview.w / 2} cy={shapePreview.y + shapePreview.h / 2}
                    rx={shapePreview.w / 2} ry={shapePreview.h / 2}
                    fill="none" stroke="var(--th-stroke-faint)" strokeWidth="1.5" strokeDasharray="6 3" />
                ) : shapeSubTool === "triangle" ? (
                  <polygon
                    points={`${shapePreview.x + shapePreview.w / 2},${shapePreview.y} ${shapePreview.x},${shapePreview.y + shapePreview.h} ${shapePreview.x + shapePreview.w},${shapePreview.y + shapePreview.h}`}
                    fill="none" stroke="var(--th-stroke-faint)" strokeWidth="1.5" strokeDasharray="6 3" />
                ) : (
                  <rect x={shapePreview.x} y={shapePreview.y} width={shapePreview.w} height={shapePreview.h}
                    fill="none" stroke="var(--th-stroke-faint)" strokeWidth="1.5" strokeDasharray="6 3" />
                )
              )}

              {/* Live arrow preview */}
              {arrowPreview && (
                <line x1={arrowPreview.x1} y1={arrowPreview.y1} x2={arrowPreview.x2} y2={arrowPreview.y2}
                  stroke="var(--th-stroke-dim)" strokeWidth="2" strokeDasharray="6 3" markerEnd="url(#arrowhead)" />
              )}
            </svg>

            {/* Committed drawings — each as its own absolutely-positioned SVG
                so z-index can interleave with shapes/images. */}
            {visibleElements.filter((el): el is DrawEl => el.type === "draw").map((el) => (
              <SingleDraw key={el.id} el={el} />
            ))}

            {/* Committed shapes */}
            {visibleElements.filter((el): el is ShapeEl => el.type === "shape").slice().sort((a, b) => (a.z ?? 0) - (b.z ?? 0)).map((el) => (
              <CanvasElement
                key={el.id}
                el={el}
                canvasScale={scale}
                activeTool={activeTool}
                locked={locked}
                selected={selectedIds.includes(el.id)}
                dispatch={(op, opts) => execPlace(op, opts)}
                shapeExtras={{
                  onCornerMouseDown: (corner, shapeEl) => {
                    shapeResizeDrag.current = { shapeId: shapeEl.id, corner, x: shapeEl.x, y: shapeEl.y, w: shapeEl.w, h: shapeEl.h };
                    const cursor = corner === "tl" || corner === "br" ? "nwse-resize" : "nesw-resize";
                    if (viewportRef.current) viewportRef.current.style.cursor = cursor;
                  },
                  isBeingResized: shapeResizeDrag.current?.shapeId === el.id,
                }}
              />
            ))}

            {/* Images */}
            {visibleElements.filter((el): el is ImageEl => el.type === "image").slice().sort((a, b) => (a.z ?? 0) - (b.z ?? 0)).map((el) => (
              <CanvasElement
                key={el.id}
                el={el}
                canvasScale={scale}
                activeTool={activeTool}
                locked={locked}
                selected={selectedIds.includes(el.id)}
                dispatch={(op, opts) => execPlace(op, opts)}
                imageExtras={{
                  onResizeHandleMouseDown: (imgEl, corner, e) => {
                    imageResizeDrag.current = {
                      imageId: imgEl.id,
                      corner,
                      origX: imgEl.x,
                      origY: imgEl.y,
                      origW: imgEl.w,
                      origH: imgEl.h,
                      startScreenX: e.clientX,
                      startScreenY: e.clientY,
                      x: imgEl.x,
                      y: imgEl.y,
                      w: imgEl.w,
                      h: imgEl.h,
                    };
                    const cursor = corner === "tl" || corner === "br" ? "nwse-resize" : "nesw-resize";
                    if (viewportRef.current) viewportRef.current.style.cursor = cursor;
                  },
                  isBeingResized: imageResizeDrag.current?.imageId === el.id,
                  isBeingCropped: cropEditingId === el.id,
                  onEnterMover: () => flushSync(() => { setActiveTool("mover"); }),
                }}
              />
            ))}
            {cropEditingId && (() => {
              const cropEl = allElementsRef.current.find((e): e is ImageEl => e.id === cropEditingId && e.type === "image");
              if (!cropEl) return null;
              return (
                <CropOverlay
                  el={cropEl}
                  canvasScale={scale}
                  toCanvasPoint={toCanvasPoint}
                  execPlace={execPlace}
                  onClose={() => setCropEditingId(null)}
                />
              );
            })()}

            {/* Canvas text at stored x,y (no visible box); Y aligned to line grid */}
            {(() => {
              const allText = visibleElements.filter((el): el is TextEl => el.type === "text") ?? [];

              return (
                <>
                  {/* Chat elements */}
                  {visibleElements.filter((el): el is ChatEl => el.type === "chat").map((el) => (
                    <ChatContainer
                      key={el.id}
                      chatEl={el}
                      activeTool={activeTool}
                      locked={locked}
                      selectionMoveLive={selectionMoveLive}
                      canvasScale={scale}
                      // Stage 6: the container owns its streaming lifecycle via useChatStream.
                      // Shell exposes the deps the hook needs (read-only state + dispatch + per-command helpers).
                      streamDeps={{
                        dispatch: (op, opts) => execPlace(op, opts),
                        chatMutate: mutateChatEl,
                        buildContext: (chatEl) => {
                          const visibleEls = visibleElementsRef.current.filter(e => e.id !== chatEl.id);
                          return serializeElements(visibleEls, chatEl);
                        },
                        buildSidebarNotes: () => {
                          try {
                            const allNotes: NoteItem[] = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
                            return allNotes
                              .filter(n => n.id !== noteProp?.id)
                              .map(n => ({ id: n.id, title: n.title || "Untitled" }));
                          } catch { return []; }
                        },
                        getCurrentNoteTitle: () => noteProp?.title || null,
                        chatHistoriesRef,
                        lastSentVisibleRef,
                        readAllElements: () => allElementsRef.current,
                        resolvePos: (chatElId, args, w, h) => resolvePos(chatElId, args, w, h),
                        toolCallbacks: {
                          rasterizeShapes: async () => {
                            const shapeArrowEls = allElementsRef.current.filter(
                              (e): e is ShapeEl | ArrowEl => e.type === "shape" || e.type === "arrow"
                            );
                            const { images, descriptions } = rasterizeShapeGroups(shapeArrowEls);
                            return {
                              groups: images.map((img, i) => ({
                                image: img.data,
                                description: descriptions[i] ?? "",
                              })),
                            };
                          },
                          readPdfPage: async (filename, page) => {
                            const pdfEl = allElementsRef.current.find(
                              (e): e is PdfEl => e.type === "pdf" && e.filename === filename
                            );
                            if (!pdfEl) return { error: `PDF "${filename}" not found on canvas.` };
                            if (page < 1 || page > pdfEl.numPages) {
                              return { error: `Page ${page} out of range (1-${pdfEl.numPages}).` };
                            }
                            try {
                              const pdfjsLib = await import("pdfjs-dist");
                              if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
                                pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
                                  "pdfjs-dist/build/pdf.worker.min.mjs",
                                  import.meta.url,
                                ).toString();
                              }
                              const raw = atob(pdfEl.src.split(",")[1]);
                              const arr = new Uint8Array(raw.length);
                              for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
                              const doc = await pdfjsLib.getDocument({ data: arr }).promise;
                              const pg = await doc.getPage(page);
                              const viewport = pg.getViewport({ scale: 2 });
                              const c = document.createElement("canvas");
                              c.width = viewport.width;
                              c.height = viewport.height;
                              const ctx = c.getContext("2d")!;
                              await pg.render({ canvas: c, canvasContext: ctx, viewport }).promise;
                              const base64 = c.toDataURL("image/png").split(",")[1];
                              return { image: base64 };
                            } catch (e) {
                              return { error: `Failed to render page: ${e instanceof Error ? e.message : String(e)}` };
                            }
                          },
                          readNote: async (noteId) => {
                            try {
                              const allNotes: NoteItem[] = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
                              const target = allNotes.find(n => n.id === noteId);
                              if (!target) return `Note with id="${noteId}" not found.`;
                              const { text } = serializeElements(target.elements ?? []);
                              return `Title: ${target.title || "Untitled"}\n${text}`;
                            } catch (e) {
                              return `Error reading note: ${e instanceof Error ? e.message : String(e)}`;
                            }
                          },
                          readCurrentNote: async () => {
                            try {
                              const els = allElementsRef.current;
                              const { text } = serializeElements(els);
                              return `Title: ${noteProp?.title || "Untitled"}\n${text}`;
                            } catch (e) {
                              return `Error reading current note: ${e instanceof Error ? e.message : String(e)}`;
                            }
                          },
                          readChat: async (chatNumber, offset, count) => {
                            try {
                              const target = allElementsRef.current.find(
                                e => e.type === "chat" && (e as ChatEl).chatNumber === chatNumber && !(e as ChatEl).ephemeral,
                              ) as ChatEl | undefined;
                              if (!target) return `Chat #${chatNumber} not found.`;
                              const msgs = target.messages.filter(m => m.content && m.content !== "…");
                              const total = msgs.length;
                              const start = Math.max(0, Math.floor(offset));
                              const slice = msgs.slice(start, start + count);
                              if (slice.length === 0) {
                                return `Chat #${chatNumber} has ${total} messages; offset ${start} is past the end.`;
                              }
                              const end = start + slice.length;
                              const more = end < total
                                ? `More messages available — call read_chat with offset=${end} to continue.`
                                : "End of chat.";
                              const body = slice.map((m, i) => `[${start + i}] ${m.role}: ${m.content}`).join("\n\n");
                              return `Chat #${chatNumber}, messages ${start}–${end - 1} of ${total}:\n\n${body}\n\n${more}`;
                            } catch (e) {
                              return `Error reading chat: ${e instanceof Error ? e.message : String(e)}`;
                            }
                          },
                        },
                        onStreamComplete: () => persistFromRef(true),
                      }}
                      onInputChange={(id, text) => {
                        mutateChatEl(id, (chat) => ({ ...chat, inputText: text }));
                      }}
                      onInputFocus={() => {
                        // Focusing the chat input dismisses any lingering
                        // selection so the bounding-box outline doesn't sit on
                        // top of the chat the user is about to edit.
                        if (selectedIdsRef.current.length > 0) setSelectedIds([]);
                      }}
                      onMeasuredHeight={(id, h) => {
                        const existing = allElementsRef.current.find(e => e.id === id);
                        if (existing && existing.type === "chat" && (existing as any).measuredH === h) return;
                        execPlace({
                          kind: "mutate",
                          id,
                          changes: { measuredH: h },
                          resolve: dragResolvePush(),
                        }, { skipHistory: true });
                      }}
                      onResize={(id, w, h) => {
                        execPlace({
                          kind: "mutate",
                          id,
                          changes: { w, h },
                          resolve: dragResolvePush(),
                        });
                      }}
                      onResizeLive={(id, w, h) => {
                        const vp = viewportRef.current;
                        if (!vp) return;
                        const nodes = vp.querySelectorAll<HTMLElement>(`[data-sel-for="${id}"]`);
                        nodes.forEach(node => {
                          node.style.width = `${w}px`;
                          node.style.height = `${h}px`;
                        });
                        // Drag bypasses React, so the per-chat toolbar position
                        // (derived from the AABB) is also stale until release.
                        // Recompute its center directly off the new width so it
                        // tracks the right edge as the user drags it. Top is
                        // anchored at el.y and doesn't change during resize.
                        const tb = vp.querySelector<HTMLElement>(`[data-chat-toolbar-for="${id}"]`);
                        if (tb) {
                          const chatEl = allElementsRef.current.find(
                            (e): e is ChatEl => e.id === id && e.type === "chat",
                          );
                          if (chatEl) {
                            const cxCanvas = chatEl.x - CHAT_INDICATOR_MARGIN + w / 2;
                            tb.style.left = `${offset.x + cxCanvas * scale}px`;
                          }
                        }
                      }}
                    />
                  ))}

                  {/* Text elements */}
                  {allText.map((el) => (
                    <CanvasElement
                      key={el.id}
                      el={el}
                      canvasScale={scale}
                      activeTool={activeTool}
                      locked={locked}
                      selected={selectedIds.includes(el.id)}
                      dispatch={(op, opts) => execPlace(op, opts)}
                      onMeasure={(id, w, h) => {
                        const target = allElementsRef.current.find(e => e.id === id) as TextEl | undefined;
                        if (!target) return;
                        if (w > 0 && h > 0 && (Math.abs((target.measuredW ?? 0) - w) > 1 || Math.abs((target.measuredH ?? 0) - h) > 1)) {
                          const grewW = w > (target.measuredW ?? 0);
                          const grewH = h > (target.measuredH ?? 0);
                          const resolve = grewH
                            ? verticalEnterPush()
                            : grewW
                              ? horizontalTextPush(1)
                              : undefined;
                          execPlace({
                            kind: "mutate", id,
                            changes: { measuredW: w, measuredH: h },
                            resolve,
                          }, { skipHistory: true });
                        }
                      }}
                      textExtras={{
                        selectionMoveLive,
                        textMarqueeSelected: textMarqueeSelectedIds.has(el.id),
                        flashRed: graphFlash.has(el.id),
                        onChange: (id, html, plainText) => handleCanvasTextChange(id, html, plainText),
                        onBlur: (id, plainText) => {
                          canvasVerticalColumnXRef.current = null;
                          setFocusedTextId(null);
                          handleTextBlur(id, plainText);
                        },
                        onFocus: (id) => {
                          if (!locked && activeTool !== "mover") setActiveTool("text");
                          setFocusedTextId(id);
                          if (textMarqueeSelectedIdsRef.current.size > 0) setTextMarqueeSelectedIds(new Set());
                        },
                        onKeyDown: (e, textEl, adapter) => handleCanvasTextKeyDown(e, textEl, adapter),
                        editorMapRef,
                      }}
                    />
                  ))}
                </>
              );
            })()}


            {/* Charts */}
            {visibleElements.filter((el): el is ChartEl => el.type === "chart").map((el) => (
              <CanvasElement
                key={el.id}
                el={el}
                canvasScale={scale}
                activeTool={activeTool}
                locked={locked}
                selected={selectedIds.includes(el.id)}
                dispatch={(op, opts) => execPlace(op, opts)}
              />
            ))}

            {/* Graphs + metadata label */}
            {visibleElements.filter((el): el is GraphEl => el.type === "graph").map((el) => (
              <GraphContainer
                key={el.id}
                graphEl={el}
                canvasScale={scale}
                locked={locked}
                onResize={(id: string, changes: Partial<GraphEl>) => {
                  execPlace({ kind: "mutate", id, changes });
                }}
              />
            ))}

            {/* PDF documents */}
            {visibleElements.filter((el): el is PdfEl => el.type === "pdf").map((el) => (
              <PdfContainer
                key={el.id}
                pdfEl={el}
                canvasScale={scale}
                activeTool={activeTool}
                locked={locked}
                onResize={(id: string, changes: Partial<PdfEl>) => {
                  execPlace({ kind: "mutate", id, changes });
                }}
              />
            ))}

            {/* Embedded documents */}
            {visibleElements.filter((el): el is EmbedEl => el.type === "embed").map((el) => (
              <EmbedContainer
                key={el.id}
                embedEl={el}
                canvasScale={scale}
                locked={locked}
                onResize={(id: string, changes: Partial<EmbedEl>) => {
                  execPlace({ kind: "mutate", id, changes });
                }}
              />
            ))}

            {/* Tables */}
            {visibleElements.filter((el): el is TableEl => el.type === "table").map((el) => (
              <TableContainer
                key={el.id}
                tableEl={el}
                canvasScale={scale}
                activeTool={activeTool}
                locked={locked}
                textMarqueeSelected={textMarqueeSelectedIds.has(el.id)}
                onResize={stableTableProps.onResize}
                onCellChange={stableTableProps.onCellChange}
                onCellBlur={stableTableProps.onCellBlur}
                onCellFocus={stableTableProps.onCellFocus}
                onCellMeasure={stableTableProps.onCellMeasure}
                onCellKeyDown={stableTableProps.onCellKeyDown}
                onCellContextMenu={stableTableProps.onCellContextMenu}
                registerCellEditor={stableTableProps.registerCellEditor}
                despawning={despawningTableIdsRef.current.has(el.id)}
                onDespawned={handleTableDespawned}
              />
            ))}

            {/* Checklists */}
            {visibleElements.filter((el): el is ChecklistEl => el.type === "checklist").map((el) => (
              <ChecklistContainer
                key={el.id}
                checklistEl={el}
                canvasScale={scale}
                activeTool={activeTool}
                locked={locked}
                textMarqueeSelected={textMarqueeSelectedIds.has(el.id)}
                onResize={stableChecklistProps.onResize}
                onItemChange={stableChecklistProps.onItemChange}
                onItemBlur={stableChecklistProps.onItemBlur}
                onItemFocus={stableChecklistProps.onItemFocus}
                onItemMeasure={stableChecklistProps.onItemMeasure}
                onItemKeyDown={stableChecklistProps.onItemKeyDown}
                onItemContextMenu={stableChecklistProps.onItemContextMenu}
                onItemToggle={stableChecklistProps.onItemToggle}
                onItemInsert={stableChecklistProps.onItemInsert}
                registerItemEditor={stableChecklistProps.registerItemEditor}
                despawning={despawningChecklistIdsRef.current.has(el.id)}
                onDespawned={handleChecklistDespawned}
              />
            ))}

            {/* Math formulas */}
            {visibleElements.filter((el): el is MathEl => el.type === "math").map((el) => (
              <CanvasElement
                key={el.id}
                el={el}
                canvasScale={scale}
                activeTool={activeTool}
                locked={locked}
                selected={selectedIds.includes(el.id)}
                dispatch={(op, opts) => execPlace(op, opts)}
                onMeasure={(id, w, h) => {
                  const target = allElementsRef.current.find(e => e.id === id) as MathEl | undefined;
                  if (!target) return;
                  if (w > 0 && h > 0 && (Math.abs((target.measuredW ?? 0) - w) > 1 || Math.abs((target.measuredH ?? 0) - h) > 1)) {
                    execPlace({ kind: "mutate", id, changes: { measuredW: w, measuredH: h }, resolve: verticalEnterPush() }, { skipHistory: true });
                  }
                }}
                mathExtras={{
                  onConvertToText: (mathEl) => {
                    const text = `/math ${mathEl.latex}`;
                    const { op, id } = spawnText(mathEl.x, mathEl.y, text);
                    const spawned = op.kind === "spawn" ? op.element : null;
                    if (!spawned || spawned.type !== "text") return;
                    const m = matchCommand(COMMAND_TRIE, text.split("\n")[0]);
                    if (m.status === "matched") (spawned as TextEl).cmdLen = m.cmdLen;
                    execPlace({
                      kind: "transform",
                      fn: (els) => [...els.filter(e => e.id !== mathEl.id), spawned],
                      anchorIds: new Set([id]),
                    });
                    flushSync(() => {
                      setActiveTool("text");
                      setFocusedTextId(id);
                    });
                    newElIdRef.current = id;
                    requestAnimationFrame(() => {
                      const ed = editorMapRef.current.get(id);
                      if (ed) {
                        ed.commands.focus(null, { scrollIntoView: false });
                        const pmPos = charOffsetToPmPos(ed.state.doc, text.length);
                        ed.commands.setTextSelection(pmPos);
                      }
                    });
                  },
                }}
              />
            ))}

            {/* Note references */}
            {visibleElements.filter((el): el is NoteRefEl => el.type === "noteRef").map((el) => (
              <CanvasElement
                key={el.id}
                el={el}
                canvasScale={scale}
                activeTool={activeTool}
                locked={locked}
                selected={selectedIds.includes(el.id)}
                dispatch={(op, opts) => execPlace(op, opts)}
              />
            ))}

            {selectionUnionRects.map((r, i) => (
              <div
                key={`sel-${i}`}
                data-sel-rect
                data-sel-for={r.elId}
                style={{
                  position: "absolute",
                  left: r.x,
                  top: r.y,
                  width: r.w,
                  height: r.h,
                  boxSizing: "border-box",
                  border: "2px solid var(--th-selection-border)",
                  borderRadius: 3,
                  pointerEvents: "none",
                  // Sits above the ghosted-image lift (100000 in ImageContainer)
                  // so the outline can never be buried by a selected element.
                  zIndex: 100001,
                }}
              />
            ))}
          </div>

          {/* Note picker popup */}
          {notePickerPos && (() => {
            let allNotes: NoteItem[] = [];
            try { allNotes = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"); } catch { /* ignore */ }
            // Exclude the current note from the list
            const currentId = stateRef.current.activeId;
            const filtered = allNotes
              .filter((n) => n.id !== currentId)
              .filter((n) => !notePickerSearch || n.title.toLowerCase().includes(notePickerSearch.toLowerCase()));
            return (
                <div
                  ref={notePickerRef}
                  data-overlay-panel
                  className="fixed rounded-lg overflow-hidden shadow-2xl z-50"
                  style={{
                    left: notePickerPos.screenX,
                    top: notePickerPos.screenY,
                    width: 260,
                    maxHeight: 320,
                    background: "var(--th-surface-overlay, #1e1e2e)",
                    border: "1px solid var(--th-border-30, #333)",
                    backdropFilter: "blur(12px)",
                    WebkitBackdropFilter: "blur(12px)",
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  {/* Search input */}
                  <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--th-border-20, #2a2a3a)" }}>
                    <input
                      autoFocus
                      type="text"
                      placeholder="Search notes..."
                      value={notePickerSearch}
                      onChange={(e) => setNotePickerSearch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setNotePickerPos(null);
                        if (e.key === "Enter" && filtered.length > 0) {
                          const target = filtered[0];
                          const { op } = spawnNoteRef(notePickerPos.cx, notePickerPos.cy, target.id);
                          execPlace(op);
                          setNotePickerPos(null);
                        }
                      }}
                      className="w-full bg-transparent border-none outline-none font-lexend text-xs text-[var(--th-text)] placeholder:text-[var(--th-text-faint)]"
                    />
                  </div>
                  {/* Note list */}
                  <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
                    {filtered.length === 0 && (
                      <div className="px-3 py-4 text-center font-lexend text-xs text-[var(--th-text-faint)]">
                        No other notes found
                      </div>
                    )}
                    {filtered.map((n) => (
                      <button
                        key={n.id}
                        className="w-full px-3 py-2 text-left flex items-center gap-2 hover:bg-[var(--th-surface-hover)] transition-colors"
                        onClick={() => {
                          const { op } = spawnNoteRef(notePickerPos.cx, notePickerPos.cy, n.id);
                          execPlace(op);
                          setNotePickerPos(null);
                        }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 16, color: "var(--th-text-dim, #888)", flexShrink: 0 }}>description</span>
                        <span
                          className="font-lexend text-xs text-[var(--th-text)]"
                          style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        >
                          {n.title || "Untitled"}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
            );
          })()}

          {/* Table context menu */}
          {tableContextMenu && (() => {
            const menu = tableContextMenu;
            const items: { label: string; icon: string; onClick: () => void; danger?: boolean }[] = [
              { label: "Insert row above", icon: "vertical_align_top", onClick: () => tableOps.insertRow(tableOpsDeps, menu.tableId, menu.row) },
              { label: "Insert row below", icon: "vertical_align_bottom", onClick: () => tableOps.insertRow(tableOpsDeps, menu.tableId, menu.row + 1) },
              { label: "Insert column left", icon: "arrow_back", onClick: () => tableOps.insertCol(tableOpsDeps, menu.tableId, menu.col) },
              { label: "Insert column right", icon: "arrow_forward", onClick: () => tableOps.insertCol(tableOpsDeps, menu.tableId, menu.col + 1) },
              { label: "Delete row", icon: "delete", onClick: () => tableOps.removeRow(tableOpsDeps, menu.tableId, menu.row), danger: true },
              { label: "Delete column", icon: "delete_sweep", onClick: () => tableOps.removeCol(tableOpsDeps, menu.tableId, menu.col), danger: true },
            ];
            return (
              <>
                <div
                  onMouseDown={() => setTableContextMenu(null)}
                  style={{ position: "fixed", inset: 0, zIndex: 999 }}
                />
                <div
                  onMouseDown={(e) => e.stopPropagation()}
                  style={{
                    position: "fixed",
                    left: menu.left,
                    top: menu.top,
                    zIndex: 1000,
                    minWidth: 200,
                    background: "var(--th-surface)",
                    border: "1px solid var(--th-border-30)",
                    borderRadius: 6,
                    boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                    padding: "4px 0",
                  }}
                >
                  {items.map((it, i) => (
                    <button
                      key={i}
                      onClick={() => { it.onClick(); setTableContextMenu(null); }}
                      className="font-lexend"
                      style={{
                        width: "100%",
                        padding: "6px 12px",
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        fontSize: 12,
                        color: it.danger ? "var(--th-danger, #e55)" : "var(--th-text)",
                        background: "transparent",
                        border: "none",
                        textAlign: "left",
                        cursor: "pointer",
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--th-surface-hover)"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>{it.icon}</span>
                      <span>{it.label}</span>
                    </button>
                  ))}
                </div>
              </>
            );
          })()}

          {/* Checklist context menu */}
          {checklistContextMenu && (() => {
            const menu = checklistContextMenu;
            const items: { label: string; icon: string; onClick: () => void; danger?: boolean }[] = [
              { label: "Add task above", icon: "vertical_align_top", onClick: () => checklistOps.insertItem(checklistOpsDeps, menu.checklistId, menu.index) },
              { label: "Add task below", icon: "vertical_align_bottom", onClick: () => checklistOps.insertItem(checklistOpsDeps, menu.checklistId, menu.index + 1) },
              { label: "Delete task", icon: "delete", onClick: () => checklistOps.removeItem(checklistOpsDeps, menu.checklistId, menu.index), danger: true },
            ];
            return (
              <>
                <div
                  onMouseDown={() => setChecklistContextMenu(null)}
                  style={{ position: "fixed", inset: 0, zIndex: 999 }}
                />
                <div
                  onMouseDown={(e) => e.stopPropagation()}
                  style={{
                    position: "fixed",
                    left: menu.left,
                    top: menu.top,
                    zIndex: 1000,
                    minWidth: 180,
                    background: "var(--th-surface)",
                    border: "1px solid var(--th-border-30)",
                    borderRadius: 6,
                    boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                    padding: "4px 0",
                  }}
                >
                  {items.map((it, i) => (
                    <button
                      key={i}
                      onClick={() => { it.onClick(); setChecklistContextMenu(null); }}
                      className="font-lexend"
                      style={{
                        width: "100%",
                        padding: "6px 12px",
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        fontSize: 12,
                        color: it.danger ? "var(--th-danger, #e55)" : "var(--th-text)",
                        background: "transparent",
                        border: "none",
                        textAlign: "left",
                        cursor: "pointer",
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--th-surface-hover)"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>{it.icon}</span>
                      <span>{it.label}</span>
                    </button>
                  ))}
                </div>
              </>
            );
          })()}

          {canvasContextMenu && (() => {
            const menu = canvasContextMenu;
            const close = () => setCanvasContextMenu(null);

            const doPaste = async () => {
              // Staleness: if OS clipboard was overwritten by some other app, drop internal.
              if (canvasClipboardRef.current.length > 0 && lastCanvasCopyTextRef.current !== null) {
                try {
                  const osText = await navigator.clipboard.readText();
                  if (osText !== lastCanvasCopyTextRef.current) {
                    canvasClipboardRef.current = [];
                    lastCanvasCopyTextRef.current = null;
                  }
                } catch { /* ignore */ }
              }
              const clip = canvasClipboardRef.current;
              if (clip.length > 0) {
                if (!stateRef.current.activeId) return;
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (const el of clip) {
                  const a = elementTightCanvasAabb(el);
                  if (!a) continue;
                  minX = Math.min(minX, a.x); minY = Math.min(minY, a.y);
                  maxX = Math.max(maxX, a.x + a.w); maxY = Math.max(maxY, a.y + a.h);
                }
                const dx = menu.canvasX - (minX + maxX) / 2;
                const dy = menu.canvasY - (minY + maxY) / 2;
                const newEls = clip.map((el) => ({ ...translateCanvasElBy(el, dx, dy), id: crypto.randomUUID() }));
                const existingIds = new Set(allElementsRef.current.map((el) => el.id));
                execPlace({
                  kind: "transform",
                  fn: (els) => [...els, ...newEls],
                  anchorIds: existingIds,
                  resolve: dragResolvePush(),
                });
                setSelectedIds(newEls.map((el) => el.id));
                return;
              }
              // OS clipboard fallback
              try {
                const items = await navigator.clipboard.read();
                for (const item of items) {
                  const imageType = item.types.find((t) => t.startsWith("image/"));
                  if (imageType) {
                    const blob = await item.getType(imageType);
                    setActiveTool("mover");
                    placeImageBlob(blob, { x: menu.canvasX, y: menu.canvasY });
                    return;
                  }
                }
                const textItem = items.find((i) => i.types.includes("text/plain"));
                if (!textItem) return;
                const textBlob = await textItem.getType("text/plain");
                const clipText = await textBlob.text();
                if (!clipText) return;
                const lines = clipText.split("\n").filter((l) => l.length > 0);
                if (lines.length === 0) return;
                const chain = placeChain(lines, menu.canvasX, snapTextLineY(menu.canvasY));
                execPlace(chain.op, chain.response);
              } catch { /* ignore */ }
            };

            const doSpawnText = () => {
              const { op, id } = spawnText(menu.canvasX, menu.canvasY);
              execPlace(op);
              newElIdRef.current = id;
              setActiveTool("text");
            };

            const doSpawnShape = (shape: "rect" | "circle" | "triangle") => {
              const SIZE = 120;
              const box = { x: menu.canvasX - SIZE / 2, y: menu.canvasY - SIZE / 2, w: SIZE, h: SIZE };
              const { op } = spawnShape(box, shape);
              execPlace(op);
              setActiveTool("mover");
            };

            const doSpawnTable = () => {
              const rows = 3, cols = 3;
              const cells: TableCell[][] = Array.from({ length: rows }, () =>
                Array.from({ length: cols }, () => ({ html: "" })),
              );
              // Match TableContainer's empty-cell layout (MIN_COL_W = MIN_ROW_H = 44, BORDER_PX = 1)
              // so the stored AABB matches the rendered frame from frame 1.
              const MIN_CELL = 44, BORDER = 1;
              const w = cols * MIN_CELL + (cols + 1) * BORDER;
              const h = rows * MIN_CELL + (rows + 1) * BORDER;
              const id = crypto.randomUUID();
              const el: TableEl = { id, type: "table", x: menu.canvasX - w / 2, y: menu.canvasY, w, h, cells };
              execPlace({ kind: "spawn", element: el, resolve: dragResolvePush() });
              setActiveTool("mover");
            };

            const doSpawnChecklist = () => {
              // Match ChecklistContainer's MIN_W / MIN_ROW_H so the stored AABB matches from frame 1.
              const w = 220, h = 28;
              const id = crypto.randomUUID();
              const el: ChecklistEl = {
                id, type: "checklist",
                x: menu.canvasX - w / 2, y: menu.canvasY,
                w, h,
                items: [{ html: "", checked: false }],
              };
              execPlace({ kind: "spawn", element: el, resolve: dragResolvePush() });
              setActiveTool("mover");
            };

            const doSpawnPrint = () => {
              spawnPageRegionAt(menu.canvasX, menu.canvasY);
              setActiveTool("mover");
            };

            const doSpawnChat = () => {
              spawnChatAt(menu.canvasX, menu.canvasY);
              setActiveTool("mover");
            };

            const doOpenNotePicker = () => {
              setNotePickerPos({
                cx: menu.canvasX,
                cy: menu.canvasY,
                screenX: menu.screenX,
                screenY: menu.screenY,
              });
              setNotePickerSearch("");
            };

            const doSpawnArrow = () => {
              const LEN = 120;
              const { op } = spawnArrow(
                menu.canvasX - LEN / 2, menu.canvasY,
                menu.canvasX + LEN / 2, menu.canvasY,
              );
              execPlace(op);
              setActiveTool("mover");
            };

            const doSpawnGraph = () => {
              const GW = 600, GH = 400;
              const graphEl: GraphEl = {
                id: crypto.randomUUID(), type: "graph",
                x: menu.canvasX - GW / 2, y: menu.canvasY - GH / 2,
                w: GW, h: GH,
                graphNum: nextGraphNum(allElementsRef.current),
              };
              execPlace({ kind: "spawn", element: graphEl, resolve: dragResolvePush() }, { immediate: true });
              setActiveTool("mover");
            };

            const doPickImage = () => {
              fileInputRef.current?.click();
            };

            const doPickPdf = () => {
              pdfInputRef.current?.click();
            };

            type Item = { label: string; icon: string; onClick: () => void; divider?: false; disabled?: boolean }
                      | { divider: true };
            const items: Item[] = [
              { label: "Paste", icon: "content_paste", onClick: doPaste, disabled: !menu.canPaste },
              { divider: true },
              { label: "Text", icon: "text_fields", onClick: doSpawnText },
              { divider: true },
              { label: "Rectangle", icon: "rectangle", onClick: () => doSpawnShape("rect") },
              { label: "Circle", icon: "circle", onClick: () => doSpawnShape("circle") },
              { label: "Triangle", icon: "change_history", onClick: () => doSpawnShape("triangle") },
              { label: "Arrow", icon: "arrow_right_alt", onClick: doSpawnArrow },
              { divider: true },
              { label: "Table", icon: "table_chart", onClick: doSpawnTable },
              { label: "Checklist", icon: "checklist", onClick: doSpawnChecklist },
              { label: "Graph", icon: "show_chart", onClick: doSpawnGraph },
              { label: "Chat", icon: "chat", onClick: doSpawnChat },
              { label: "Note link", icon: "link", onClick: doOpenNotePicker },
              { label: "Image", icon: "image", onClick: doPickImage },
              { label: "PDF", icon: "picture_as_pdf", onClick: doPickPdf },
              { divider: true },
              { label: "Print region", icon: "print", onClick: doSpawnPrint },
            ];

            return (
              <>
                <div onMouseDown={close} style={{ position: "fixed", inset: 0, zIndex: 999 }} />
                <div
                  ref={(node) => {
                    if (!node) return;
                    const r = node.getBoundingClientRect();
                    const PAD = 8;
                    const vpW = window.innerWidth;
                    const vpH = window.innerHeight;
                    if (r.right > vpW - PAD) {
                      node.style.left = `${Math.max(PAD, vpW - r.width - PAD)}px`;
                    }
                    if (r.bottom > vpH - PAD) {
                      node.style.top = `${Math.max(PAD, vpH - r.height - PAD)}px`;
                    }
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onContextMenu={(e) => e.preventDefault()}
                  style={{
                    position: "fixed",
                    left: menu.screenX,
                    top: menu.screenY,
                    zIndex: 1000,
                    minWidth: 180,
                    background: "var(--th-surface)",
                    border: "1px solid var(--th-border-30)",
                    borderRadius: 6,
                    boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                    padding: "4px 0",
                  }}
                >
                  {items.map((it, i) => {
                    if ("divider" in it && it.divider) {
                      return <div key={i} style={{ height: 1, margin: "4px 0", background: "var(--th-border-10)" }} />;
                    }
                    const entry = it as Extract<Item, { label: string }>;
                    const disabled = !!entry.disabled;
                    return (
                      <button
                        key={i}
                        disabled={disabled}
                        onClick={() => { entry.onClick(); close(); }}
                        className="font-lexend"
                        style={{
                          width: "100%",
                          padding: "6px 12px",
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          fontSize: 12,
                          color: disabled ? "var(--th-text-faint)" : "var(--th-text)",
                          background: "transparent",
                          border: "none",
                          textAlign: "left",
                          cursor: disabled ? "default" : "pointer",
                          opacity: disabled ? 0.5 : 1,
                        }}
                        onMouseEnter={(e) => {
                          if (disabled) return;
                          (e.currentTarget as HTMLButtonElement).style.background = "var(--th-surface-hover)";
                        }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>{entry.icon}</span>
                        <span>{entry.label}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            );
          })()}

          {/* Canvas metadata */}
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-4 text-[10px] font-bold text-[var(--th-text-faint)] tracking-widest uppercase font-lexend pointer-events-none">
            <span>{allElementsRef.current.length} elements</span>
            <span className="w-[1px] h-3 bg-[var(--th-border-20)]" />
            <span>{zoomPct}%</span>
            {activeTool && <span className="text-[var(--th-text-faint)]">· {activeTool} tool active</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
