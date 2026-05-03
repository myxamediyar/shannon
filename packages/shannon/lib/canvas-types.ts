// ── Constants: Backend & Storage ──────────────────────────────────────────────

export const BACKEND = "/api";
export const STORAGE_KEY = "shannon_notes";

// ── Constants: Canvas Background ────────────────────────────────────────────

export const BG_DOT_RADIUS = 1;       // px
export const BG_DOT_SPACING = 24;     // px (before zoom)

// ── Constants: Page Region ──────────────────────────────────────────────────
// Dimensions at 192 "canvas DPI" (2× CSS px) so the page feels proportional
// to canvas text at default zoom. Print pipeline scales down to real paper.

export const PAGE_CANVAS_DPI = 192;
export const PAGE_PRINT_DPI = 96;              // physical paper mapping (1in = 96 CSS px)
export const PAGE_PRINT_SCALE = PAGE_PRINT_DPI / PAGE_CANVAS_DPI; // 0.5

export const PAGE_MARGIN = 192; // 1" at canvas DPI

export const PAGE_SIZES = {
  letter: { w: 1632, h: 2112, label: "Letter" }, // 8.5" × 11"
  a4:     { w: 1587, h: 2245, label: "A4"     }, // 210mm × 297mm
  legal:  { w: 1632, h: 2688, label: "Legal"  }, // 8.5" × 14"
} as const;

export type PageSize = keyof typeof PAGE_SIZES;
export type PageRotation = 0 | 90;

export type PageRegion = {
  id: string;
  x: number;            // canvas-space top-left (after rotation)
  y: number;
  size: PageSize;
  rotation: PageRotation;
  marginX?: number;     // canvas-px; falls back to PAGE_MARGIN
  marginY?: number;
};

/** Rendered w/h for a region given its size + rotation. */
export function pageRegionDims(size: PageSize, rotation: PageRotation): { w: number; h: number } {
  const { w, h } = PAGE_SIZES[size];
  return rotation === 90 ? { w: h, h: w } : { w, h };
}

// ── Constants: Zoom / Scale ──────────────────────────────────────────────────

export const MIN_SCALE = 0.15;
export const MAX_SCALE = 4;
export const DEFAULT_SCALE = 0.70;

// ── Constants: Text ──────────────────────────────────────────────────────────

export const TEXT_BASE_FONT_PX = 14;
export const MIN_TEXT_SCALE = 1;
export const MAX_TEXT_SCALE = 4;
export const DEFAULT_TEXT_SCALE = 2;

/** Text row height in canvas space (px); all canvas text snaps to this grid on Y. */
export const TEXT_LINE_HEIGHT = 21;
/** Max width of a text row in canvas space (long lines scroll horizontally inside the fragment). */
export const TEXT_LINE_MAX_WIDTH = 20000;
/** After the last glyph: textarea width and click-hit extend by this many avg char widths (caret only, not a wide slab). */
export const TEXT_BOX_END_PAD_CHARS = 0;

/** Maximum visible chat lines before the container scrolls. */
export const CHAT_MAX_VISIBLE_LINES = 20;
/** Total width of the chat container in canvas-space pixels (including indicator margin). */
export const CHAT_CONTAINER_WIDTH = 1100;
/** Left margin reserved for the ">" role indicator in the chat container. */
export const CHAT_INDICATOR_MARGIN = 30;

export const OPTION_BACKSPACE_CHAR_STEPS = 5;
/** Tab / Shift+Tab: move up to this many avg char widths, unless a 15-grid line or neighbor edge is closer. */
export const TAB_CHAR_STEPS = 5;
/**
 * Resolved font-family for canvas/Chart.js use. next/font generates a hashed
 * family name and exposes it via the --font-lexend CSS variable, so we read
 * that at runtime rather than hardcoding 'Lexend Deca' (which won't match).
 * Cached after first call.
 */
let _resolvedFontFamily: string | null = null;
export function canvasFontFamily(): string {
  if (_resolvedFontFamily) return _resolvedFontFamily;
  if (typeof document === "undefined") return "Lexend Deca, sans-serif";
  const v = getComputedStyle(document.documentElement).getPropertyValue("--font-lexend").trim();
  _resolvedFontFamily = v ? `${v}, sans-serif` : "Lexend Deca, sans-serif";
  return _resolvedFontFamily;
}

/** Matches canvas textarea: Lexend Deca 14px (text-sm). */
export function textFontSpec(sizePx: number = TEXT_BASE_FONT_PX): string {
  return `400 ${sizePx}px ${canvasFontFamily()}`;
}

// ── Constants: Note References ──────────────────────────────────────────────

export const NOTE_REF_W = 200;
export const NOTE_REF_H = 160;

// ── Constants: Charts ────────────────────────────────────────────────────────

export const CHART_TYPES = ["bar","line","pie","doughnut","radar","polarArea","histogram","scatter"] as const;

export const CHART_PALETTE = [
  "rgba(108, 99, 255, 0.8)", "rgba(34, 197, 94, 0.8)",
  "rgba(234, 179, 8, 0.8)",  "rgba(239, 68, 68, 0.8)",
  "rgba(14, 165, 233, 0.8)", "rgba(168, 85, 247, 0.8)",
];
export const CHART_TICK_COLOR = "#9ca3af";
export const CHART_GRID_COLOR = "#374151";

// ── Constants: Tools ─────────────────────────────────────────────────────────

export type ToolId =
  | "text"
  | "mover"

  | "draw"
  | "shape"
  | "image"
  | "pdf"
  | "eraser"
  | "noteRef"
  | "graph"
  | "print"
  | "chat"
  | "table"
  | "checklist";

export const TOOLS: { id: ToolId; icon: string; label: string; cursor: string }[] = [
  { id: "text",   icon: "text_fields",   label: "Text",   cursor: "text" },
  { id: "mover",  icon: "mouse",         label: "Move",   cursor: "default" },

  { id: "draw",   icon: "gesture",       label: "Draw",   cursor: "crosshair" },
  { id: "shape",  icon: "category",      label: "Shape",  cursor: "crosshair" },
  { id: "image",  icon: "image",         label: "Image",  cursor: "cell" },
  { id: "pdf",    icon: "picture_as_pdf", label: "PDF",   cursor: "cell" },
  { id: "eraser", icon: "ink_eraser",    label: "Eraser", cursor: "crosshair" },
  { id: "noteRef", icon: "link",         label: "Note Link", cursor: "cell" },
  { id: "graph",   icon: "show_chart",   label: "Graph",     cursor: "cell" },
  { id: "print",   icon: "print",        label: "Print Region", cursor: "cell" },
  { id: "chat",    icon: "chat",         label: "Chat",      cursor: "cell" },
  { id: "table",   icon: "table_chart",  label: "Table",     cursor: "cell" },
  { id: "checklist", icon: "checklist",  label: "Checklist", cursor: "cell" },
];

// ── Types: Canvas Elements ───────────────────────────────────────────────────

export type ChatRole = "user" | "assistant" | "input";
export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  citations?: string[];
  /** Marker variants:
   *   - "compaction": divider showing N folded-up earlier messages.
   *   - "compacting": transient placeholder shown while compaction is running; spliced out on completion.
   *   - "command":   a slash-command the user submitted (e.g. "/compact"). Rendered with command coloring; never sent to the LLM. */
  kind?: "compaction" | "compacting" | "command";
  /** Number of original messages folded into this marker (only meaningful when kind === "compaction"). */
  summarizedCount?: number;
};
/** A single entry in the array sent to the LLM. Decoupled from `messages` so compaction
 *  can replace older entries with a synthesized summary without altering the UI log. */
export type ChatContextMessage = { role: "user" | "assistant"; content: string };
export type ChatEl = { id: string; type: "chat"; x: number; y: number; w?: number; h?: number; chatId: string; chatNumber: number; messages: ChatMessage[];
  /** What the LLM actually sees on each request. Survives reloads (the in-memory
   *  chatHistoriesRef is a write-through cache). Compaction rewrites this without
   *  touching `messages`. Absent on legacy elements — hydrate from `messages` then. */
  contextMessages?: ChatContextMessage[];
  inputText: string; measuredH?: number; isStreaming?: boolean; tokenCount?: number; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; contextWindow?: number | null; lastTurnInputTokens?: number; estimatedOutputTokens?: number; ephemeral?: boolean; parentChatNumber?: number; sideqNumber?: number; children?: number[]; toolStatus?: string | null;
  /** Runtime-only: query to auto-submit when the container mounts. Stripped on persist. */
  pendingSubmit?: string;
  /** Runtime-only: pairs with pendingSubmit to mark /q (ephemeral, no history append). */
  pendingSubmitIsQuick?: boolean;
  /** Per-chat visual setting: render a translucent dim panel behind the chat
   *  content so messages read more clearly against busy canvas backgrounds. */
  dimmed?: boolean;
};
export type TextEl   = { id: string; type: "text";   x: number; y: number; text: string; html?: string; fontScale?: number; locked?: boolean; cmdLen?: number; measuredW?: number; measuredH?: number; /** Manual wrap width in canvas-space px (right-edge resize). If unset, defaults to chat content width. */ w?: number };

/** A text fragment is "blank" if its plain text is empty or whitespace-only.
 *  Use this everywhere a fragment should be treated as a placeholder — drop on
 *  navigation, skip from spatial pushes, ignore from history, etc. */
export const isTextBlank = (text: string): boolean => text.trim() === "";

export type ImageEl  = {
  id: string; type: "image"; x: number; y: number; src: string; w: number; h: number;
  blobId?: string; z?: number; noPush?: boolean;
  /** Crop window in source-image pixel coords. Undefined = full image. */
  crop?: { x: number; y: number; w: number; h: number };
  /** Pre-first-crop display rect. Set on first crop, cleared on revert. Presence = "revertable". */
  originalX?: number; originalY?: number; originalW?: number; originalH?: number;
};
export type ShapeEl  = { id: string; type: "shape";  x: number; y: number; w: number; h: number; shape: "rect" | "circle" | "triangle"; z?: number };
export type DrawEl   = { id: string; type: "draw";   pts: string; z?: number };
export type ArrowEl  = { id: string; type: "arrow";  x1: number; y1: number; x2: number; y2: number };

export type ChartType = (typeof CHART_TYPES)[number];
export type ChartDataset = { label: string; values: number[] };
export type ChartEl = { id: string; type: "chart"; x: number; y: number; chartType: ChartType; labels: string[]; datasets: ChartDataset[]; w: number; h: number; description?: string; formula?: string; loading?: boolean; error?: string };
export type MathEl  = { id: string; type: "math";  x: number; y: number; latex: string; measuredW?: number; measuredH?: number };
export type NoteRefEl = { id: string; type: "noteRef"; x: number; y: number; targetNoteId: string };
export type GraphEl  = { id: string; type: "graph";   x: number; y: number; w: number; h: number; graphNum: number; expressions?: string[]; expressionColors?: string[]; xBounds?: [number, number]; yBounds?: [number, number] };
export type PdfEl    = { id: string; type: "pdf";     x: number; y: number; w: number; h: number; src: string; filename: string; numPages: number; blobId?: string };
export type EmbedEl  = { id: string; type: "embed";   x: number; y: number; w: number; h: number; embedUrl: string; title: string; provider: "google-docs" | "google-sheets" | "google-slides" | "youtube" | "generic" };
export type TableCell = { html: string; measuredW?: number; measuredH?: number };
export type TableEl  = { id: string; type: "table";   x: number; y: number; w: number; h: number; cells: TableCell[][]; colWidths?: number[]; rowHeights?: number[] };
export type ChecklistItem = { html: string; checked: boolean; measuredW?: number; measuredH?: number };
export type ChecklistEl  = { id: string; type: "checklist"; x: number; y: number; w: number; h: number; items: ChecklistItem[]; itemHeights?: number[] };

export type CanvasEl = TextEl | ImageEl | ShapeEl | DrawEl | ArrowEl | ChartEl | MathEl | ChatEl | NoteRefEl | GraphEl | PdfEl | EmbedEl | TableEl | ChecklistEl;
export type NoteItem = { id: string; title: string; elements: CanvasEl[]; updatedAt: number; locked?: boolean; pageRegions?: PageRegion[] };
export type CanvasAabb = { x: number; y: number; w: number; h: number };

// ── Placement Engine Types ──────────────────────────────────────────────────

export type PushAxis = "horizontal" | "vertical" | "shortest";

export type PushQuantum =
  | { kind: "exact" }       // push by exact overlap amount (drag/resize)
  | { kind: "lineHeight" }  // push by TEXT_LINE_HEIGHT (enter/newline)
  | { kind: "abut" };       // chain: place edge at pusher edge + 1px gap (typing/tab)

export type ResolveOpts = {
  axis: PushAxis;
  quantum: PushQuantum;
  /** Element types excluded from being pushed. Default: ["draw", "arrow"] */
  excludeTypes?: CanvasEl["type"][];
  /** For directional pushes (horizontal/vertical). */
  direction?: 1 | -1;
  /** Custom predicate: return false to skip pushing an element. */
  skip?: (el: CanvasEl) => boolean;
  /** Max cascade passes. Default: 15. */
  maxPasses?: number;
  /** When true, skip hierarchical anchor resolution and use flat single-pass mode.
   *  Default (false): resolve anchors in order (anchored elements first → full canvas). */
  flatResolve?: boolean;
};

export type PlacementOp =
  | { kind: "spawn"; element: CanvasEl; resolve?: ResolveOpts }
  | { kind: "move"; id: string; to: { x?: number; y?: number }; resolve?: ResolveOpts }
  | { kind: "mutate"; id: string; changes: Partial<CanvasEl>; resolve?: ResolveOpts }
  | { kind: "swap"; a: string; b: string; direction: 1 | -1 }
  | { kind: "remove"; ids: Set<string> }
  | { kind: "transform"; fn: (elements: CanvasEl[]) => CanvasEl[]; anchorIds?: Set<string>; resolve?: ResolveOpts };

export type PlacementResponse = {
  merge?: { focusId: string; caret: number | null };
  focus?: { id: string; caret: number };
};

export type PlacementResult = {
  elements: CanvasEl[];
  caretFocus: { id: string; caret: number } | null;
};
