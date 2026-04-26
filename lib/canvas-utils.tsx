"use client";

import {
  TEXT_BASE_FONT_PX,
  MIN_TEXT_SCALE,
  MAX_TEXT_SCALE,
  DEFAULT_TEXT_SCALE,
  TEXT_LINE_HEIGHT,
  TEXT_LINE_MAX_WIDTH,
  TEXT_BOX_END_PAD_CHARS,
  OPTION_BACKSPACE_CHAR_STEPS,
  TAB_CHAR_STEPS,
  textFontSpec,
  canvasFontFamily,
  CHART_PALETTE,
  CHAT_MAX_VISIBLE_LINES,
  CHAT_CONTAINER_WIDTH,
  CHAT_INDICATOR_MARGIN,
  CHART_TICK_COLOR,
  CHART_GRID_COLOR,
  NOTE_REF_W,
  NOTE_REF_H,
  isTextBlank,
} from "./canvas-types";

import type {
  ChatContextMessage,
  ChatEl,
  ChatMessage,
  TextEl,

  ImageEl,
  ShapeEl,
  DrawEl,
  ArrowEl,
  ChartEl,
  MathEl,
  NoteRefEl,
  GraphEl,
  PdfEl,
  TableEl,
  TableCell,
  ChecklistEl,
  ChecklistItem,
  CanvasEl,
  NoteItem,
  CanvasAabb,
  ChartType,
  ChartDataset,
  ResolveOpts,
  PlacementOp,
  PlacementResponse,
  PlacementResult,
} from "./canvas-types";

import { memo } from "react";
import { Bar, Line, Pie, Doughnut, Radar, PolarArea, Scatter } from "react-chartjs-2";

// ── Shared module-level state ────────────────────────────────────────────────

let _measureCanvas: HTMLCanvasElement | null = null;
const _textLineHeightCache = new Map<number, number>();

// ── AI free-spot placement constants ─────────────────────────────────────────

const AI_COL_X = 80;
export const AI_COL_W = 500;
const AI_COL_MARGIN = 24;

// ── Zoom ─────────────────────────────────────────────────────────────────────

/** Compute a zoom multiplier that feels slower when zoomed out and faster when zoomed in.
 *  `base` is the step at scale=1 (e.g. 0.05). Returns a factor like 1.03 ... 1.08. */
export function zoomStep(currentScale: number, base: number): number {
  return base * currentScale;
}

// ── Text grid / snap ─────────────────────────────────────────────────────────

export function snapTextLineY(y: number): number {
  return Math.round(y / TEXT_LINE_HEIGHT) * TEXT_LINE_HEIGHT;
}

export function textScale(el: TextEl): number {
  const k = Math.round(el.fontScale ?? DEFAULT_TEXT_SCALE);
  return Math.max(MIN_TEXT_SCALE, Math.min(MAX_TEXT_SCALE, k));
}

export function textLineHeightForScale(k: number): number {
  if (k <= 1) return TEXT_LINE_HEIGHT;
  const cached = _textLineHeightCache.get(k);
  if (cached !== undefined) return cached;
  if (typeof document === "undefined") return TEXT_LINE_HEIGHT * k;
  if (!_measureCanvas) _measureCanvas = document.createElement("canvas");
  const ctx = _measureCanvas.getContext("2d");
  if (!ctx) return TEXT_LINE_HEIGHT * k;
  ctx.font = `400 ${TEXT_BASE_FONT_PX * k}px ${canvasFontFamily()}`;
  const m = ctx.measureText("Mg|ÁÅgjpqy");
  // Use font bounding box if available (covers all glyphs), fall back to actual
  const ascent = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent ?? TEXT_BASE_FONT_PX * k;
  const descent = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent ?? TEXT_BASE_FONT_PX * k * 0.25;
  const h = Math.ceil(ascent + descent + 2); // +2px breathing room
  _textLineHeightCache.set(k, h);
  return h;
}

// ── Markdown heading detection & per-line height ─────────────────────────────

/** Return the markdown heading level (1-6) for a line, or 0 if not a heading. */
export function headingLevel(line: string): number {
  const m = /^(#{1,6})\s/.exec(line);
  return m ? m[1].length : 0;
}

/** CSS em scale for each heading level. Must match .text-markdown h1-h6 in globals.css. */
const HEADING_EM: Record<number, number> = {
  1: 1.4,
  2: 1.2,
  3: 1.05,
  4: 0.92,
  5: 0.84,
  6: 0.76,
};

/** Return the em multiplier for a heading level (0 = normal text → 1). */
export function headingEmScale(level: number): number {
  return HEADING_EM[level] ?? 1;
}

/** Line height for a single line of text, accounting for its heading level. */
export function textLineHeightForLine(line: string, k: number): number {
  const baseLh = textLineHeightForScale(k);
  const level = headingLevel(line);
  if (level === 0) return baseLh;
  const em = headingEmScale(level);
  return Math.ceil(baseLh * em);
}

/** Accumulated Y-offsets for each line of a multi-line text element.
 *  Returns an array of length lines.length + 1: [y0, y1, ..., totalH]. */
export function textLineYOffsets(lines: string[], k: number): number[] {
  const offsets = [0];
  for (let i = 0; i < lines.length; i++) {
    offsets.push(offsets[i] + textLineHeightForLine(lines[i], k));
  }
  return offsets;
}

// ── Line prefix detection (lists, checklists, blockquotes) ─────────────────

export type LinePrefix =
  | { kind: "check"; checked: boolean; raw: string; rest: string }
  | { kind: "bullet"; raw: string; rest: string }
  | { kind: "number"; num: string; raw: string; rest: string }
  | { kind: "quote"; raw: string; rest: string }
  | { kind: "none"; rest: string };

const RE_CHECK   = /^([-*+]\s\[[ xX]\]\s)/;
const RE_BULLET  = /^([-*+]\s)/;
const RE_NUMBER  = /^(\d+\.\s)/;
const RE_QUOTE   = /^(>\s?)/;

export function parseLinePrefix(line: string): LinePrefix {
  let m: RegExpExecArray | null;
  if ((m = RE_CHECK.exec(line))) {
    const checked = /\[[xX]\]/.test(m[1]);
    return { kind: "check", checked, raw: m[1], rest: line.slice(m[1].length) };
  }
  if ((m = RE_BULLET.exec(line)))
    return { kind: "bullet", raw: m[1], rest: line.slice(m[1].length) };
  if ((m = RE_NUMBER.exec(line)))
    return { kind: "number", num: m[1].slice(0, -2), raw: m[1], rest: line.slice(m[1].length) };
  if ((m = RE_QUOTE.exec(line)))
    return { kind: "quote", raw: m[1], rest: line.slice(m[1].length) };
  return { kind: "none", rest: line };
}

// ── Table detection ────────────────────────────────────────────────────────

const RE_TABLE_ROW = /^\|(.+)\|$/;
const RE_TABLE_SEP = /^\|[\s\-:]+(\|[\s\-:]+)*\|$/;

/** Check if a line looks like a markdown table row (starts and ends with |). */
export function isTableLine(line: string): boolean {
  return RE_TABLE_ROW.test(line.trim());
}

/** Check if a line is a table separator row (| --- | --- |). */
export function isTableSeparator(line: string): boolean {
  return RE_TABLE_SEP.test(line.trim());
}

export type ParsedTableCell = { text: string; align?: "left" | "center" | "right" };
export type ParsedTable = {
  headerCells: ParsedTableCell[];
  rows: ParsedTableCell[][];
};

/** Parse a separator row to extract column alignments. */
function parseSepAlignments(sepLine: string): ("left" | "center" | "right" | undefined)[] {
  const cells = sepLine.trim().slice(1, -1).split("|");
  return cells.map(c => {
    const t = c.trim();
    const left = t.startsWith(":");
    const right = t.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return undefined;
  });
}

/** Parse a group of table lines into header + rows. Returns null if not a valid table. */
export function parseTable(lines: string[]): ParsedTable | null {
  if (lines.length < 2) return null;
  // First line = header, second = separator
  if (!isTableLine(lines[0]) || !isTableSeparator(lines[1])) return null;
  const aligns = parseSepAlignments(lines[1]);
  const splitRow = (line: string): ParsedTableCell[] => {
    const cells = line.trim().slice(1, -1).split("|");
    return cells.map((c, i) => ({ text: c.trim(), align: aligns[i] }));
  };
  const headerCells = splitRow(lines[0]);
  const rows: ParsedTableCell[][] = [];
  for (let i = 2; i < lines.length; i++) {
    if (isTableLine(lines[i])) rows.push(splitRow(lines[i]));
  }
  return { headerCells, rows };
}

/**
 * Group text lines into blocks: consecutive table lines form a table block,
 * everything else is a "lines" block. Returns an array of blocks with their
 * starting line index.
 */
export type TextBlock =
  | { kind: "lines"; startIdx: number; lines: string[] }
  | { kind: "table"; startIdx: number; lines: string[]; table: ParsedTable };

export function groupTextBlocks(allLines: string[]): TextBlock[] {
  const blocks: TextBlock[] = [];
  let i = 0;
  while (i < allLines.length) {
    // Check if this starts a table: need at least header + separator
    if (i + 1 < allLines.length && isTableLine(allLines[i]) && isTableSeparator(allLines[i + 1])) {
      const start = i;
      i += 2; // skip header + separator
      while (i < allLines.length && isTableLine(allLines[i])) i++;
      const tableLines = allLines.slice(start, i);
      const table = parseTable(tableLines);
      if (table) {
        blocks.push({ kind: "table", startIdx: start, lines: tableLines, table });
      } else {
        // Fallback: treat as regular lines
        blocks.push({ kind: "lines", startIdx: start, lines: tableLines });
      }
    } else {
      // Regular line — accumulate into a "lines" block
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "lines") {
        last.lines.push(allLines[i]);
      } else {
        blocks.push({ kind: "lines", startIdx: i, lines: [allLines[i]] });
      }
      i++;
    }
  }
  return blocks;
}

// ── Chain migration (legacy parentId → multi-line text) ─────────────────────

/** Migrate legacy linked-list text chains into single multi-line text elements.
 *  Each chain (elements linked via parentId) is merged into a single TextEl
 *  whose `.text` contains newlines. */
export function migrateChains(elements: CanvasEl[]): CanvasEl[] {
  // Upgrade legacy tables (rows: string[][]) → (cells: TableCell[][])
  elements = elements.map((el) => {
    if (el.type !== "table") return el;
    const legacy = el as TableEl & { rows?: string[][] };
    if (legacy.cells || !legacy.rows) return el;
    const { rows: legacyRows, ...rest } = legacy;
    return { ...rest, cells: migrateLegacyTableRows(legacyRows) } as TableEl;
  });

  // Build parentId → child lookup (legacy field, cast via any)
  type LegacyText = TextEl & { parentId?: string };
  const textEls = new Map<string, LegacyText>();
  const childOf = new Map<string, string>(); // childId → parentId
  for (const el of elements) {
    if (el.type !== "text") continue;
    const tel = el as LegacyText;
    textEls.set(tel.id, tel);
    if ((tel as any).parentId) childOf.set(tel.id, (tel as any).parentId);
  }
  // Find chain roots: text elements that have children but no parent
  const hasChild = new Set<string>();
  for (const [, pid] of childOf) hasChild.add(pid);
  const roots: string[] = [];
  for (const [id] of textEls) {
    if (!childOf.has(id) && hasChild.has(id)) roots.push(id);
  }
  if (roots.length === 0) {
    // No chains — just strip any stale parentId field
    return assignChatNumbers(elements.map(el => {
      if (el.type === "text" && (el as any).parentId != null) {
        const { parentId: _, ...rest } = el as any;
        return rest as CanvasEl;
      }
      return el;
    }));
  }
  const removeIds = new Set<string>();
  const merged = new Map<string, TextEl>(); // rootId → merged element
  for (const rootId of roots) {
    const chain: LegacyText[] = [];
    let cur: LegacyText | undefined = textEls.get(rootId);
    const visited = new Set<string>();
    while (cur && !visited.has(cur.id)) {
      chain.push(cur);
      visited.add(cur.id);
      // Find child
      let childId: string | undefined;
      for (const [cid, pid] of childOf) { if (pid === cur.id) { childId = cid; break; } }
      cur = childId ? textEls.get(childId) : undefined;
    }
    if (chain.length <= 1) continue;
    // Merge text with newlines
    let combinedText = "";
    for (let i = 0; i < chain.length; i++) {
      combinedText += chain[i].text;
      if (i < chain.length - 1) combinedText += "\n";
    }
    const root = chain[0];
    const { parentId: _, ...rootClean } = root as any;
    merged.set(rootId, {
      ...rootClean,
      text: combinedText,
    });
    for (let i = 1; i < chain.length; i++) removeIds.add(chain[i].id);
  }
  return assignChatNumbers(elements
    .filter(el => !removeIds.has(el.id))
    .map(el => {
      if (merged.has(el.id)) return merged.get(el.id)!;
      if (el.type === "text" && (el as any).parentId != null) {
        const { parentId: _, ...rest } = el as any;
        return rest as CanvasEl;
      }
      return el;
    }));
}

/** Assign chatNumber to any ChatEl that doesn't have one yet. */
/**
 * Normalize chat numbering on load:
 * 1. Assign numbers to chats that have none
 * 2. Resolve collisions (push dupes to end)
 * 3. Re-ID non-ephemeral chats sequentially (1, 2, 3, …)
 * 4. Cascade parentChatNumber updates to children (sidechats + sideqs)
 * 5. Renumber sideqNumber per parent
 * 6. Compute children[] array on each parent
 */
export function assignChatNumbers(elements: CanvasEl[]): CanvasEl[] {
  // Separate chats from non-chats
  const nonChats: CanvasEl[] = [];
  const regularChats: ChatEl[] = [];   // non-ephemeral
  const ephemeralChats: ChatEl[] = []; // sideqs
  for (const el of elements) {
    if (el.type !== "chat") { nonChats.push(el); continue; }
    const chat = el as ChatEl;
    if (chat.ephemeral) { ephemeralChats.push({ ...chat }); }
    else { regularChats.push({ ...chat }); }
  }

  if (regularChats.length === 0 && ephemeralChats.length === 0) return elements;

  // Step 1: Assign numbers to chats that have none, push to end
  let maxExisting = 0;
  for (const c of regularChats) {
    if (c.chatNumber != null && c.chatNumber > 0) maxExisting = Math.max(maxExisting, c.chatNumber);
  }
  let appendCounter = maxExisting + 1;
  for (const c of regularChats) {
    if (c.chatNumber == null || c.chatNumber <= 0) c.chatNumber = appendCounter++;
  }

  // Step 2: Resolve collisions — keep first occurrence, push dupes to end
  const seen = new Set<number>();
  const collisions: ChatEl[] = [];
  const unique: ChatEl[] = [];
  for (const c of regularChats) {
    if (seen.has(c.chatNumber)) { collisions.push(c); }
    else { seen.add(c.chatNumber); unique.push(c); }
  }
  let collisionCounter = Math.max(appendCounter, (unique.length > 0 ? Math.max(...unique.map(c => c.chatNumber)) : 0) + 1);
  for (const c of collisions) {
    c.chatNumber = collisionCounter++;
    unique.push(c);
  }

  // Step 3: Re-ID sequentially. Sort by current chatNumber, assign 1, 2, 3, …
  unique.sort((a, b) => a.chatNumber - b.chatNumber);
  // Snapshot old numbers before re-ID for orphan detection
  const oldExistingNums = new Set(unique.map(c => c.chatNumber));
  const oldToNew = new Map<number, number>();
  for (let i = 0; i < unique.length; i++) {
    const newNum = i + 1;
    if (unique[i].chatNumber !== newNum) oldToNew.set(unique[i].chatNumber, newNum);
    unique[i].chatNumber = newNum;
  }

  // Step 4: Mark orphaned children (parent was deleted), then remap surviving parents
  const remap = (n: number) => oldToNew.get(n) ?? n;
  for (const c of unique) {
    if (c.parentChatNumber != null) {
      if (!oldExistingNums.has(c.parentChatNumber)) { c.parentChatNumber = -1; }
      else {
        c.parentChatNumber = remap(c.parentChatNumber);
        if (c.parentChatNumber === c.chatNumber) c.parentChatNumber = -1;
      }
    }
  }
  for (const c of ephemeralChats) {
    if (c.parentChatNumber != null) {
      if (!oldExistingNums.has(c.parentChatNumber)) { c.parentChatNumber = -1; }
      else { c.parentChatNumber = remap(c.parentChatNumber); }
    }
  }

  // Step 5: Renumber sideqNumber per parent
  const sideqCounters = new Map<number, number>();
  for (const c of ephemeralChats) {
    if (c.parentChatNumber != null) {
      const count = (sideqCounters.get(c.parentChatNumber) ?? 0) + 1;
      sideqCounters.set(c.parentChatNumber, count);
      c.sideqNumber = count;
    }
  }

  // Step 6: Compute children[] on each parent
  // Children = sidechat chatNumbers + sideq display numbers (as parentNum-sideqNum encoded)
  const childMap = new Map<number, number[]>();
  for (const c of unique) {
    if (c.parentChatNumber != null) {
      const arr = childMap.get(c.parentChatNumber) ?? [];
      arr.push(c.chatNumber);
      childMap.set(c.parentChatNumber, arr);
    }
  }
  for (const c of unique) {
    c.children = childMap.get(c.chatNumber) ?? [];
  }

  // Reassemble
  const chatMap = new Map<string, ChatEl>();
  for (const c of unique) chatMap.set(c.id, c);
  for (const c of ephemeralChats) chatMap.set(c.id, c);

  return elements.map(el => chatMap.get(el.id) ?? el);
}

// ── Text element bounding box ──────────────────────────────────────────────

/** Single AABB for a text element, using DOM-measured dimensions from Tiptap. */
export function textElementAabb(el: TextEl): CanvasAabb {
  const k = textScale(el);
  return {
    x: el.x,
    y: snapTextLineY(el.y),
    w: Math.max(8, el.measuredW ?? 8),
    h: el.measuredH ?? textLineHeightForScale(k),
  };
}

/** Total height of a text element, using DOM-measured height. */
export function textElHeight(el: TextEl): number {
  if (el.measuredH != null) return el.measuredH;
  return textLineHeightForScale(textScale(el));
}

/** Single-element AABB array for any element. */
export function elementFineAabbs(el: CanvasEl): CanvasAabb[] {
  const a = elementTightCanvasAabb(el);
  return a ? [a] : [];
}

/** True if canvas point (cx, cy) lies inside any of the fine AABBs of `el`. */
export function canvasPointHitsEl(cx: number, cy: number, el: CanvasEl): boolean {
  for (const box of elementFineAabbs(el)) {
    if (cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h) return true;
  }
  return false;
}

// ── Chat line wrapping utilities ─────────────────────────────────────────────

/** Max characters per chat line before word-wrapping. */
export const CHAT_LINE_MAX_CHARS = 60;

/** Word-wrap `text` into lines of at most `maxChars` characters. */
export function wrapTextIntoChatLines(text: string, maxChars: number = CHAT_LINE_MAX_CHARS): string[] {
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let breakAt = remaining.lastIndexOf(" ", maxChars);
    if (breakAt <= 0) breakAt = maxChars;
    lines.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }
  if (remaining.length > 0 || lines.length === 0) lines.push(remaining);
  return lines;
}

/** Line height used by chat elements (matches default text scale). */
export function chatLineHeight(): number {
  return textLineHeightForScale(DEFAULT_TEXT_SCALE);
}

/** Total content height of a ChatEl in canvas-space pixels. */
export function chatElContentHeight(el: ChatEl): number {
  if (el.measuredH != null && el.measuredH > 0) return el.measuredH;
  // Fallback: estimate from line count (before DOM measurement is available)
  const lh = chatLineHeight();
  let totalLines = 0;
  for (const msg of el.messages) {
    totalLines += wrapTextIntoChatLines(msg.content).length;
  }
  totalLines += Math.max(1, wrapTextIntoChatLines(el.inputText || "").length);
  return totalLines * lh;
}

/** Visible viewport height of a ChatEl (capped at CHAT_MAX_VISIBLE_LINES or user-set h). */
export function chatElViewportHeight(el: ChatEl): number {
  if (el.h != null && el.h > 0) return el.h;
  const lh = chatLineHeight();
  return Math.min(chatElContentHeight(el), CHAT_MAX_VISIBLE_LINES * lh);
}

/** Dynamic content width (excluding indicator margin) for a ChatEl: min(max(10ch, widest line), limit). */
export function chatElContentWidth(el: ChatEl): number {
  // If user has manually resized, use that width (el.w includes indicator margin)
  if (el.w != null && el.w > 0) return el.w - CHAT_INDICATOR_MARGIN;
  const k = DEFAULT_TEXT_SCALE;
  const minW = canvasTextWidth("nnnnnnnnnn", k); // 10 average chars
  const limit = CHAT_CONTAINER_WIDTH - CHAT_INDICATOR_MARGIN;
  let maxW = 0;
  for (const msg of el.messages) {
    for (const line of wrapTextIntoChatLines(msg.content)) {
      maxW = Math.max(maxW, canvasTextWidth(line, k));
    }
  }
  // Input text
  if (el.inputText) {
    for (const line of wrapTextIntoChatLines(el.inputText)) {
      maxW = Math.max(maxW, canvasTextWidth(line, k));
    }
  }
  return Math.min(Math.max(minW, maxW + 16), limit); // +16px breathing room
}

// ── Snap / grid boundary functions ───────────────────────────────────────────

/** Largest `k * stepPx` strictly left of `x` (15ch grid continues across negative and large canvas x). */
export function leftHorizontalSnapBoundaryBefore(x: number, stepPx: number): number {
  if (stepPx <= 0) return x;
  const k = Math.floor((x - 1e-6) / stepPx);
  return k * stepPx;
}

/** Smallest `k * stepPx` strictly right of `x`. */
export function nextHorizontalSnapBoundaryStrictlyRightOf(x: number, stepPx: number): number {
  if (stepPx <= 0) return x + 1;
  let k = Math.ceil((x + 1e-6) / stepPx);
  let nx = k * stepPx;
  if (nx <= x) nx += stepPx;
  return nx;
}

/** Nearer snap to the left: previous grid line vs `abutLeft` (right edge of left neighbor); smallest gap `curX - newX`. */
export function pickNearerLeftSnapX(curX: number, stepPx: number, abutLeft: number | null): number {
  const gridX = leftHorizontalSnapBoundaryBefore(curX, stepPx);
  const candidates: number[] = [gridX];
  if (abutLeft != null && abutLeft < curX - 0.5) candidates.push(abutLeft);
  let newX = candidates[0];
  let bestDist = curX - newX;
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    const d = curX - c;
    if (d < bestDist - 0.5 || (Math.abs(d - bestDist) < 0.5 && c > newX)) {
      newX = c;
      bestDist = d;
    }
  }
  return newX;
}

/** Nearer snap to the right: next grid line vs `abutRight` (left x so glyphs abut neighbor); smallest gap `newX - curX`. Null if no move. */
export function pickNearerRightSnapX(curX: number, stepPx: number, abutRight: number | null): number | null {
  const gridX = nextHorizontalSnapBoundaryStrictlyRightOf(curX, stepPx);
  const candidates: number[] = [];
  if (gridX > curX + 0.5) candidates.push(gridX);
  if (abutRight != null && abutRight > curX + 0.5) candidates.push(abutRight);
  if (candidates.length === 0) return null;
  let newX = candidates[0];
  let bestD = newX - curX;
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    const d = c - curX;
    if (d < bestD - 0.5 || (Math.abs(d - bestD) < 0.5 && c < newX)) {
      newX = c;
      bestD = d;
    }
  }
  return newX;
}

/** Nearer jump target strictly right of `fromX`: next 15ch grid line vs `neighborLeft` (left edge of right neighbor). */
export function pickJumpDestRight(fromX: number, neighborLeft: number | null, stepPx: number): number | null {
  const gridX = nextHorizontalSnapBoundaryStrictlyRightOf(fromX, stepPx);
  const candidates: number[] = [];
  if (gridX > fromX + 0.5) candidates.push(gridX);
  if (neighborLeft != null && neighborLeft > fromX + 0.5) candidates.push(neighborLeft);
  if (candidates.length === 0) return null;
  let best = candidates[0];
  let bestD = best - fromX;
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    const d = c - fromX;
    if (d < bestD - 0.5 || (Math.abs(d - bestD) < 0.5 && c > best)) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

// ── Tab jump targets ─────────────────────────────────────────────────────────

/** Tab ->: land at min(fromX + TAB_CHAR_STEPS*chW, next 15-grid line, left edge of right neighbor) strictly past `fromX`. */
export function tabJumpTargetRight(
  fromX: number,
  chW: number,
  gridStepChars: number,
  neighborLeft: number | null
): number {
  const gridStepPx = gridStepChars * chW;
  const cap = fromX + TAB_CHAR_STEPS * chW;
  let target = cap;
  const g = nextHorizontalSnapBoundaryStrictlyRightOf(fromX, gridStepPx);
  if (g > fromX + 0.5 && g < target) target = g;
  if (neighborLeft != null && neighborLeft > fromX + 0.5 && neighborLeft < target) target = neighborLeft;
  return target;
}

/** Shift+Tab <-: land at max(fromX - TAB_CHAR_STEPS*chW, previous 15-grid line, right edge of left neighbor) strictly left of `fromX`. */
export function tabJumpTargetLeft(
  fromX: number,
  chW: number,
  gridStepChars: number,
  abutLeft: number | null
): number {
  const gridStepPx = gridStepChars * chW;
  const cap = fromX - TAB_CHAR_STEPS * chW;
  let target = cap;
  const g = leftHorizontalSnapBoundaryBefore(fromX, gridStepPx);
  if (g < fromX - 0.5 && g > target) target = g;
  if (abutLeft != null && abutLeft < fromX - 0.5 && abutLeft > target) target = abutLeft;
  return target;
}

// ── Word-level caret movement ────────────────────────────────────────────────

/** Caret index at previous word start (Option+Left); whitespace runs are skipped. */
export function prevWordCaretIndex(s: string, caret: number): number {
  if (caret <= 0) return 0;
  let i = caret - 1;
  while (i >= 0 && /\s/.test(s[i])) i--;
  while (i > 0 && !/\s/.test(s[i - 1])) i--;
  return Math.max(0, i);
}

/** Caret index after skipping to end of next word / spaces (Option+Right). */
export function nextWordCaretIndex(s: string, caret: number): number {
  const n = s.length;
  if (caret >= n) return n;
  let i = caret;
  while (i < n && /\s/.test(s[i])) i++;
  while (i < n && !/\s/.test(s[i])) i++;
  return i;
}

// ── Text measurement ─────────────────────────────────────────────────────────

/** Horizontal extent of rendered text in canvas space (min width for empty / caret). */
const TAB_SPACES = "    "; // 4 spaces per tab for measurement

export function canvasTextWidth(text: string, scaleFactor = 1): number {
  const k = Math.max(MIN_TEXT_SCALE, scaleFactor);
  const minW = 8 * k;
  if (typeof document === "undefined") return minW;
  if (!_measureCanvas) _measureCanvas = document.createElement("canvas");
  const ctx = _measureCanvas.getContext("2d");
  if (!ctx) return Math.max(minW, text.length * 8 * k);
  ctx.font = textFontSpec();
  if (text.length === 0) return minW;
  const expanded = text.includes("\t") ? text.replaceAll("\t", TAB_SPACES) : text;
  return Math.max(minW, ctx.measureText(expanded).width * k);
}

/** Estimated rendered width of a single line, accounting for markdown prefix decorations
 *  (bullets, checkboxes, numbers, blockquotes) and heading em-scaling.
 *  Used as fallback when DOM measurements are not yet available. */
export function canvasRenderedLineWidth(line: string, k: number): number {
  const baseFontPx = TEXT_BASE_FONT_PX * k;
  const prefix = parseLinePrefix(line);

  // Prefix visual widths (em units matching globals.css .line-prefix-* rules)
  const PREFIX_EM: Record<string, number> = {
    bullet: 1.4,
    check:  1.5,
    number: 1.8,  // min-width 1.4em + padding-right 0.4em
    quote:  1.3,  // width 0.8em + margin-right 0.5em
  };

  let contentText: string;
  let prefixPx = 0;
  if (prefix.kind !== "none") {
    prefixPx = (PREFIX_EM[prefix.kind] ?? 0) * baseFontPx;
    contentText = prefix.rest;
  } else {
    contentText = line;
  }

  // Heading lines render at a larger em scale
  const level = headingLevel(contentText);
  const em = level > 0 ? headingEmScale(level) : 1;
  // For headings, strip the `# ` prefix from measurement (it's rendered as styled text, not raw)
  if (level > 0) {
    contentText = contentText.replace(/^#{1,6}\s/, "");
  }

  const textW = canvasTextWidth(contentText, k) * em;
  return Math.max(8 * k, prefixPx + textW);
}

export function approxCharWidthCanvas(): number {
  if (typeof document === "undefined") return 8;
  if (!_measureCanvas) _measureCanvas = document.createElement("canvas");
  const ctx = _measureCanvas.getContext("2d");
  if (!ctx) return 8;
  ctx.font = textFontSpec();
  const w = ctx.measureText("nnnnnnnnnn").width / 10;
  return w > 2 ? w : 8;
}

export function approxCharWidthCanvasForText(text: string): number {
  if (typeof document === "undefined") return 8;
  if (!_measureCanvas) _measureCanvas = document.createElement("canvas");
  const ctx = _measureCanvas.getContext("2d");
  if (!ctx) return 8;
  const sample = text.length > 0 ? text : "nnnnnnnnnn";
  ctx.font = textFontSpec();
  const w = ctx.measureText(sample).width / sample.length;
  return w > 2 ? w : 8;
}

export function textGlyphWidth(el: TextEl, text?: string): number {
  if (text != null) return canvasTextWidth(text, textScale(el));
  return el.measuredW ?? 8;
}

/** Width of the text element box, using DOM-measured width. */
export function canvasTextBoxWidth(el: TextEl): number {
  return Math.max(8, el.measuredW ?? 8);
}

/** Width for the editing textarea: based on raw text width (not markdown-rendered).
 *  Raw text includes syntax chars (#, **, etc.) so it's wider than rendered output. */
export function canvasTextEditWidth(el: TextEl): number {
  const k = textScale(el);
  const lines = el.text.split("\n");
  let maxW = 0;
  for (const line of lines) {
    const w = canvasTextWidth(line, k);
    if (w > maxW) maxW = w;
  }
  const minW = canvasTextWidth("", k);
  return Math.min(TEXT_LINE_MAX_WIDTH, Math.max(minW, maxW));
}

// ── Hit testing ──────────────────────────────────────────────────────────────

/** Click / loose hit-test right edge: measured width + small pad. */
export function canvasTextHitRightX(el: TextEl): number {
  return el.x + (el.measuredW ?? 8) + 6;
}

/** Same snapped row and focusable box rectangles overlap on x (matches what you see on canvas). */
export function canvasTextBoxesCollide(a: TextEl, b: TextEl): boolean {
  if (snapTextLineY(a.y) !== snapTextLineY(b.y)) return false;
  const eps = 0.5;
  const aR = a.x + canvasTextBoxWidth(a);
  const bR = b.x + canvasTextBoxWidth(b);
  return aR > b.x + eps && bR > a.x + eps;
}

export function canvasTextsSameRowSorted(elements: CanvasEl[], rowY: number): TextEl[] {
  const k = snapTextLineY(rowY);
  return elements
    .filter((e): e is TextEl => e.type === "text" && snapTextLineY(e.y) === k)
    .sort((a, b) => a.x - b.x || a.id.localeCompare(b.id));
}


export function leftTextNeighborOnRow(row: TextEl[], selfId: string): TextEl | null {
  const i = row.findIndex((t) => t.id === selfId);
  if (i <= 0) return null;
  return row[i - 1];
}

/**
 * Right edge of the nearest element to the left of `self` whose vertical AABB overlaps,
 * across ALL rows (not just same row). Returns null if nothing blocks to the left.
 */
export function nearestBlockingRightEdgeLeft(elements: CanvasEl[], self: CanvasEl): number | null {
  const selfA = elementTightCanvasAabb(self);
  if (!selfA) return null;
  let best: number | null = null;
  for (const el of elements) {
    if (el.id === self.id) continue;
    const a = elementTightCanvasAabb(el);
    if (!a) continue;
    // Must vertically overlap
    if (a.y >= selfA.y + selfA.h || a.y + a.h <= selfA.y) continue;
    // Must be to the left
    const rightEdge = a.x + a.w;
    if (rightEdge > selfA.x - 0.5) continue;
    if (best === null || rightEdge > best) best = rightEdge;
  }
  return best;
}

/**
 * Left edge of the nearest element to the right of `selfRightX` whose vertical AABB overlaps `self`,
 * across ALL rows. Returns null if nothing blocks to the right.
 */
export function nearestBlockingLeftEdgeRight(elements: CanvasEl[], self: CanvasEl, selfRightX: number): number | null {
  const selfA = elementTightCanvasAabb(self);
  if (!selfA) return null;
  let best: number | null = null;
  for (const el of elements) {
    if (el.id === self.id) continue;
    const a = elementTightCanvasAabb(el);
    if (!a) continue;
    if (a.y >= selfA.y + selfA.h || a.y + a.h <= selfA.y) continue;
    if (a.x < selfRightX + 0.5) continue;
    if (best === null || a.x < best) best = a.x;
  }
  return best;
}

/**
 * Find a cross-row text element whose right edge abuts (within tolerance) `selfLeftX`.
 * Returns the element or null. Only returns elements on a *different* snapped row.
 */
export function crossRowTextAbuttingLeft(elements: CanvasEl[], self: CanvasEl, selfLeftX: number, tolerance = 4): TextEl | null {
  const selfA = elementTightCanvasAabb(self);
  if (!selfA) return null;
  const selfSnap = self.type === "text" ? snapTextLineY((self as TextEl).y) : null;
  let best: TextEl | null = null;
  let bestDist = Infinity;
  for (const el of elements) {
    if (el.id === self.id || el.type !== "text") continue;
    const a = elementTightCanvasAabb(el);
    if (!a) continue;
    if (a.y >= selfA.y + selfA.h || a.y + a.h <= selfA.y) continue;
    if (selfSnap != null && snapTextLineY((el as TextEl).y) === selfSnap) continue;
    const rEdge = a.x + a.w;
    const dist = Math.abs(rEdge - selfLeftX);
    if (dist <= tolerance && dist < bestDist) {
      best = el as TextEl;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Find a cross-row text element whose left edge abuts (within tolerance) `selfRightX`.
 * Returns the element or null. Only returns elements on a *different* snapped row.
 */
export function crossRowTextAbuttingRight(elements: CanvasEl[], self: CanvasEl, selfRightX: number, tolerance = 4): TextEl | null {
  const selfA = elementTightCanvasAabb(self);
  if (!selfA) return null;
  const selfSnap = self.type === "text" ? snapTextLineY((self as TextEl).y) : null;
  let best: TextEl | null = null;
  let bestDist = Infinity;
  for (const el of elements) {
    if (el.id === self.id || el.type !== "text") continue;
    const a = elementTightCanvasAabb(el);
    if (!a) continue;
    if (a.y >= selfA.y + selfA.h || a.y + a.h <= selfA.y) continue;
    if (selfSnap != null && snapTextLineY((el as TextEl).y) === selfSnap) continue;
    const dist = Math.abs(a.x - selfRightX);
    if (dist <= tolerance && dist < bestDist) {
      best = el as TextEl;
      bestDist = dist;
    }
  }
  return best;
}

/** Canvas x of the caret after `caret` glyphs in `t` (glyph edges only, not hit slack). */
export function caretGlyphX(t: TextEl, caret: number): number {
  const i = Math.max(0, Math.min(caret, t.text.length));
  if (i === 0) return t.x;
  return t.x + textGlyphWidth(t, t.text.slice(0, i));
}

/** Rightmost text on the row whose glyph end is at or left of `columnX` (excluding `selfId`). */
export function leftTextNeighborBeforeColumn(row: TextEl[], selfId: string, columnX: number): TextEl | null {
  let best: TextEl | null = null;
  let bestRight = -Infinity;
  for (const t of row) {
    if (t.id === selfId) continue;
    const right = t.x + textGlyphWidth(t);
    if (right <= columnX + 0.5 && right > bestRight) {
      bestRight = right;
      best = t;
    }
  }
  return best;
}

/** Leftmost text on the row whose left edge is at or right of `fromX` (excluding `selfId`). */
export function rightTextFromColumn(row: TextEl[], selfId: string, fromX: number): TextEl | null {
  let best: TextEl | null = null;
  let bestX = Infinity;
  for (const t of row) {
    if (t.id === selfId) continue;
    if (t.x < fromX - 0.5) continue;
    if (t.x < bestX) {
      bestX = t.x;
      best = t;
    }
  }
  return best;
}

/** True if `columnX` lies on the glyph span [t.x, t.x + text width] (vertical moves: strict column, no hit slack). */
export function columnHitsGlyphSpan(columnX: number, t: TextEl): boolean {
  const R = t.x + textGlyphWidth(t);
  return columnX >= t.x && columnX <= R;
}

/**
 * True if `columnX` matches the start of `text` at `originX` or a glyph edge after 1..n characters.
 * Used for Option+Backspace vertical splice: avoid merging upward when the fragment sits under the *middle* of a
 * long line above (e.g. after Tab nudged x) -- only when aligned with the line's origin or a character boundary.
 */
export function columnAlignsWithGlyphBoundaryInText(
  originX: number,
  text: string,
  columnX: number,
  scaleFactor = 1,
  eps = 0.75
): boolean {
  if (Math.abs(columnX - originX) < eps) return true;
  for (let k = 1; k <= text.length; k++) {
    const bx = originX + canvasTextWidth(text.slice(0, k), scaleFactor);
    if (Math.abs(columnX - bx) < eps) return true;
  }
  return false;
}


// ── noteIdFromHash ───────────────────────────────────────────────────────────

export function noteIdFromHash(): string | null {
  if (typeof window === "undefined") return null;
  const raw = window.location.hash.replace(/^#/, "").trim();
  return raw.length > 0 ? raw : null;
}


// ── Erase within box ────────────────────────────────────────────────────────

/**
 * Erase characters within a selection rectangle from a text element.
 * Characters whose entire glyph span is fully within [boxLeftCanvas, boxRightCanvas] are deleted.
 * Returns the surviving text element(s), or empty array if nothing remains.
 */
export function eraseWithinBoxFully(
  el: TextEl,
  boxLeftCanvas: number,
  boxRightCanvas: number,
  boxTopCanvas: number = -Infinity,
  boxBottomCanvas: number = Infinity,
): TextEl[] {
  const text = el.text;
  const totalLen = text.length;
  if (totalLen === 0) return [];

  const left = Math.min(boxLeftCanvas, boxRightCanvas);
  const right = Math.max(boxLeftCanvas, boxRightCanvas);
  const top = Math.min(boxTopCanvas, boxBottomCanvas);
  const bottom = Math.max(boxTopCanvas, boxBottomCanvas);
  const eps = 0.75;
  const k = textScale(el);
  const lh = textLineHeightForScale(k);

  // Build per-character x positions and row index
  const xAt: number[] = new Array(totalLen + 1);
  const rowOf: number[] = new Array(totalLen);
  xAt[0] = el.x;
  let lineStart = 0;
  let row = 0;
  for (let i = 0; i < totalLen; i++) {
    rowOf[i] = row;
    if (text[i] === "\n") {
      xAt[i + 1] = el.x;
      lineStart = i + 1;
      row++;
    } else {
      xAt[i + 1] = el.x + canvasTextWidth(text.slice(lineStart, i + 1), k);
    }
  }

  const keepChar: boolean[] = new Array(totalLen);
  for (let i = 0; i < totalLen; i++) {
    if (text[i] === "\n") {
      keepChar[i] = true;
      continue;
    }
    // Check if this row is within the vertical selection bounds
    const rowTop = el.y + rowOf[i] * lh;
    const rowBottom = rowTop + lh;
    const rowInYRange = rowBottom > top - eps && rowTop < bottom + eps;
    if (!rowInYRange) {
      keepChar[i] = true;
      continue;
    }
    const chStart = xAt[i];
    const chEnd = xAt[i + 1];
    const fullyInside = chStart >= left - eps && chEnd <= right + eps;
    keepChar[i] = !fullyInside;
  }

  let kept = "";
  for (let i = 0; i < totalLen; i++) {
    if (keepChar[i]) kept += text[i];
  }
  kept = kept.replace(/\n{2,}/g, "\n").replace(/^\n+|\n+$/g, "");
  if (!kept) return [];

  let newX = el.x;
  for (let i = 0; i < totalLen; i++) {
    if (text[i] === "\n") break;
    if (keepChar[i]) {
      newX = xAt[i];
      break;
    }
  }

  return [{ ...el, x: newX, text: kept }];
}

// ── Text column / row queries ────────────────────────────────────────────────

/** Text on `rowTopY` whose glyph span contains `columnX` (straight vertical line only). */
export function textGlyphColumnOnRow(elements: CanvasEl[], columnX: number, rowTopY: number): TextEl | undefined {
  const k = snapTextLineY(rowTopY);
  return canvasTextsSameRowSorted(elements, k).find((t) => columnHitsGlyphSpan(columnX, t));
}

/** Find any text element whose AABB covers the point (columnX, pointY), excluding `excludeId`. */
export function textAtCanvasPoint(elements: CanvasEl[], columnX: number, pointY: number, excludeId?: string): TextEl | null {
  let best: TextEl | null = null;
  let bestArea = Infinity;
  for (const el of elements) {
    if (el.type !== "text") continue;
    if (excludeId && el.id === excludeId) continue;
    const a = elementTightCanvasAabb(el);
    if (!a) continue;
    if (columnX < a.x || columnX > a.x + a.w) continue;
    if (pointY < a.y || pointY > a.y + a.h) continue;
    // Prefer smallest (most specific) element at this point
    const area = a.w * a.h;
    if (area < bestArea) { best = el as TextEl; bestArea = area; }
  }
  return best;
}

/** Text fragments strictly below `minRowY` (snapped) whose glyph span contains `columnX`. */
export function textsBelowRowHittingColumn(elements: CanvasEl[], columnX: number, minRowY: number): TextEl[] {
  return elements.filter(
    (e): e is TextEl =>
      e.type === "text" && snapTextLineY(e.y) > minRowY && columnHitsGlyphSpan(columnX, e)
  );
}

/** Nearest horizontal distance from `columnX` to the glyph span [t.x, right]. */
export function horizontalDistToGlyphSpan(columnX: number, t: TextEl): number {
  const L = t.x;
  const R = t.x + textGlyphWidth(t);
  if (columnX < L) return L - columnX;
  if (columnX > R) return columnX - R;
  return 0;
}

/**
 * After Enter shifts text: among candidates, use the topmost row, then the box under the caret column
 * (glyph hit, else nearest span). Avoids always snapping to the leftmost box on that y.
 */
export function pickShiftedTextNearCaretColumn(cands: TextEl[], columnX: number): TextEl | undefined {
  if (cands.length === 0) return undefined;
  let topY = Infinity;
  for (const t of cands) {
    const y = snapTextLineY(t.y);
    if (y < topY) topY = y;
  }
  const row = cands.filter((t) => snapTextLineY(t.y) === topY);
  const hit = row.find((t) => columnHitsGlyphSpan(columnX, t));
  if (hit) return hit;
  let best = row[0];
  let bestD = horizontalDistToGlyphSpan(columnX, best);
  for (let i = 1; i < row.length; i++) {
    const t = row[i];
    const d = horizontalDistToGlyphSpan(columnX, t);
    if (d < bestD || (d === bestD && t.x < best.x)) {
      best = t;
      bestD = d;
    }
  }
  return best;
}

/**
 * Which text on snapped row `rowTopY` owns horizontal `columnX`.
 * Glyph span wins over textarea slack; if multiple glyphs overlap (rare), prefer last in `elements` (top paint).
 * Slack-only hits prefer the rightmost box with `x <= columnX` so a wide left box does not swallow clicks on the right.
 */
export function textHitForColumnOnRow(elements: CanvasEl[], columnX: number, rowTopY: number): TextEl | undefined {
  const rowY = snapTextLineY(rowTopY);
  let glyphBestEl: TextEl | undefined;
  let glyphBestIdx = -1;
  elements.forEach((e, i) => {
    if (e.type !== "text" || snapTextLineY(e.y) !== rowY) return;
    if (!columnHitsGlyphSpan(columnX, e)) return;
    if (i > glyphBestIdx) {
      glyphBestIdx = i;
      glyphBestEl = e;
    }
  });
  if (glyphBestEl) return glyphBestEl;

  const slackMatches: TextEl[] = [];
  elements.forEach((e) => {
    if (e.type !== "text" || snapTextLineY(e.y) !== rowY) return;
    if (columnX >= e.x && columnX <= canvasTextHitRightX(e)) slackMatches.push(e);
  });
  if (slackMatches.length === 0) return undefined;
  const leftOfClick = slackMatches.filter((t) => t.x <= columnX + 0.5);
  if (leftOfClick.length) return leftOfClick.reduce((a, b) => (a.x >= b.x ? a : b));
  return slackMatches.reduce((a, b) => (a.x <= b.x ? a : b));
}

/** Caret index in `text` if the caret were at canvas x `targetX` (glyphs start at `originX`). */
export function canvasCaretIndexAtX(text: string, originX: number, targetX: number, scaleFactor = 1): number {
  if (targetX <= originX) return 0;
  if (typeof document === "undefined") return text.length;
  if (!_measureCanvas) _measureCanvas = document.createElement("canvas");
  const ctx = _measureCanvas.getContext("2d");
  if (!ctx) return text.length;
  ctx.font = textFontSpec();
  const k = Math.max(MIN_TEXT_SCALE, scaleFactor);
  const endX = originX + canvasTextWidth(text, k);
  if (targetX >= endX) return text.length;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const w = ctx.measureText(text.slice(0, mid)).width * k;
    if (originX + w <= targetX) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Given a multi-line text element and a canvas point, compute the global caret index. */
export function canvasCaretIndexAtPoint(el: TextEl, cx: number, cy: number): number {
  const lines = el.text.split("\n");
  const k = textScale(el);
  const baseY = snapTextLineY(el.y);
  const offsets = textLineYOffsets(lines, k);

  // Find which line cy falls into using accumulated offsets
  let lineIdx = lines.length - 1;
  const relY = cy - baseY;
  for (let i = 0; i < lines.length; i++) {
    if (relY < offsets[i + 1]) { lineIdx = i; break; }
  }
  lineIdx = Math.max(0, Math.min(lineIdx, lines.length - 1));

  // Compute caret within that line
  const caretInLine = canvasCaretIndexAtX(lines[lineIdx], el.x, cx, k);

  // Convert to global caret index
  let globalIdx = 0;
  for (let i = 0; i < lineIdx; i++) globalIdx += lines[i].length + 1; // +1 for \n
  return globalIdx + caretInLine;
}

// ── Inline markdown stripping for rendered-text hit testing ──────────────────

/** Inline markers sorted longest-first so `**` is matched before `*`. */
const INLINE_MARKERS = ["**", "~~", "==", "*", "`"];

/**
 * Strip inline markdown from a line and return the visible text plus a mapping
 * from each visible character index to its raw string index.
 * Also strips heading prefix (`# `) since it is not rendered.
 * Does NOT strip list prefixes — those become decoration with a known px width.
 */
export function stripInlineMarkdown(line: string): { visible: string; toRaw: number[] } {
  // Strip heading prefix first
  const hMatch = /^(#{1,6})\s/.exec(line);
  let src = hMatch ? line.slice(hMatch[0].length) : line;
  const rawOffset = hMatch ? hMatch[0].length : 0;

  const visible: string[] = [];
  const toRaw: number[] = [];
  let i = 0;

  while (i < src.length) {
    let matched = false;
    for (const m of INLINE_MARKERS) {
      if (src.startsWith(m, i)) {
        // Find closing marker — require non-empty inner text
        const close = src.indexOf(m, i + m.length);
        if (close !== -1 && close > i + m.length) {
          // Skip opening marker
          const inner = src.slice(i + m.length, close);
          for (let j = 0; j < inner.length; j++) {
            visible.push(inner[j]);
            toRaw.push(rawOffset + i + m.length + j);
          }
          i = close + m.length; // skip closing marker
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      visible.push(src[i]);
      toRaw.push(rawOffset + i);
      i++;
    }
  }
  return { visible: visible.join(""), toRaw };
}

export function textCharsInCanvasBox(
  el: TextEl,
  box: { left: number; top: number; right: number; bottom: number },
): { lineIdx: number; startChar: number; endChar: number }[] {
  const text = el.text;
  if (text.length === 0) return [];

  const bLeft = Math.min(box.left, box.right);
  const bRight = Math.max(box.left, box.right);
  const bTop = Math.min(box.top, box.bottom);
  const bBottom = Math.max(box.top, box.bottom);
  const eps = 0.75;
  const k = textScale(el);

  const lines = text.split("\n");
  const yOffsets = textLineYOffsets(lines, k);
  const baseY = snapTextLineY(el.y);
  const result: { lineIdx: number; startChar: number; endChar: number }[] = [];

  for (let li = 0; li < lines.length; li++) {
    const rawLine = lines[li];
    if (rawLine.length === 0) continue;

    // Vertical check
    const lineTop = baseY + yOffsets[li];
    const lineBot = baseY + yOffsets[li + 1];
    if (lineBot <= bTop - eps || lineTop >= bBottom + eps) continue;

    const len = rawLine.length;

    // Build per-character x positions from raw text
    const xAt: number[] = new Array(len + 1);
    xAt[0] = el.x;
    for (let ci = 0; ci < len; ci++) {
      xAt[ci + 1] = el.x + canvasTextWidth(rawLine.slice(0, ci + 1), k);
    }

    // Find contiguous runs of characters that overlap the box
    let ci = 0;
    while (ci < len) {
      while (ci < len && !(xAt[ci + 1] > bLeft - eps && xAt[ci] < bRight + eps)) ci++;
      if (ci >= len) break;
      const s = ci;
      while (ci < len && xAt[ci + 1] > bLeft - eps && xAt[ci] < bRight + eps) ci++;
      result.push({ lineIdx: li, startChar: s, endChar: ci });
    }
  }
  return result;
}

// ── Merge overlapping text ───────────────────────────────────────────────────

/**
 * Repeatedly merge any two text boxes on the same row whose focusable widths collide (any pair, not only neighbors).
 * When `editingId` is set, colliding pairs of (empty, that element) merge first so placeholders absorb into the active box.
 * String order is always left-by-x then right-by-x; origin rule unchanged (left anchor when left has text).
 * `editingCaret` is the cursor index inside the element `editingId` (null -> use end of that segment when it merges).
 */
export function mergeOverlappingCanvasText(
  textEls: TextEl[],
  editingId: string | null,
  editingCaret: number | null = null
): { merged: TextEl[]; caretFocus: { id: string; caret: number } | null } {
  let pool = textEls.map((e) => ({ ...e, y: snapTextLineY(e.y) }));
  let caretFocus: { id: string; caret: number } | null = null;
  let editId = editingId;
  let editCaret = editingCaret;

  while (true) {
    let left: TextEl | undefined;
    let right: TextEl | undefined;
    // Prefer absorbing empty hit-boxes into the edited / incoming element (stable caret & no stray blanks).
    if (editId) {
      outerPrefer: for (let i = 0; i < pool.length; i++) {
        for (let j = i + 1; j < pool.length; j++) {
          const A = pool[i];
          const B = pool[j];
          if (!canvasTextBoxesCollide(A, B)) continue;
          if (textScale(A) !== textScale(B)) continue;
          const aEmpty = isTextBlank(A.text);
          const bEmpty = isTextBlank(B.text);
          if (aEmpty === bEmpty) continue;
          const nonEmpty = aEmpty ? B : A;
          if (nonEmpty.id !== editId) continue;
          if (A.x <= B.x) {
            left = A;
            right = B;
          } else {
            left = B;
            right = A;
          }
          break outerPrefer;
        }
      }
    }
    if (!left || !right) {
      outer: for (let i = 0; i < pool.length; i++) {
        for (let j = i + 1; j < pool.length; j++) {
          const A = pool[i];
          const B = pool[j];
          if (!canvasTextBoxesCollide(A, B)) continue;
          if (textScale(A) !== textScale(B)) continue;
          if (A.x <= B.x) {
            left = A;
            right = B;
          } else {
            left = B;
            right = A;
          }
          break outer;
        }
      }
    }
    if (!left || !right) break;
    const Lm = left;
    const Rm = right;

    const mergedX = isTextBlank(Lm.text) ? Rm.x : Lm.x;
    const mergedHtml = (Lm.html ?? `<p>${Lm.text}</p>`) + (Rm.html ?? `<p>${Rm.text}</p>`);
    const merged: TextEl = {
      ...Lm,
      text: Lm.text + Rm.text,
      html: mergedHtml,
      x: mergedX,
      y: snapTextLineY(Lm.y),
    };
    if (editId === Lm.id || editId === Rm.id) {
      const jL = Lm.text.length;
      let newCaret: number;
      if (editId === Lm.id) {
        const c = editCaret != null ? editCaret : Lm.text.length;
        newCaret = Math.max(0, Math.min(c, Lm.text.length));
      } else {
        const c = editCaret != null ? editCaret : Rm.text.length;
        newCaret = jL + Math.max(0, Math.min(c, Rm.text.length));
      }
      editId = merged.id;
      editCaret = newCaret;
      caretFocus = { id: merged.id, caret: newCaret };
    }
    pool = pool.filter((t) => t.id !== Lm.id && t.id !== Rm.id);
    pool.push(merged);
  }

  return { merged: pool, caretFocus };
}

// ── Element AABB / transforms ────────────────────────────────────────────────

/** Selection / marquee hit-test bounds in canvas space (text uses glyph width only, not textarea slack). */
export function elementTightCanvasAabb(el: CanvasEl): CanvasAabb | null {
  switch (el.type) {
    case "text":
      return textElementAabb(el as TextEl);

    case "image":
      return { x: el.x, y: el.y, w: el.w, h: el.h };
    case "shape":
      return { x: el.x, y: el.y, w: el.w, h: el.h };
    case "draw": {
      const parts = el.pts.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of parts) {
        const [xs, ys] = p.split(",").map(Number);
        if (!Number.isFinite(xs) || !Number.isFinite(ys)) continue;
        minX = Math.min(minX, xs);
        minY = Math.min(minY, ys);
        maxX = Math.max(maxX, xs);
        maxY = Math.max(maxY, ys);
      }
      if (!Number.isFinite(minX)) return null;
      const pad = 3;
      return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
    }
    case "arrow": {
      const minX = Math.min(el.x1, el.x2);
      const maxX = Math.max(el.x1, el.x2);
      const minY = Math.min(el.y1, el.y2);
      const maxY = Math.max(el.y1, el.y2);
      const pad = 6;
      return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
    }
    case "chart":
      return { x: el.x, y: el.y, w: el.w, h: el.h };
    case "math":
      return { x: el.x, y: el.y, w: el.measuredW ?? 200, h: el.measuredH ?? 48 };
    case "chat":
      return { x: el.x - CHAT_INDICATOR_MARGIN, y: snapTextLineY(el.y), w: chatElContentWidth(el) + CHAT_INDICATOR_MARGIN, h: chatElViewportHeight(el) };
    case "noteRef":
      return { x: el.x, y: el.y, w: NOTE_REF_W, h: NOTE_REF_H };
    case "graph":
      return { x: el.x, y: el.y, w: el.w, h: el.h };
    case "pdf":
      return { x: el.x, y: el.y, w: el.w, h: el.h };
    case "embed":
      return { x: el.x, y: el.y, w: el.w, h: el.h };
    case "table":
      return { x: el.x, y: el.y, w: el.w, h: el.h };
    case "checklist":
      return { x: el.x, y: el.y, w: el.w, h: el.h };
    default:
      return null;
  }
}

/** Read an element's z-level (0 if not set). Only shape/draw/image carry a z
 *  field today, but the helper is safe to call on any element. */
export function getZ(el: CanvasEl): number {
  return (el as { z?: number }).z ?? 0;
}

/** Returns the id of the top-most element whose fine AABBs contain (cx, cy),
 *  or null. "Top-most" = highest z, with array-order descending as tie-break
 *  (later-added = on top for elements at the same z). */
export function canvasPointHitsSingleEl(cx: number, cy: number, elements: CanvasEl[], excludeTypes?: Set<string>): string | null {
  let best: { id: string; z: number; idx: number } | null = null;
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (excludeTypes && excludeTypes.has(el.type)) continue;
    if (!canvasPointHitsEl(cx, cy, el)) continue;
    const z = getZ(el);
    if (!best || z > best.z || (z === best.z && i > best.idx)) {
      best = { id: el.id, z, idx: i };
    }
  }
  return best?.id ?? null;
}

/** True if canvas point lies inside the fine AABBs of any selected element. */
export function canvasPointHitsAnySelectedEl(
  cx: number,
  cy: number,
  elements: CanvasEl[],
  selected: Set<string>,
  excludeTypes?: Set<string>
): boolean {
  for (const el of elements) {
    if (!selected.has(el.id)) continue;
    if (excludeTypes && excludeTypes.has(el.type)) continue;
    if (canvasPointHitsEl(cx, cy, el)) return true;
  }
  return false;
}

export function snapCanvasTextXToNearestGrid(x: number, chW: number): number {
  const stepPx = OPTION_BACKSPACE_CHAR_STEPS * chW;
  if (stepPx <= 0) return x;
  return Math.round(x / stepPx) * stepPx;
}

export function translateCanvasElBy(el: CanvasEl, dx: number, dy: number): CanvasEl {
  switch (el.type) {
    case "text":
      return { ...el, x: el.x + dx, y: el.y + dy };
    case "image":
      return { ...el, x: el.x + dx, y: el.y + dy };
    case "shape":
      return { ...el, x: el.x + dx, y: el.y + dy };
    case "arrow":
      return {
        ...el,
        x1: el.x1 + dx,
        y1: el.y1 + dy,
        x2: el.x2 + dx,
        y2: el.y2 + dy,
      };
    case "draw": {
      const parts = el.pts.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) return el;
      const next = parts
        .map((p) => {
          const [xs, ys] = p.split(",").map(Number);
          if (!Number.isFinite(xs) || !Number.isFinite(ys)) return p;
          return `${+(xs + dx).toFixed(2)},${+(ys + dy).toFixed(2)}`;
        })
        .join(" ");
      return { ...el, pts: next };
    }
    case "chart":
      return { ...el, x: el.x + dx, y: el.y + dy };
    case "math":
      return { ...el, x: el.x + dx, y: el.y + dy };
    case "chat":
      return { ...el, x: el.x + dx, y: el.y + dy };
    case "noteRef":
      return { ...el, x: el.x + dx, y: el.y + dy };
    case "graph":
      return { ...el, x: el.x + dx, y: el.y + dy };
    case "pdf":
      return { ...el, x: el.x + dx, y: el.y + dy };
    case "embed":
      return { ...el, x: el.x + dx, y: el.y + dy };
    case "table":
      return { ...el, x: el.x + dx, y: el.y + dy };
    case "checklist":
      return { ...el, x: el.x + dx, y: el.y + dy };
    default:
      return el;
  }
}

/**
 * After a move: snap text-like boxes to the 15ch X grid and text line Y grid.
 * Draw paths and arrows stay at translated coordinates -- they must not use the text grid or strokes deform.
 */
export function snapMovedCanvasEl(el: CanvasEl, chW: number): CanvasEl {
  const gx = (x: number) => snapCanvasTextXToNearestGrid(x, chW);
  const gy = (y: number) => snapTextLineY(y);
  switch (el.type) {
    case "text":
      return { ...el, x: gx(el.x), y: gy(el.y) };
    case "chat":
      return { ...el, x: gx(el.x), y: gy(el.y) };
    case "noteRef":
      return { ...el, x: gx(el.x), y: gy(el.y) };
    case "pdf":
      return { ...el, x: gx(el.x), y: gy(el.y) };
    case "embed":
      return { ...el, x: gx(el.x), y: gy(el.y) };
    case "table":
      return { ...el, x: gx(el.x), y: gy(el.y) };
    case "checklist":
      return { ...el, x: gx(el.x), y: gy(el.y) };
    case "image":
    case "shape":
    case "arrow":
    case "draw":
      return el;
    default:
      return el;
  }
}

export function canvasAabbToClientScreen(
  r: CanvasAabb,
  vpScreen: DOMRect,
  off: { x: number; y: number },
  scale: number
): { left: number; top: number; right: number; bottom: number } {
  const x1 = vpScreen.left + off.x + r.x * scale;
  const y1 = vpScreen.top + off.y + r.y * scale;
  const x2 = vpScreen.left + off.x + (r.x + r.w) * scale;
  const y2 = vpScreen.top + off.y + (r.y + r.h) * scale;
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    right: Math.max(x1, x2),
    bottom: Math.max(y1, y2),
  };
}

export function idsHitByMarqueeScreenBox(
  note: NoteItem,
  screenBox: { left: number; top: number; right: number; bottom: number },
  vpScreen: DOMRect,
  off: { x: number; y: number },
  scale: number,
  excludeTypes?: Set<string>
): string[] {
  const hits: string[] = [];
  for (const el of note.elements) {
    if (excludeTypes && excludeTypes.has(el.type)) continue;
    const boxes = elementFineAabbs(el);
    if (boxes.length === 0) continue;
    let hit = false;
    for (const a of boxes) {
      const br = canvasAabbToClientScreen(a, vpScreen, off, scale);
      if (clientRectsOverlap(screenBox, br)) { hit = true; break; }
    }
    if (hit) hits.push(el.id);
  }
  return hits;
}

export function canvasAABBsTouchOrOverlap(a: CanvasAabb, b: CanvasAabb, eps = 0): boolean {
  const ax2 = a.x + a.w, ay2 = a.y + a.h;
  const bx2 = b.x + b.w, by2 = b.y + b.h;
  return !(ax2 < b.x - eps || a.x > bx2 + eps || ay2 < b.y - eps || a.y > by2 + eps);
}

// ── AI free-spot placement ─────────────────────────────────────────────────────

/** Find the first free vertical slot in the AI content column (x: AI_COL_X, width: w).
 *  Scans downward past all existing elements that overlap the column horizontally. */
export function findFreeSpotInAiColumn(elements: CanvasEl[], h: number, w = AI_COL_W): { x: number; y: number } {
  const colRight = AI_COL_X + w;
  const blockers = elements
    .map(elementTightCanvasAabb)
    .filter((b): b is CanvasAabb => b !== null && b.x < colRight && b.x + b.w > AI_COL_X);

  if (blockers.length === 0) return { x: AI_COL_X, y: 80 };

  let candidateY = blockers.reduce((m, b) => Math.max(m, b.y + b.h), 80) + AI_COL_MARGIN;
  for (let i = 0; i < 200; i++) {
    const slotBot = candidateY + h;
    const blocker = blockers.find(b => b.y < slotBot + AI_COL_MARGIN && b.y + b.h > candidateY - AI_COL_MARGIN);
    if (!blocker) break;
    candidateY = blocker.y + blocker.h + AI_COL_MARGIN;
  }
  return { x: AI_COL_X, y: candidateY };
}

export function unionCanvasAabb(a: CanvasAabb, b: CanvasAabb): CanvasAabb {
  const x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.w, b.x + b.w), y2 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}


/** Union selected items that touch or overlap into one outline each (canvas space). */
export function mergeTouchingCanvasAABBs(rects: CanvasAabb[]): CanvasAabb[] {
  let pool = rects.slice();
  let changed = true;
  while (changed && pool.length > 1) {
    changed = false;
    outer: for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        if (canvasAABBsTouchOrOverlap(pool[i], pool[j])) {
          const u = unionCanvasAabb(pool[i], pool[j]);
          pool = [...pool.slice(0, i), ...pool.slice(i + 1, j), ...pool.slice(j + 1), u];
          changed = true;
          break outer;
        }
      }
    }
  }
  return pool;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function makeNote(noteNumber: number): NoteItem {
  return { id: crypto.randomUUID(), title: `Note #${noteNumber}`, elements: [], updatedAt: Date.now() };
}

export function autoResize(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/** Target is (inside) a native HTML form control that should handle its own click. */
export function isNativeFormControl(el: HTMLElement) {
  return !!el.closest("textarea, input, button, a");
}

/** Target is (inside) a canvas element wrapper ([data-el]) — e.g. a table or
 *  checklist cell. Such descendants typically manage their own interaction. */
export function isCanvasElement(el: HTMLElement) {
  return !!el.closest("[data-el]");
}

/** Either a native form control or a canvas-element descendant — i.e. the
 *  click should be deferred to something other than the raw canvas handler. */
export function isInteractive(el: HTMLElement) {
  return isNativeFormControl(el) || isCanvasElement(el);
}

export function clientRectsOverlap(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number }
): boolean {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

export function toCanvas(
  clientX: number, clientY: number,
  rect: DOMRect, offset: { x: number; y: number }, scale: number
) {
  return { x: (clientX - rect.left - offset.x) / scale, y: (clientY - rect.top - offset.y) / scale };
}

/** Hit-test canvas text: glyph-first, then slack (same rules as `textHitForColumnOnRow` for a row). */
export function textHitAt(elements: CanvasEl[], cx: number, cy: number): TextEl | undefined {
  let glyphBestEl: TextEl | undefined;
  let glyphBestIdx = -1;
  elements.forEach((e, i) => {
    if (e.type !== "text") return;
    const box = textElementAabb(e);
    if (cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h) {
      if (i > glyphBestIdx) { glyphBestIdx = i; glyphBestEl = e; }
    }
  });
  if (glyphBestEl) return glyphBestEl;

  // Slack match: extend hit area slightly to the right
  const slackMatches: TextEl[] = [];
  elements.forEach((e) => {
    if (e.type !== "text") return;
    const box = textElementAabb(e);
    const k = textScale(e);
    const slack = approxCharWidthCanvasForText(e.text) * 0.75 * k;
    if (cx >= box.x && cx <= box.x + box.w + slack && cy >= box.y && cy <= box.y + box.h) {
      slackMatches.push(e);
    }
  });
  if (slackMatches.length === 0) return undefined;
  const leftOfClick = slackMatches.filter((t) => t.x <= cx + 0.5);
  if (leftOfClick.length) return leftOfClick.reduce((a, b) => (a.x >= b.x ? a : b));
  return slackMatches.reduce((a, b) => (a.x <= b.x ? a : b));
}

export function focusTextareaById(id: string) {
  (document.getElementById(`el-${id}`) as HTMLTextAreaElement | null)?.focus({ preventScroll: true });
}

// ── ChartBox ──────────────────────────────────────────────────────────────

export const ChartBox = memo(function ChartBox({ chartType, labels, datasets }: { chartType: ChartType; labels: string[]; datasets: ChartDataset[] }) {
  const isScatter = chartType === "scatter";
  const isMulti = datasets.length > 1;
  const isPie = chartType === "pie" || chartType === "doughnut" || chartType === "polarArea";

  const chartDatasets = datasets.map((ds, i) => {
    const color = CHART_PALETTE[i % CHART_PALETTE.length];
    const solidColor = color.replace("0.8", "1");
    const scatterData = isScatter ? labels.map((l, j) => ({ x: Number(l) || j, y: ds.values[j] })) : null;
    return {
      label: ds.label,
      data: isScatter ? scatterData : ds.values,
      backgroundColor: isPie ? CHART_PALETTE.slice(0, Math.max(ds.values.length, 1)) : color,
      borderColor: isPie ? CHART_PALETTE.slice(0, Math.max(ds.values.length, 1)).map((c) => c.replace("0.8", "1")) : solidColor,
      borderWidth: chartType === "line" ? 2 : 1,
      fill: chartType === "radar" ? true : chartType === "line" ? !isMulti : false,
      pointRadius: chartType === "scatter" ? 6 : chartType === "line" ? 3 : undefined,
      tension: chartType === "line" ? 0.4 : undefined,
    };
  });

  const baseData = { labels, datasets: chartDatasets };
  const commonOptions = { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: CHART_TICK_COLOR } } } };
  const scaleOptions = { scales: { y: { beginAtZero: true, ticks: { color: CHART_TICK_COLOR }, grid: { color: CHART_GRID_COLOR } }, x: { ticks: { color: CHART_TICK_COLOR }, grid: { color: CHART_GRID_COLOR } } } };
  const radialOptions = { scales: { r: { ticks: { color: CHART_TICK_COLOR }, grid: { color: CHART_GRID_COLOR } } } };

  return (
    <div className="p-4 flex flex-col h-full">
      <div className="text-[10px] font-bold mb-3 capitalize text-[#acabaa] uppercase tracking-[0.1em] font-lexend">{chartType} chart</div>
      <div className="flex-1 relative">
        {(chartType === "bar" || chartType === "histogram") && <Bar data={baseData} options={{ ...commonOptions, ...scaleOptions } as any} />}
        {chartType === "line" && <Line data={baseData} options={{ ...commonOptions, ...scaleOptions } as any} />}
        {chartType === "scatter" && <Scatter data={baseData} options={{ ...commonOptions, ...scaleOptions } as any} />}
        {chartType === "pie" && <Pie data={baseData} options={commonOptions as any} />}
        {chartType === "doughnut" && <Doughnut data={baseData} options={commonOptions as any} />}
        {chartType === "radar" && <Radar data={baseData} options={{ ...commonOptions, ...radialOptions } as any} />}
        {chartType === "polarArea" && <PolarArea data={baseData} options={{ ...commonOptions, ...radialOptions } as any} />}
      </div>
    </div>
  );
});

// ── Mid-level abstractions ──────────────────────────────────────────────────

/** Filter text/non-text → merge overlapping text → recombine. */
export function mergeElements(
  elements: CanvasEl[],
  focusId: string,
  caretPos?: number | null
): { elements: CanvasEl[]; caretFocus: { id: string; caret: number } | null } {
  const texts = elements.filter((e): e is TextEl => e.type === "text");
  const other = elements.filter((e) => e.type !== "text");
  const { merged, caretFocus } = mergeOverlappingCanvasText(texts, focusId, caretPos ?? null);
  return { elements: [...other, ...merged] as CanvasEl[], caretFocus };
}


// ── Placement Engine ────────────────────────────────────────────────────────

const DEFAULT_EXCLUDE_TYPES: CanvasEl["type"][] = ["draw", "arrow", "shape"];

/** Preset: horizontal text push for typing/tab. Single sweep, abut chain. */
export function horizontalTextPush(dir: 1 | -1): ResolveOpts {
  return {
    axis: "horizontal",
    quantum: { kind: "abut" },
    excludeTypes: DEFAULT_EXCLUDE_TYPES,
    direction: dir,
    maxPasses: 1,
  };
}

/** Preset: vertical push for Enter/newline. Push down by line height, skip empty text. */
export function verticalEnterPush(): ResolveOpts {
  return {
    axis: "vertical",
    quantum: { kind: "lineHeight" },
    excludeTypes: DEFAULT_EXCLUDE_TYPES,
    direction: 1,
    maxPasses: 15,
    skip: (el) => el.type === "text" && isTextBlank((el as TextEl).text),
  };
}

/** Preset: omnidirectional push for drag/resize. Shortest escape axis. */
export function dragResolvePush(): ResolveOpts {
  return {
    axis: "shortest",
    quantum: { kind: "exact" },
    excludeTypes: DEFAULT_EXCLUDE_TYPES,
    maxPasses: 15,
  };
}

/**
 * Unified collision resolution engine.
 *
 * Supports 3 modes via axis + quantum:
 * - axis:"shortest", quantum:"exact"      — drag/resize (push along shortest escape)
 * - axis:"horizontal", quantum:"abut"     — typing (chain text boxes edge-to-edge)
 * - axis:"vertical", quantum:"lineHeight" — enter/newline (push down by line height)
 */
export function resolveCollisions(
  elements: CanvasEl[],
  anchorIds: Set<string>,
  opts: ResolveOpts
): CanvasEl[] {
  // ── Ghost-mode pass-through ────────────────────────────────────────────────
  // Images flagged `noPush` are invisible to the collision engine: they don't
  // push others and others don't push them. Strip them before resolving, then
  // merge their unchanged copies back into the result in original order.
  const ghostIds = new Set<string>();
  for (const el of elements) {
    if (el.type === "image" && (el as ImageEl).noPush) ghostIds.add(el.id);
  }
  if (ghostIds.size > 0) {
    const active = elements.filter((el) => !ghostIds.has(el.id));
    // Must also drop ghosted ids from anchors — the engine dereferences each
    // anchor in `elMap`, which no longer contains them.
    const activeAnchors = new Set<string>();
    for (const id of anchorIds) if (!ghostIds.has(id)) activeAnchors.add(id);
    const resolved = resolveCollisions(active, activeAnchors, opts);
    const resolvedMap = new Map(resolved.map((el) => [el.id, el]));
    return elements.map((el) => resolvedMap.get(el.id) ?? el);
  }

  // ── Hierarchical anchor resolution (default) ───────────────────────────────
  if (!opts.flatResolve) {
    const baseOpts: ResolveOpts = { ...opts, flatResolve: true };

    // Master map tracks resolved positions across all phases
    const master = new Map<string, CanvasEl>();
    for (const el of elements) master.set(el.id, el);

    // Phase 1 — Anchored elements first (resolve among themselves + nearby)
    const allElements = elements.map(el => master.get(el.id) ?? el);
    return resolveCollisions(allElements, anchorIds, baseOpts);
  }

  // ── Standard (flat) collision resolution ──────────────────────────────────
  const maxPasses = opts.maxPasses ?? 15;
  const excludeSet = new Set(opts.excludeTypes ?? DEFAULT_EXCLUDE_TYPES);

  const elMap = new Map<string, CanvasEl>();
  for (const el of elements) elMap.set(el.id, el);

  // Identify which elements can be pushed
  const movableIds: string[] = [];
  for (const el of elements) {
    if (excludeSet.has(el.type)) continue;
    if (opts.skip && opts.skip(el)) continue;
    if (anchorIds.has(el.id)) continue;
    movableIds.push(el.id);
  }

  // Sort movables based on axis
  if (opts.axis === "shortest") {
    let cx = 0, cy = 0, n = 0;
    for (const id of anchorIds) {
      const a = elementTightCanvasAabb(elMap.get(id)!);
      if (a) { cx += a.x + a.w / 2; cy += a.y + a.h / 2; n++; }
    }
    if (n > 0) { cx /= n; cy /= n; }
    const fc = cx, fy = cy;
    movableIds.sort((a, b) => {
      const aA = elementTightCanvasAabb(elMap.get(a)!);
      const bA = elementTightCanvasAabb(elMap.get(b)!);
      const aD = aA ? Math.hypot(aA.x + aA.w / 2 - fc, aA.y + aA.h / 2 - fy) : Infinity;
      const bD = bA ? Math.hypot(bA.x + bA.w / 2 - fc, bA.y + bA.h / 2 - fy) : Infinity;
      return aD - bD;
    });
  } else if (opts.axis === "horizontal") {
    const dir = opts.direction ?? 1;
    movableIds.sort((a, b) => {
      const aEl = elMap.get(a)!, bEl = elMap.get(b)!;
      const aX = "x" in aEl ? (aEl as TextEl).x : 0;
      const bX = "x" in bEl ? (bEl as TextEl).x : 0;
      return dir === 1 ? aX - bX : bX - aX;
    });
  } else {
    const dir = opts.direction ?? 1;
    movableIds.sort((a, b) => {
      const aEl = elMap.get(a)!, bEl = elMap.get(b)!;
      const aY = "y" in aEl ? (aEl as TextEl).y : 0;
      const bY = "y" in bEl ? (bEl as TextEl).y : 0;
      return dir === 1 ? aY - bY : bY - aY;
    });
  }

  const pusherIds = new Set(anchorIds);

  const fineAabbs = elementFineAabbs;

  /** Check if any AABB from `as_` overlaps any AABB from `bs`. Returns the overlapping pair or null. */
  const findOverlap = (as_: CanvasAabb[], bs: CanvasAabb[]): { a: CanvasAabb; b: CanvasAabb } | null => {
    for (const a of as_) {
      for (const b of bs) {
        if (canvasAABBsTouchOrOverlap(a, b, -0.5)) {
          const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          if (ox > 0.5 && oy > 0.5) return { a, b };
        }
      }
    }
    return null;
  };

  const pushOne = (tgtId: string): boolean => {
    const tgt = elMap.get(tgtId)!;
    const tgtBoxes = fineAabbs(tgt);
    if (tgtBoxes.length === 0) return false;
    const tgtUnion = elementTightCanvasAabb(tgt);
    if (!tgtUnion) return false;

    let bestDx = 0, bestDy = 0;
    let found = false;

    for (const pusherId of pusherIds) {
      if (pusherId === tgtId) continue;
      const pusher = elMap.get(pusherId)!;
      const pUnion = elementTightCanvasAabb(pusher);
      if (!pUnion) continue;
      // Coarse check on union AABBs (fast reject)
      if (!canvasAABBsTouchOrOverlap(pUnion, tgtUnion, -0.5)) continue;
      // Fine-grained per-line overlap check
      const pBoxes = fineAabbs(pusher);
      const hit = findOverlap(pBoxes, tgtBoxes);
      if (!hit) continue;

      const pAabb = hit.a;
      const tgtAabb = hit.b;
      const overlapX = Math.min(pAabb.x + pAabb.w, tgtAabb.x + tgtAabb.w) - Math.max(pAabb.x, tgtAabb.x);
      const overlapY = Math.min(pAabb.y + pAabb.h, tgtAabb.y + tgtAabb.h) - Math.max(pAabb.y, tgtAabb.y);
      if (overlapX <= 0.5 || overlapY <= 0.5) continue;

      let dx = 0, dy = 0;
      const pCx = pAabb.x + pAabb.w / 2;
      const pCy = pAabb.y + pAabb.h / 2;
      const tCx = tgtAabb.x + tgtAabb.w / 2;
      const tCy = tgtAabb.y + tgtAabb.h / 2;

      if (opts.axis === "horizontal") {
        const dir = opts.direction ?? (tCx >= pCx ? 1 : -1);
        if (opts.quantum.kind === "abut") {
          dx = dir === 1
            ? (pAabb.x + pAabb.w + 1) - tgtAabb.x
            : (pAabb.x - tgtAabb.w - 1) - tgtAabb.x;
        } else {
          dx = dir * overlapX;
        }
      } else if (opts.axis === "vertical") {
        const dir = opts.direction ?? (tCy >= pCy ? 1 : -1);
        if (opts.quantum.kind === "lineHeight") {
          if (tgt.type === "text") {
            const ceilSnap = (y: number) => Math.ceil(y / TEXT_LINE_HEIGHT) * TEXT_LINE_HEIGHT;
            dy = dir === 1
              ? ceilSnap(tgtAabb.y + TEXT_LINE_HEIGHT) - tgtAabb.y
              : -(ceilSnap(tgtAabb.y + TEXT_LINE_HEIGHT) - tgtAabb.y);
          } else {
            dy = dir * overlapY;
          }
        } else {
          dy = dir * overlapY;
        }
      } else {
        if (overlapX <= overlapY) {
          dx = tCx >= pCx ? overlapX : -overlapX;
        } else {
          dy = tCy >= pCy ? overlapY : -overlapY;
        }
      }

      if (Math.abs(dx) > Math.abs(bestDx)) bestDx = dx;
      if (Math.abs(dy) > Math.abs(bestDy)) bestDy = dy;
      found = true;
    }

    if (!found || (bestDx === 0 && bestDy === 0)) return false;

    const dirX = bestDx > 0 ? 1 : bestDx < 0 ? -1 : 0;
    const dirY = bestDy > 0 ? 1 : bestDy < 0 ? -1 : 0;
    let nudge = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      let pushed = translateCanvasElBy(tgt, bestDx + dirX * nudge, bestDy + dirY * nudge);
      if (tgt.type === "text") {
        pushed = { ...pushed, y: snapTextLineY((pushed as TextEl).y) } as CanvasEl;
      }
      // Check if still overlapping any pusher using per-line AABBs
      const pushedBoxes = fineAabbs(pushed);
      let stillOverlaps = false;
      for (const pusherId of pusherIds) {
        if (pusherId === tgtId) continue;
        const pBoxes = fineAabbs(elMap.get(pusherId)!);
        if (findOverlap(pBoxes, pushedBoxes)) {
          stillOverlaps = true;
          break;
        }
      }
      if (!stillOverlaps) {
        elMap.set(tgtId, pushed);
        pusherIds.add(tgtId);
        return true;
      }
      nudge += TEXT_LINE_HEIGHT / 2
    }
    // Exhausted nudge attempts — apply best effort
    let pushed = translateCanvasElBy(tgt, bestDx + dirX * nudge, bestDy + dirY * nudge);
    if (tgt.type === "text") {
      pushed = { ...pushed, y: snapTextLineY((pushed as TextEl).y) } as CanvasEl;
    }
    elMap.set(tgtId, pushed);
    pusherIds.add(tgtId);
    return true;
  };

  // Initial sweep
  for (const id of movableIds) {
    pushOne(id);
  }

  // Stabilization passes
  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false;
    for (const id of movableIds) {
      if (pushOne(id)) moved = true;
    }
    if (!moved) break;
  }

  return elements.map((el) => elMap.get(el.id) ?? el);
}

/**
 * Check whether placing `element` would collide with any existing element.
 * Pure query — does not mutate. Returns the first colliding element, or null.
 */
export function tryPlace(
  elements: CanvasEl[],
  element: CanvasEl,
  excludeId?: string
): CanvasEl | null {
  const elBoxes = elementFineAabbs(element);
  if (elBoxes.length === 0) return null;
  const elUnion = elementTightCanvasAabb(element);
  if (!elUnion) return null;
  for (const other of elements) {
    if (other.id === element.id || other.id === excludeId) continue;
    const otherUnion = elementTightCanvasAabb(other);
    if (!otherUnion) continue;
    // Coarse reject on union AABBs
    if (!canvasAABBsTouchOrOverlap(elUnion, otherUnion, -0.5)) continue;
    // Fine-grained per-line check
    const otherBoxes = elementFineAabbs(other);
    for (const a of elBoxes) {
      for (const b of otherBoxes) {
        if (canvasAABBsTouchOrOverlap(a, b, -0.5)) return other;
      }
    }
  }
  return null;
}

// ── Reusable newline split ───────────────────────────────────────────────────

export type PlaceNewLineResult = {
  op: PlacementOp;
  newId: string;
  response: PlacementResponse & { immediate: boolean };
};

/**
 * Build a PlacementOp that inserts a newline character into `el.text` at `[selLo, selHi)`.
 * The element grows taller by one line; elements below are pushed down.
 */
export function placeNewLine(
  el: TextEl,
  selLo: number,
  selHi: number,
  _elements: CanvasEl[],
  _opts?: { locked?: boolean; fontScale?: number },
): PlaceNewLineResult {
  const lo = Math.min(Math.max(0, selLo), el.text.length);
  const hi = Math.min(Math.max(lo, selHi), el.text.length);
  const newText = el.text.slice(0, lo) + "\n" + el.text.slice(hi);

  const op: PlacementOp = {
    kind: "transform",
    fn: (els) => els.map((x) => {
      if (x.id === el.id && x.type === "text")
        return { ...x, text: newText } as CanvasEl;
      return x;
    }),
    anchorIds: new Set([el.id]),
    resolve: verticalEnterPush(),
  };

  return {
    op,
    newId: el.id,
    response: { merge: { focusId: el.id, caret: lo + 1 }, immediate: false },
  };
}

/**
 * Build a PlacementOp that spawns a single multi-line TextEl from lines at (x, y).
 * The text contains newlines; collision resolution pushes existing elements away.
 */
export function placeChain(
  lines: string[],
  x: number,
  y: number,
  opts?: { fontScale?: number; locked?: boolean },
): { op: PlacementOp; elements: TextEl[]; response: PlacementResponse & { immediate: boolean } } {
  const curK = opts?.fontScale ?? DEFAULT_TEXT_SCALE;
  const id = crypto.randomUUID();
  const element: TextEl = {
    id,
    type: "text",
    x,
    y: snapTextLineY(y),
    text: lines.join("\n"),
    ...(curK !== DEFAULT_TEXT_SCALE ? { fontScale: curK } : {}),
    ...(opts?.locked ? { locked: true } : {}),
  };

  return {
    elements: [element],
    op: {
      kind: "spawn",
      element,
      resolve: verticalEnterPush(),
    },
    response: { merge: { focusId: id, caret: 0 }, immediate: true },
  };
}

// ── Element spawn factories ─────────────────────────────────────────────────
// Pure functions that build a PlacementOp for a new element.
// Callers pass the result to execPlace(result.op).

export type SpawnResult = { op: PlacementOp; id: string };

export function spawnText(
  x: number, y: number, text = "",
  opts?: { fontScale?: number; locked?: boolean },
): SpawnResult {
  const id = crypto.randomUUID();
  const el: TextEl = {
    id, type: "text", x, y: snapTextLineY(y), text,
    ...(opts?.fontScale != null && opts.fontScale !== DEFAULT_TEXT_SCALE ? { fontScale: opts.fontScale } : {}),
    ...(opts?.locked ? { locked: true } : {}),
  };
  return { id, op: { kind: "spawn", element: el } };
}


export function spawnDraw(pts: { x: number; y: number }[]): SpawnResult {
  const id = crypto.randomUUID();
  const el: DrawEl = {
    id, type: "draw",
    pts: pts.map(p => `${+p.x.toFixed(2)},${+p.y.toFixed(2)}`).join(" "),
  };
  return { id, op: { kind: "spawn", element: el } };
}

export function spawnShape(
  rect: { x: number; y: number; w: number; h: number },
  shape: "rect" | "circle" | "triangle" = "rect",
): SpawnResult {
  const id = crypto.randomUUID();
  const el: ShapeEl = { id, type: "shape", ...rect, shape };
  return { id, op: { kind: "spawn", element: el } };
}

export function spawnArrow(x1: number, y1: number, x2: number, y2: number): SpawnResult {
  const id = crypto.randomUUID();
  const el: ArrowEl = { id, type: "arrow", x1, y1, x2, y2 };
  return { id, op: { kind: "spawn", element: el } };
}

export function spawnImage(
  x: number, y: number, src: string, w: number, h: number,
): SpawnResult {
  const id = crypto.randomUUID();
  const el: ImageEl = { id, type: "image", x, y, src, w, h };
  return { id, op: { kind: "spawn", element: el, resolve: dragResolvePush() } };
}

export function spawnMath(x: number, y: number, latex: string): SpawnResult {
  const id = crypto.randomUUID();
  const el: MathEl = { id, type: "math", x, y, latex };
  return { id, op: { kind: "spawn", element: el } };
}

export function spawnChart(
  x: number, y: number,
  chartType: ChartType, labels: string[], datasets: ChartDataset[],
  w = 500, h = 320,
): SpawnResult {
  const id = crypto.randomUUID();
  const el: ChartEl = { id, type: "chart", x, y, w, h, chartType, labels, datasets };
  return { id, op: { kind: "spawn", element: el } };
}

export function spawnNoteRef(x: number, y: number, targetNoteId: string): SpawnResult {
  const id = crypto.randomUUID();
  const el: NoteRefEl = { id, type: "noteRef", x, y, targetNoteId };
  return { id, op: { kind: "spawn", element: el } };
}

// ── Text click resolution ───────────────────────────────────────────────────

export type TextClickResolution =
  | { action: "focus"; id: string }
  | { action: "caret"; id: string; caretIndex: number }
  | { action: "create"; x: number; y: number };

/** Types the text-click probe can overlap without being pushed — clicking inside
 *  one of these spawns text at the click point so the user can type on top. */
const TEXT_CLICK_PASSTHROUGH_TYPES: ReadonlySet<CanvasEl["type"]> = new Set(["shape", "draw"]);

/** Decide what should happen when the user clicks at (cx, cy) with the text tool.
 *  Returns a pure description — no DOM side effects. */
export function resolveTextClick(
  elements: CanvasEl[], cx: number, cy: number,
): TextClickResolution {
  const hit = textHitAt(elements, cx, cy);
  if (hit) {
    const caretIdx = canvasCaretIndexAtPoint(hit, cx, cy);
    return { action: "caret", id: hit.id, caretIndex: caretIdx };
  }

  // Probe height matches the real rendered line height (line-height 1.5 × 14 × scale = 21 × scale),
  // not the font-metric height returned by textLineHeightForScale, so reposition decisions align
  // with the AABB the text will actually occupy after mount.
  const probeH = TEXT_LINE_HEIGHT * DEFAULT_TEXT_SCALE;
  let spawnY = snapTextLineY(cy);
  const filtered = elements.filter(el => !TEXT_CLICK_PASSTHROUGH_TYPES.has(el.type));
  for (let i = 0; i < 8; i++) {
    const probe: TextEl = { id: "", type: "text", x: cx, y: spawnY, text: "" };
    const collider = tryPlace(filtered, probe);
    if (!collider) break;
    if (collider.type === "text") {
      const tel = collider as TextEl;
      const caretIdx = canvasCaretIndexAtPoint(tel, cx, cy);
      return { action: "caret", id: tel.id, caretIndex: caretIdx };
    }
    // Non-text collision: reposition probe above collider's AABB so bottom sits at or above collider top.
    const aabb = elementTightCanvasAabb(collider);
    if (!aabb) break;
    const nextY = Math.floor((aabb.y - probeH) / TEXT_LINE_HEIGHT) * TEXT_LINE_HEIGHT;
    if (nextY >= spawnY) break;
    spawnY = nextY;
  }
  return { action: "create", x: cx, y: spawnY };
}

/**
 * Execute a placement operation: apply mutation → resolve collisions → respond (merge text).
 *
 * Single entry point replacing scattered boilerplate across event handlers.
 */
export function executePlacement(
  elements: CanvasEl[],
  op: PlacementOp,
  response?: PlacementResponse
): PlacementResult {
  let anchorIds = new Set<string>();

  // Phase 1: Apply the mutation
  switch (op.kind) {
    case "spawn":
      elements = [...elements, op.element];
      anchorIds.add(op.element.id);
      break;

    case "move":
      elements = elements.map((el) => {
        if (el.id !== op.id) return el;
        return {
          ...el,
          ...(op.to.x != null ? { x: op.to.x } : {}),
          ...(op.to.y != null ? { y: op.to.y } : {}),
        } as CanvasEl;
      });
      anchorIds.add(op.id);
      break;

    case "mutate":
      elements = elements.map((el) =>
        el.id === op.id ? { ...el, ...op.changes } as CanvasEl : el
      );
      anchorIds.add(op.id);
      break;

    case "swap": {
      const elA = elements.find((e) => e.id === op.a);
      const elB = elements.find((e) => e.id === op.b);
      if (elA && elB) {
        const aAabb = elementTightCanvasAabb(elA);
        const bAabb = elementTightCanvasAabb(elB);
        if (aAabb && bAabb) {
          const topY = Math.min(aAabb.y, bAabb.y);
          const ceilSnap = (y: number) => Math.ceil(y / TEXT_LINE_HEIGHT) * TEXT_LINE_HEIGHT;
          let aNewY: number, bNewY: number;
          if (op.direction === -1) {
            // a moves up: a gets top, b below
            aNewY = snapTextLineY(topY);
            bNewY = ceilSnap(aNewY + aAabb.h);
          } else {
            // a moves down: b gets top, a below
            bNewY = snapTextLineY(topY);
            aNewY = ceilSnap(bNewY + bAabb.h);
          }
          elements = elements.map((el) => {
            if (el.id === op.a) return { ...el, y: aNewY } as CanvasEl;
            if (el.id === op.b) return { ...el, y: bNewY } as CanvasEl;
            return el;
          });
        }
      }
      anchorIds.add(op.a);
      anchorIds.add(op.b);
      break;
    }

    case "remove":
      elements = elements.filter((el) => !op.ids.has(el.id));
      return { elements, caretFocus: null };

    case "transform":
      elements = op.fn(elements);
      if (op.anchorIds) anchorIds = op.anchorIds;
      break;
  }

  // Phase 2: Resolve collisions
  const resolveOpts = "resolve" in op ? (op as { resolve?: ResolveOpts }).resolve : undefined;
  if (resolveOpts && anchorIds.size > 0) {
    elements = resolveCollisions(elements, anchorIds, resolveOpts);
  }

  // Phase 3: Response (merge text, track caret)
  let caretFocus: { id: string; caret: number } | null = null;
  if (response?.merge) {
    const result = mergeElements(elements, response.merge.focusId, response.merge.caret);
    elements = result.elements;
    caretFocus = result.caretFocus;
  }

  return { elements, caretFocus };
}

// ── Slash Command Trie ──────────────────────────────────────────────────────

export type CommandTrieNode = {
  children: Map<string, CommandTrieNode>;
  command: string | null;
};

export type CommandMatchResult =
  | { status: "none" }
  | { status: "partial"; prefixLen: number }
  | { status: "matched"; command: string; cmdLen: number };

export function buildCommandTrie(commands: string[]): CommandTrieNode {
  const root: CommandTrieNode = { children: new Map(), command: null };
  for (const cmd of commands) {
    let node = root;
    for (const ch of cmd) {
      let child = node.children.get(ch);
      if (!child) {
        child = { children: new Map(), command: null };
        node.children.set(ch, child);
      }
      node = child;
    }
    node.command = cmd;
  }
  return root;
}

export const COMMAND_LIST = ["/chat", "/math", "/rectangle", "/square", "/circle", "/triangle", "/arrow", "/graph", "/link", "/q", "/sideq", "/sidechat", "/table", "/print", "/logo", "/checklist", "/image", "/pdf", "/embed"];
export const COMMAND_TRIE = buildCommandTrie(COMMAND_LIST);

/** Return all commands that start with `prefix`, sorted shortest-first (then alphabetical). */
export function commandsWithPrefix(prefix: string): string[] {
  const lower = prefix.toLowerCase();
  return COMMAND_LIST.filter(c => c.startsWith(lower)).sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/**
 * Match text against the command trie.
 * - "none": no prefix of text matches any command prefix
 * - "partial": text so far is a prefix of at least one command, but not complete
 * - "matched": text starts with a complete command (text equals command, or has space + args after it)
 */
export function matchCommand(trie: CommandTrieNode, text: string): CommandMatchResult {
  const lower = text.toLowerCase();
  let node = trie;
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    // If we've reached a complete command and hit a space, it's a match
    if (node.command && ch === " ") {
      return { status: "matched", command: node.command, cmdLen: node.command.length };
    }
    const child = node.children.get(ch);
    if (!child) return { status: "none" };
    node = child;
  }
  // Exhausted text — check if we landed on a complete command
  if (node.command) {
    return { status: "matched", command: node.command, cmdLen: node.command.length };
  }
  // Still a valid prefix of some command(s)
  return { status: "partial", prefixLen: lower.length };
}

// ── spawnChat ───────────────────────────────────────────────────────────────

/** Token / context counters carried over to a forked or side chat. */
export type ChatStatsSeed = Partial<
  Pick<ChatEl, "tokenCount" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "contextWindow" | "lastTurnInputTokens">
>;

/**
 * Spawn a new chat element anchored at `el`.
 * - `query` empty: spawn with no messages (no LLM call expected).
 * - `query` non-empty: seed with a single user message (caller usually follows up with submitChatQuery).
 * - `seedMessages`: pre-populate rendered history (used by /chat fork). Takes precedence over `query`.
 * - `seedContext`: pre-populate the LLM context (separate from rendered history).
 *   Used by fork/sideq so the new chat inherits the parent's LLM-visible state.
 * - `seedStats`: copy parent's running counters so the new chat's HUD starts from the same baseline.
 */
export function spawnChat(
  el: TextEl,
  query: string,
  chatNumber: number,
  parentChatNumber?: number,
  seedMessages?: ChatMessage[],
  seedContext?: ChatContextMessage[],
  seedStats?: ChatStatsSeed,
): { op: PlacementOp; chatId: string; chatElId: string } {
  const chatId = crypto.randomUUID();
  const chatElId = crypto.randomUUID();
  const chatX = el.x;
  const chatY = snapTextLineY(el.y);
  const messages: ChatMessage[] = seedMessages
    ? [...seedMessages]
    : query
      ? [{ role: "user" as const, content: query }]
      : [];
  return {
    op: {
      kind: "transform",
      fn: (els) => {
        const without = els.filter((x) => x.id !== el.id);
        return [
          ...without,
          {
            id: chatElId,
            type: "chat" as const,
            x: chatX,
            y: chatY,
            chatId,
            chatNumber,
            ...(parentChatNumber != null ? { parentChatNumber } : {}),
            messages,
            ...(seedContext ? { contextMessages: seedContext.map((m) => ({ role: m.role, content: m.content })) } : {}),
            ...(seedStats ?? {}),
            inputText: "",
          },
        ];
      },
      anchorIds: new Set([chatElId]),
      resolve: verticalEnterPush(),
    },
    chatId,
    chatElId,
  };
}

// ── spawnSideq ──────────────────────────────────────────────────────────────

export function spawnSideq(
  el: TextEl,
  query: string,
  parentChatNumber: number,
  sideqNumber: number,
  seedContext?: ChatContextMessage[],
  seedStats?: ChatStatsSeed,
): { op: PlacementOp; chatId: string; chatElId: string } {
  const chatId = crypto.randomUUID();
  const chatElId = crypto.randomUUID();
  const chatX = el.x;
  const chatY = snapTextLineY(el.y);
  return {
    op: {
      kind: "transform",
      fn: (els) => {
        const without = els.filter((x) => x.id !== el.id);
        return [
          ...without,
          {
            id: chatElId,
            type: "chat" as const,
            x: chatX,
            y: chatY,
            chatId,
            chatNumber: 0, // not used for display on sideq
            ephemeral: true,
            parentChatNumber,
            sideqNumber,
            messages: [{ role: "user" as const, content: query }],
            ...(seedContext ? { contextMessages: seedContext.map((m) => ({ role: m.role, content: m.content })) } : {}),
            ...(seedStats ?? {}),
            inputText: "",
          },
        ];
      },
      anchorIds: new Set([chatElId]),
      resolve: verticalEnterPush(),
    },
    chatId,
    chatElId,
  };
}

// ── spawnQuickChat ────────────────────────────────────────────────────────────

export function spawnQuickChat(
  el: TextEl,
  query: string,
): { op: PlacementOp; chatId: string; chatElId: string } {
  const chatId = crypto.randomUUID();
  const chatElId = crypto.randomUUID();
  const chatX = el.x;
  const chatY = snapTextLineY(el.y);
  return {
    op: {
      kind: "transform",
      fn: (els) => {
        const without = els.filter((x) => x.id !== el.id);
        return [
          ...without,
          {
            id: chatElId,
            type: "chat" as const,
            x: chatX,
            y: chatY,
            chatId,
            chatNumber: 0,
            ephemeral: true,
            messages: [{ role: "user" as const, content: query }],
            inputText: "",
          },
        ];
      },
      anchorIds: new Set([chatElId]),
      resolve: verticalEnterPush(),
    },
    chatId,
    chatElId,
  };
}

// ── spawnMathFromCommand ────────────────────────────────────────────────────

export function spawnMathFromCommand(el: TextEl, latex: string): PlacementOp {
  const newId = crypto.randomUUID();
  const x = el.x;
  const y = snapTextLineY(el.y);
  return {
    kind: "transform",
    fn: (els) => [
      ...els.filter((e) => e.id !== el.id),
      { id: newId, type: "math" as const, x, y, latex } satisfies MathEl,
    ],
    anchorIds: new Set([newId]),
    resolve: verticalEnterPush(),
  };
}

// ── spawnLogoFromCommand ────────────────────────────────────────────────────

export function spawnLogoFromCommand(el: TextEl, args: string): PlacementOp {
  const n = Number(args.trim());
  const size = !isNaN(n) && n > 0 ? Math.min(1200, n * 30) : 200;
  const newId = crypto.randomUUID();
  const x = el.x;
  const y = snapTextLineY(el.y);
  return {
    kind: "transform",
    fn: (els) => [
      ...els.filter((e) => e.id !== el.id),
      { id: newId, type: "image" as const, x, y, src: "/shannon-logo.png", w: size, h: size } satisfies ImageEl,
    ],
    anchorIds: new Set([newId]),
    resolve: verticalEnterPush(),
  };
}

// ── spawnShapeFromCommand ───────────────────────────────────────────────────

export function spawnShapeFromCommand(
  el: TextEl,
  shape: "rect" | "circle" | "triangle",
  args: string,
): PlacementOp {
  const nums = args.split(/[\sx,]+/).map(Number).filter((n) => !isNaN(n) && n > 0);
  const DEFAULT = 5;
  let w: number, h: number;
  if (nums.length >= 2) {
    w = nums[0]; h = nums[1];
  } else if (nums.length === 1) {
    w = nums[0]; h = nums[0];
  } else {
    w = DEFAULT; h = DEFAULT;
  }
  w = w * 30;
  h = h * 30;

  const newId = crypto.randomUUID();
  const x = el.x;
  const y = snapTextLineY(el.y);
  return {
    kind: "transform",
    fn: (els) => [
      ...els.filter((e) => e.id !== el.id),
      { id: newId, type: "shape" as const, x, y, w, h, shape } satisfies ShapeEl,
    ],
    anchorIds: new Set([newId]),
    resolve: verticalEnterPush(),
  };
}

// ── spawnArrowFromCommand ───────────────────────────────────────────────────

export function spawnArrowFromCommand(el: TextEl, args: string): PlacementOp {
  const tokens = args.trim().split(/\s+/);
  const directions = new Set(["up", "down", "left", "right"]);
  let dir = "right";
  const numTokens: number[] = [];
  for (const t of tokens) {
    if (directions.has(t.toLowerCase())) dir = t.toLowerCase();
    else { const n = Number(t); if (!isNaN(n) && n > 0) numTokens.push(n); }
  }
  const len = (numTokens[0] ?? 5) * 30;
  const newId = crypto.randomUUID();
  const x = el.x;
  const y = snapTextLineY(el.y) + TEXT_LINE_HEIGHT / 2;
  let x2 = x, y2 = y;
  if (dir === "right") x2 = x + len;
  else if (dir === "left") x2 = x - len;
  else if (dir === "down") y2 = y + len;
  else if (dir === "up") y2 = y - len;
  return {
    kind: "transform",
    fn: (els) => [
      ...els.filter((e) => e.id !== el.id),
      { id: newId, type: "arrow" as const, x1: x, y1: y, x2, y2 } satisfies ArrowEl,
    ],
    anchorIds: new Set([newId]),
    resolve: verticalEnterPush(),
  };
}

// ── spawnTableFromCommand ──────────────────────────────────────────────────

export function spawnTableFromCommand(el: TextEl, args: string): PlacementOp {
  const nums = args.split(/[\sx,]+/).map(Number).filter((n) => !isNaN(n) && n > 0);
  const rows = Math.min(nums[0] ?? 3, 50);
  const cols = Math.min(nums[1] ?? nums[0] ?? 3, 20);
  const cells: TableCell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ html: "" })),
  );
  // Match TableContainer's empty-cell layout (MIN_COL_W = MIN_ROW_H = 44, BORDER_PX = 1).
  // Initial dims must agree with the rendered frame or the skeleton + AABB flash wider than the grid.
  const w = cols * 44 + (cols + 1);
  const h = rows * 44 + (rows + 1);

  const newId = crypto.randomUUID();
  const x = el.x;
  const y = snapTextLineY(el.y);
  return {
    kind: "transform",
    fn: (els) => [
      ...els.filter((e) => e.id !== el.id),
      { id: newId, type: "table" as const, x, y, w, h, cells } satisfies TableEl,
    ],
    anchorIds: new Set([newId]),
    resolve: verticalEnterPush(),
  };
}

// ── spawnChecklistFromCommand ──────────────────────────────────────────────

export function spawnChecklistFromCommand(el: TextEl, args: string): PlacementOp {
  const n = Number(args.trim());
  const count = !isNaN(n) && n > 0 ? Math.min(50, Math.floor(n)) : 1;
  const items: ChecklistItem[] = Array.from({ length: count }, () => ({ html: "", checked: false }));
  // Match ChecklistContainer's empty-item layout (MIN_W, MIN_ROW_H).
  const w = 220;
  const h = count * 28;

  const newId = crypto.randomUUID();
  const x = el.x;
  const y = snapTextLineY(el.y);
  return {
    kind: "transform",
    fn: (els) => [
      ...els.filter((e) => e.id !== el.id),
      { id: newId, type: "checklist" as const, x, y, w, h, items } satisfies ChecklistEl,
    ],
    anchorIds: new Set([newId]),
    resolve: verticalEnterPush(),
  };
}

/** Strip transient measured dims from every cell — used on the persistence path. */
export function stripTableCellMeasures(cells: TableCell[][]): TableCell[][] {
  return cells.map((row) =>
    row.map((cell) => {
      if (cell.measuredW === undefined && cell.measuredH === undefined) return cell;
      const { html } = cell;
      return { html };
    }),
  );
}

/** Escape a raw string for safe insertion into HTML. */
export function escapeCellHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Convert legacy `rows: string[][]` (if present on an older persisted TableEl) to `cells`. */
export function migrateLegacyTableRows(legacyRows: string[][]): TableCell[][] {
  return legacyRows.map((row) => row.map((s) => ({ html: escapeCellHtml(s ?? "") })));
}


