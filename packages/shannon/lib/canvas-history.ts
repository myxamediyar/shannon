import type { CanvasEl, ChatEl, PageRegion, TextEl } from "./canvas-types";
import { isTextBlank } from "./canvas-types";

// ── Config ───────────────────────────────────────────────────────────────────

/** Element types whose changes are invisible to undo/redo (legacy — kept for
 *  callers that want the fully-ignored set; currently empty because chats are
 *  partially tracked via `stripChatForHistory`). */
export const UNDO_EXCEPTION_TYPES: CanvasEl["type"][] = [];

/** Maximum number of snapshots kept per note. */
export const MAX_HISTORY = 20;

// ── Types ────────────────────────────────────────────────────────────────────

export interface Snapshot {
  elements: CanvasEl[];
  pageRegions: PageRegion[];
}

export interface UndoStack {
  past: Snapshot[];   // most-recent at the end
  future: Snapshot[]; // most-recent at the front
}

// ── Chat stripping ───────────────────────────────────────────────────────────

/** Reduce a chat to only the fields that participate in undo/redo: id, type,
 *  position, and explicit size pins. Inner state (messages, inputText, streaming
 *  flags, token counts, etc.) is intentionally excluded so typing and streaming
 *  don't push per-keystroke snapshots, and so history entries stay small. */
export function stripChatForHistory(el: ChatEl): ChatEl {
  const out: ChatEl = {
    id: el.id,
    type: "chat",
    x: el.x,
    y: el.y,
    chatId: el.chatId,
    chatNumber: el.chatNumber,
    messages: [],
    inputText: "",
  };
  if (el.w != null) out.w = el.w;
  if (el.h != null) out.h = el.h;
  return out;
}

function stripSnapshot(s: Snapshot): Snapshot {
  return {
    elements: s.elements.map((el) => (el.type === "chat" ? stripChatForHistory(el) : el)),
    pageRegions: s.pageRegions,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function emptyStack(): UndoStack {
  return { past: [], future: [] };
}

/** Added/removed elements that shouldn't trigger a history entry. Chats are in
 *  here so creation/deletion stays silent (undoing can't resurrect a chat's
 *  messages). Empty text elements are also silent so placeholders don't stack. */
function isIgnoredAddRemove(el: CanvasEl): boolean {
  if (el.type === "chat") return true;
  if (el.type === "text" && isTextBlank((el as TextEl).text)) return true;
  return false;
}

/** Modifications between prev and next that shouldn't trigger a history entry. */
function isIgnoredModify(prev: CanvasEl, next: CanvasEl): boolean {
  if (prev.type === "text" && next.type === "text") {
    if (isTextBlank((prev as TextEl).text) && isTextBlank((next as TextEl).text)) return true;
  }
  return false;
}

/** Returns true iff the stripped forms of `a` and `b` differ — i.e. some field
 *  tracked by history changed. Chat inner state is invisible here. */
function historyFormDiffers(a: CanvasEl, b: CanvasEl): boolean {
  const sa = a.type === "chat" ? stripChatForHistory(a) : a;
  const sb = b.type === "chat" ? stripChatForHistory(b) : b;
  return JSON.stringify(sa) !== JSON.stringify(sb);
}

/**
 * Returns true when every difference between `prev` and `next` is invisible to
 * history (chat add/remove, empty-text add/remove, chat inner-only changes,
 * empty-text self-edits). If nothing changed at all, also returns true.
 */
export function isExceptedChange(prev: Snapshot, next: Snapshot): boolean {
  if (JSON.stringify(prev.pageRegions) !== JSON.stringify(next.pageRegions)) return false;

  const prevMap = new Map(prev.elements.map((e) => [e.id, e]));
  const nextMap = new Map(next.elements.map((e) => [e.id, e]));

  for (const el of next.elements) {
    if (prevMap.has(el.id)) continue;
    if (isIgnoredAddRemove(el)) continue;
    return false;
  }
  for (const el of prev.elements) {
    if (nextMap.has(el.id)) continue;
    if (isIgnoredAddRemove(el)) continue;
    return false;
  }
  for (const el of next.elements) {
    const old = prevMap.get(el.id);
    if (!old) continue;
    if (isIgnoredModify(old, el)) continue;
    if (historyFormDiffers(old, el)) return false;
  }
  return true;
}

// ── Stack operations ─────────────────────────────────────────────────────────

/** Push a snapshot onto the undo stack, clearing redo. Chat elements are
 *  stripped to outer-only so their inner state doesn't balloon history. */
export function pushSnapshot(stack: UndoStack, snapshot: Snapshot): UndoStack {
  const past = [...stack.past, stripSnapshot(snapshot)];
  if (past.length > MAX_HISTORY) past.shift();
  return { past, future: [] };
}

/** Pop the most-recent snapshot from `past`, pushing `current` onto `future`. */
export function undo(
  stack: UndoStack,
  current: Snapshot,
): { stack: UndoStack; snapshot: Snapshot } | null {
  if (stack.past.length === 0) return null;
  const past = [...stack.past];
  const restored = past.pop()!;
  return { stack: { past, future: [stripSnapshot(current), ...stack.future] }, snapshot: restored };
}

/** Pop the most-recent snapshot from `future`, pushing `current` onto `past`. */
export function redo(
  stack: UndoStack,
  current: Snapshot,
): { stack: UndoStack; snapshot: Snapshot } | null {
  if (stack.future.length === 0) return null;
  const future = [...stack.future];
  const restored = future.shift()!;
  return { stack: { past: [...stack.past, stripSnapshot(current)], future }, snapshot: restored };
}
