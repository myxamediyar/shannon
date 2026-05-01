import type { CanvasAabb, CanvasEl, PlacementOp, PlacementResponse, TextEl } from "./canvas-types";
import { TEXT_LINE_HEIGHT, OPTION_BACKSPACE_CHAR_STEPS, isTextBlank } from "./canvas-types";
import type { Editor } from "@tiptap/react";
import { legacyMarkdownToHTML, type TiptapTextAdapter } from "../components/RichTextEditor";
import {
  canvasTextsSameRowSorted,
  leftTextNeighborOnRow,
  nearestBlockingRightEdgeLeft,
  nearestBlockingLeftEdgeRight,
  crossRowTextAbuttingLeft,
  crossRowTextAbuttingRight,
  leftTextNeighborBeforeColumn,
  rightTextFromColumn,
  elementTightCanvasAabb,
  textElementAabb,
  textElHeight,
  snapTextLineY,
  textScale,
  textLineHeightForScale,
  textGlyphWidth,
  textGlyphColumnOnRow,
  columnAlignsWithGlyphBoundaryInText,
  canvasTextBoxesCollide,
  canvasTextWidth,
  canvasAABBsTouchOrOverlap,
  canvasCaretIndexAtX,
  caretGlyphX,
  approxCharWidthCanvas,
  commandsWithPrefix,
  tabJumpTargetLeft,
  tabJumpTargetRight,
  pickNearerLeftSnapX,
  pickJumpDestRight,
  textsBelowRowHittingColumn,
  resolveTextClick,
  tryPlace,
  spawnText,
  horizontalTextPush,
  dragResolvePush,
} from "./canvas-utils";

/**
 * Describes what the shell should do after a text keystroke handler runs.
 *
 * The module never performs side effects — it reads canvas state + event, returns
 * this description, and the shell applies it through its normal pipeline
 * (`execPlace` for `op`, `setFocusedTextId` for focus, rAF-deferred caret).
 *
 * - `default` — event not handled, shell returns false (browser/Tiptap default runs)
 * - `handled` — event consumed, no state change
 * - `apply` — one or more of: placement op, focus change, post-commit caret positioning
 */
export type TextEventResult =
  | { kind: "default" }
  | { kind: "handled" }
  | {
      kind: "apply";
      op?: PlacementOp;
      response?: PlacementResponse & { immediate?: boolean; skipHistory?: boolean };
      setFocusedId?: string;
      /** rAF-deferred caret repositioning after React commits the op. */
      caret?:
        | { on: "self"; start: number; end: number }
        | { on: "editor"; elId: string; charOffset: number }
        /** Cmd/Ctrl+Arrow fragment jump — shell does special rAF+flushSync layout bump. */
        | { on: "cmdArrow"; elId: string; caret: number };
      /** Call adapter.blur() (Escape). */
      blur?: boolean;
      /** Replace the current editor's content (tab completion); shell also triggers onTextChange. */
      replaceContent?: { html: string; plainText: string };
      /** Record a newly-spawned text element id — protects against blur-driven removal. */
      setNewElId?: string | null;
    };

/**
 * Scratch refs owned by text-interaction algorithms, passed in so handlers can
 * read/write their own state (column anchor for ArrowUp/Down, tab-completion cycling).
 * These are NOT shell orchestration bindings — they're co-owned by this module.
 */
export type TextInteractionDeps = {
  /** Anchor X for vertical arrow navigation, persists across consecutive ArrowUp/Down. */
  verticalColumnRef: { current: number | null };
  /** Tab-completion cycling state. */
  cmdTabRef: { current: { prefix: string; matches: string[]; index: number } | null };
};

/**
 * Handle Backspace at the start of a text element.
 *
 * Shell invariants:
 *   - caller checks `e.key === "Backspace"` before calling
 *   - module calls `e.preventDefault()` only when it decides to handle
 *   - return `default` means the shell should let browser/Tiptap handle it
 */
export function handleTextBackspace(
  e: KeyboardEvent,
  adapter: TiptapTextAdapter,
  el: TextEl,
  elements: CanvasEl[],
  hasActiveNote: boolean,
): TextEventResult {
  // Only act when caret is at char offset 0 AND at the very start of the doc
  // (see commit e51fb7d — char offset 0 with empty preceding blocks is misleading).
  if (adapter.selectionStart !== 0 || adapter.selectionEnd !== 0) return { kind: "default" };
  const sel = adapter.editor.state.selection;
  if (sel.from > 1 || sel.to > 1) return { kind: "default" };

  if (!hasActiveNote) {
    e.preventDefault();
    return { kind: "handled" };
  }

  e.preventDefault();

  const row = canvasTextsSameRowSorted(elements, el.y);
  const L = leftTextNeighborOnRow(row, el.id);

  const makeMerge = (left: TextEl, right: TextEl): TextEventResult => {
    const junction = left.text.length;
    const mergedX = left.text.length === 0 ? right.x : left.x;
    const leftHtml = left.html ?? legacyMarkdownToHTML(left.text);
    const rightHtml = right.html ?? legacyMarkdownToHTML(right.text);
    const mergedLeft: TextEl = {
      ...left,
      text: left.text + right.text,
      html: leftHtml + rightHtml,
      x: mergedX,
      y: snapTextLineY(left.y),
    };
    return {
      kind: "apply",
      op: {
        kind: "transform",
        fn: (all) => {
          const rest = all.filter((x) => x.id !== right.id);
          return rest.map((x) => (x.id === left.id && x.type === "text" ? mergedLeft : x));
        },
        anchorIds: new Set([left.id]),
        resolve: dragResolvePush(),
      },
      response: { merge: { focusId: left.id, caret: junction } },
    };
  };

  // Cross-row blocker: a text fragment on another row whose right edge abuts el.x
  const crossBlockRightEdge = nearestBlockingRightEdgeLeft(elements, el);
  const selfAabb = elementTightCanvasAabb(el);
  const crossAbutEl = (() => {
    if (!selfAabb) return null;
    const selfRow = snapTextLineY(el.y);
    let best: { el: TextEl; rightEdge: number } | null = null;
    for (const other of elements) {
      if (other.id === el.id || other.type !== "text") continue;
      const otherT = other as TextEl;
      if (snapTextLineY(otherT.y) === selfRow) continue;
      const box = textElementAabb(otherT);
      if (box.y > selfRow + 1 || box.y + box.h < selfRow - 1) continue;
      const rEdge = box.x + box.w;
      if (rEdge >= selfAabb.x - 2 && rEdge <= selfAabb.x + 2) {
        if (!best || rEdge > best.rightEdge) best = { el: otherT, rightEdge: rEdge };
      }
    }
    return best;
  })();

  if (crossAbutEl) {
    const blocker = crossAbutEl.el;
    return {
      kind: "apply",
      setFocusedId: blocker.id,
      caret: { on: "editor", elId: blocker.id, charOffset: blocker.text.length },
    };
  }

  if (e.altKey) {
    const alignX = el.x;
    const rowCur = snapTextLineY(el.y);
    const rowAbove = rowCur - TEXT_LINE_HEIGHT;
    const hitAbove = textGlyphColumnOnRow(elements, alignX, rowAbove);
    const spliceUpAllowed =
      hitAbove != null &&
      columnAlignsWithGlyphBoundaryInText(hitAbove.x, hitAbove.text, alignX, textScale(hitAbove));

    if (spliceUpAllowed) {
      const liftedText = adapter.value;
      const liftedHtml = adapter.editor.getHTML();
      const removeIds = new Set([el.id]);
      const aboveRow = canvasTextsSameRowSorted(elements, rowAbove);
      if (aboveRow.length > 0) {
        const hitIdx = aboveRow.findIndex((t) => t.id === hitAbove.id);
        const mergedHitText = hitAbove.text + liftedText;
        const mergedHitHtml = (hitAbove.html ?? legacyMarkdownToHTML(hitAbove.text)) + liftedHtml;
        const caretIdx = hitAbove.text.length;
        const hitOldRight = hitAbove.x + textGlyphWidth(hitAbove);
        const hitNewRight = hitAbove.x + canvasTextWidth(mergedHitText, textScale(hitAbove));
        const deltaX = hitNewRight - hitOldRight;
        const shiftRightIds = new Set(aboveRow.slice(hitIdx + 1).map((t) => t.id));

        const shiftBelow = textsBelowRowHittingColumn(elements, alignX, rowCur);
        const shiftIds = new Set(shiftBelow.map((t) => t.id));
        for (const id of removeIds) shiftIds.delete(id);

        return {
          kind: "apply",
          op: {
            kind: "transform",
            fn: (all) => {
              const H = TEXT_LINE_HEIGHT;
              return all
                .filter((x) => !removeIds.has(x.id))
                .map((x) => {
                  if (x.type === "text" && x.id === hitAbove.id) {
                    return { ...x, text: mergedHitText, html: mergedHitHtml, y: snapTextLineY(x.y) };
                  }
                  if (x.type === "text" && shiftRightIds.has(x.id)) {
                    return { ...x, x: x.x + deltaX, y: snapTextLineY(x.y) };
                  }
                  if (x.type === "text" && shiftIds.has(x.id)) {
                    return { ...x, y: snapTextLineY(x.y) - H };
                  }
                  return x;
                });
            },
            anchorIds: new Set([hitAbove.id]),
            resolve: dragResolvePush(),
          },
          response: { merge: { focusId: hitAbove.id, caret: caretIdx } },
        };
      }
    }

    const ch = approxCharWidthCanvas();
    const mergeReachPx = OPTION_BACKSPACE_CHAR_STEPS * ch;
    if (L) {
      const gapPx = el.x - (L.x + textGlyphWidth(L));
      if (gapPx <= mergeReachPx) return makeMerge(L, el);
    }
    const abutLRow =
      L && L.x + textGlyphWidth(L) < el.x - 0.5 ? L.x + textGlyphWidth(L) : null;
    const abutLCross = nearestBlockingRightEdgeLeft(elements, el);
    const abutL = abutLRow != null && abutLCross != null
      ? Math.max(abutLRow, abutLCross)
      : abutLCross ?? abutLRow;
    const newX = tabJumpTargetLeft(el.x, ch, OPTION_BACKSPACE_CHAR_STEPS, abutL);
    if (Math.abs(newX - el.x) < 0.5) return { kind: "handled" };
    return {
      kind: "apply",
      op: { kind: "move", id: el.id, to: { x: newX, y: snapTextLineY(el.y) }, resolve: dragResolvePush() },
      response: { merge: { focusId: el.id, caret: null }, immediate: false },
      caret: { on: "self", start: 0, end: 0 },
    };
  }

  if (L && canvasTextBoxesCollide(L, el)) return makeMerge(L, el);

  const nudge = Math.max(6, canvasTextWidth("n"));
  let newX = el.x - nudge;
  if (crossBlockRightEdge != null && newX < crossBlockRightEdge) newX = crossBlockRightEdge;
  if (Math.abs(newX - el.x) < 0.5) return { kind: "handled" };

  const nudged: TextEl = { ...el, x: newX, y: snapTextLineY(el.y) };
  if (L && canvasTextBoxesCollide(L, nudged)) return makeMerge(L, nudged);

  return {
    kind: "apply",
    op: { kind: "move", id: el.id, to: { x: newX, y: snapTextLineY(el.y) }, resolve: dragResolvePush() },
    response: { merge: { focusId: el.id, caret: null }, immediate: false },
    caret: { on: "self", start: 0, end: 0 },
  };
}

/** Escape: blur the editor, reset vertical column anchor. */
export function handleTextEscape(
  e: KeyboardEvent,
  deps: TextInteractionDeps,
): TextEventResult {
  if (e.key !== "Escape") return { kind: "default" };
  deps.verticalColumnRef.current = null;
  return { kind: "apply", blur: true };
}

/**
 * Tab: two behaviours.
 *   - at end of a command-prefixed line → cycle through completions (/chat, /graph subcommands)
 *   - otherwise → nudge the whole text fragment to the next 5-char grid column (left w/ Shift)
 *     or insert a tab character if inside non-empty text
 */
export function handleTextTab(
  e: KeyboardEvent,
  adapter: TiptapTextAdapter,
  el: TextEl,
  elements: CanvasEl[],
  hasActiveNote: boolean,
  deps: TextInteractionDeps,
): TextEventResult {
  if (e.key !== "Tab" || e.altKey || e.metaKey || e.ctrlKey) return { kind: "default" };

  const lo = Math.min(adapter.selectionStart, adapter.selectionEnd);
  const hi = Math.max(adapter.selectionStart, adapter.selectionEnd);
  if (lo !== hi) return { kind: "default" };

  if (!hasActiveNote) return { kind: "default" };
  const cur = elements.find((x) => x.id === el.id && x.type === "text") as TextEl | undefined;
  if (!cur) return { kind: "default" };

  const text = adapter.value;

  // Tab completion — only at end of text, not shift
  if (!e.shiftKey && lo === text.length) {
    let completion: string | null = null;
    const prev = deps.cmdTabRef.current;

    if (/^\/[a-zA-Z]+$/.test(text)) {
      if (prev && prev.matches.length > 0 && text === prev.matches[prev.index]) {
        const nextIndex = (prev.index + 1) % prev.matches.length;
        deps.cmdTabRef.current = { ...prev, index: nextIndex };
        completion = prev.matches[nextIndex];
      } else {
        const matches = commandsWithPrefix(text);
        if (matches.length > 0) {
          deps.cmdTabRef.current = { prefix: text, matches, index: 0 };
          completion = matches[0];
        }
      }
    }

    const GRAPH_SUBCMDS = ["scale", "delete", "place"];
    const graphSubMatch = text.match(/^(\/graph\s+\d+\s+)([a-zA-Z]*)$/);
    if (!completion && graphSubMatch) {
      const prefix = graphSubMatch[1];
      const partial = graphSubMatch[2].toLowerCase();
      if (prev && prev.matches.length > 0 && text === prev.matches[prev.index]) {
        const nextIndex = (prev.index + 1) % prev.matches.length;
        deps.cmdTabRef.current = { ...prev, index: nextIndex };
        completion = prev.matches[nextIndex];
      } else {
        const matches = (partial ? GRAPH_SUBCMDS.filter((s) => s.startsWith(partial)) : GRAPH_SUBCMDS)
          .map((s) => prefix + s);
        if (matches.length > 0) {
          deps.cmdTabRef.current = { prefix: text, matches, index: 0 };
          completion = matches[0];
        }
      }
    }

    if (completion) {
      e.preventDefault();
      return {
        kind: "apply",
        replaceContent: { html: `<p>${completion}</p>`, plainText: completion },
      };
    }
    deps.cmdTabRef.current = null;
  } else {
    deps.cmdTabRef.current = null;
  }

  const chW = approxCharWidthCanvas();
  const row = canvasTextsSameRowSorted(elements, cur.y);
  const sid = el.id;

  e.preventDefault();
  deps.verticalColumnRef.current = null;

  const nudgeResult = (newX: number): TextEventResult => {
    const dir: 1 | -1 = newX > cur.x ? 1 : -1;
    return {
      kind: "apply",
      op: {
        kind: "move",
        id: sid,
        to: { x: newX, y: snapTextLineY(cur.y) },
        resolve: Math.abs(newX - cur.x) > 0.5 ? horizontalTextPush(dir) : undefined,
      },
      response: { merge: { focusId: sid, caret: lo } },
    };
  };

  // Inside non-empty text: insert tab-width spacing. We use four non-breaking
  // spaces because `\t` and regular spaces both collapse when Tiptap's HTML
  // parser re-processes content on re-mount (setContent normalizes whitespace).
  // NBSPs survive the round-trip, render with full width under `white-space:
  // pre-wrap`, and don't act as word-break boundaries. Tiptap's onUpdate syncs
  // the element state automatically — no replaceContent needed.
  if (text.length > 0 && !e.shiftKey) {
    adapter.editor.commands.insertContent("\u00A0\u00A0\u00A0\u00A0");
    return { kind: "handled" };
  }

  if (e.shiftKey) {
    const L = leftTextNeighborOnRow(row, cur.id);
    const abutLRow = L && L.x + textGlyphWidth(L) < cur.x - 0.5 ? L.x + textGlyphWidth(L) : null;
    const abutLCross = nearestBlockingRightEdgeLeft(elements, cur);
    const abutL = abutLRow != null && abutLCross != null
      ? Math.max(abutLRow, abutLCross)
      : abutLCross ?? abutLRow;
    const newX = tabJumpTargetLeft(cur.x, chW, OPTION_BACKSPACE_CHAR_STEPS, abutL);
    if (newX >= cur.x - 0.5) return { kind: "handled" };
    return nudgeResult(newX);
  }

  const Rwhole = rightTextFromColumn(row, cur.id, cur.x);
  const neighborLeftWhole = Rwhole && Rwhole.x > cur.x + 0.5 ? Rwhole.x : null;
  const newXWhole = tabJumpTargetRight(cur.x, chW, OPTION_BACKSPACE_CHAR_STEPS, neighborLeftWhole);
  if (newXWhole <= cur.x + 0.5) return { kind: "handled" };
  return nudgeResult(newXWhole);
}

/** Cmd/Ctrl+ArrowLeft/Right at fragment edge: focus the neighbor on the row (or cross-row blocker). */
export function handleTextCmdArrowLR(
  e: KeyboardEvent,
  adapter: TiptapTextAdapter,
  el: TextEl,
  elements: CanvasEl[],
  hasActiveNote: boolean,
): TextEventResult {
  if (!((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey)) return { kind: "default" };
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return { kind: "default" };

  const lo = Math.min(adapter.selectionStart, adapter.selectionEnd);
  const hi = Math.max(adapter.selectionStart, adapter.selectionEnd);
  if (lo !== hi) return { kind: "default" };

  if (!hasActiveNote) return { kind: "default" };
  const cur = elements.find((x) => x.id === el.id && x.type === "text") as TextEl | undefined;
  if (!cur) return { kind: "default" };

  const text = adapter.value;
  const row = canvasTextsSameRowSorted(elements, cur.y);

  if (e.key === "ArrowRight" && lo === text.length) {
    const tailX = caretGlyphX(cur, text.length);
    const R = rightTextFromColumn(row, cur.id, tailX);
    if (R) {
      e.preventDefault();
      return { kind: "apply", setFocusedId: R.id, caret: { on: "cmdArrow", elId: R.id, caret: 0 } };
    }
    const crossRight = crossRowTextAbuttingRight(elements, cur, tailX);
    if (crossRight) {
      e.preventDefault();
      const c = canvasCaretIndexAtX(crossRight.text, crossRight.x, tailX, textScale(crossRight));
      return { kind: "apply", setFocusedId: crossRight.id, caret: { on: "cmdArrow", elId: crossRight.id, caret: c } };
    }
  }
  if (e.key === "ArrowLeft" && lo === 0) {
    const L = leftTextNeighborBeforeColumn(row, cur.id, cur.x);
    if (L) {
      e.preventDefault();
      return { kind: "apply", setFocusedId: L.id, caret: { on: "cmdArrow", elId: L.id, caret: L.text.length } };
    }
    const crossLeft = crossRowTextAbuttingLeft(elements, cur, cur.x);
    if (crossLeft) {
      e.preventDefault();
      return { kind: "apply", setFocusedId: crossLeft.id, caret: { on: "cmdArrow", elId: crossLeft.id, caret: crossLeft.text.length } };
    }
  }
  return { kind: "default" };
}

/** Cmd/Ctrl+ArrowUp/Down: swap with vertically-overlapping neighbor, or move by one line. */
export function handleTextCmdArrowUD(
  e: KeyboardEvent,
  adapter: TiptapTextAdapter,
  el: TextEl,
  elements: CanvasEl[],
  hasActiveNote: boolean,
  deps: TextInteractionDeps,
): TextEventResult {
  if (!((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey)) return { kind: "default" };
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return { kind: "default" };

  const lo = Math.min(adapter.selectionStart, adapter.selectionEnd);
  if (!hasActiveNote) return { kind: "default" };
  const cur = elements.find((x) => x.id === el.id && x.type === "text") as TextEl | undefined;
  if (!cur) return { kind: "default" };

  deps.verticalColumnRef.current = null;
  e.preventDefault();
  const rowCur = snapTextLineY(cur.y);
  const curH = textElHeight(cur);
  const dir: 1 | -1 = e.key === "ArrowUp" ? -1 : 1;
  const sid = cur.id;

  const candidateY = dir === -1 ? snapTextLineY(rowCur - curH) : snapTextLineY(rowCur + curH);

  const curAabb = elementTightCanvasAabb(cur);
  if (!curAabb) return { kind: "handled" };
  const ghostAabb: CanvasAabb = { x: curAabb.x, y: candidateY, w: curAabb.w, h: curH };

  let partner: TextEl | null = null;
  for (const other of elements) {
    if (other.type !== "text" || other.id === cur.id) continue;
    const a = elementTightCanvasAabb(other);
    if (!a) continue;
    if (!canvasAABBsTouchOrOverlap(ghostAabb, a, -1)) continue;
    if (!partner) { partner = other as TextEl; continue; }
    const pA = elementTightCanvasAabb(partner)!;
    const curMid = curAabb.y + curAabb.h / 2;
    if (Math.abs(a.y + a.h / 2 - curMid) < Math.abs(pA.y + pA.h / 2 - curMid)) {
      partner = other as TextEl;
    }
  }

  if (partner) {
    return {
      kind: "apply",
      op: { kind: "swap", a: sid, b: partner.id, direction: dir },
      response: { merge: { focusId: sid, caret: lo } },
    };
  }
  return {
    kind: "apply",
    op: { kind: "move", id: sid, to: { y: candidateY } },
    response: { merge: { focusId: sid, caret: lo } },
  };
}

/**
 * Plain Arrow keys (no Cmd/Ctrl). Covers:
 *   - ⌥+←/→: leave fragment to empty at nearest snap column (or word-wise inside text, delegated to Tiptap)
 *   - ←/→: fragment-edge nudge or focus neighbor
 *   - ↑/↓: vertical column-locked navigation between fragments
 */
export function handleTextArrow(
  e: KeyboardEvent,
  adapter: TiptapTextAdapter,
  el: TextEl,
  elements: CanvasEl[],
  editorMap: Map<string, Editor>,
  hasActiveNote: boolean,
  deps: TextInteractionDeps,
): TextEventResult {
  const isArrow = !e.shiftKey && !e.metaKey && !e.ctrlKey &&
    (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown");
  if (!isArrow) return { kind: "default" };

  const lo = Math.min(adapter.selectionStart, adapter.selectionEnd);
  const hi = Math.max(adapter.selectionStart, adapter.selectionEnd);
  if (lo !== hi) return { kind: "default" };

  if (!hasActiveNote) return { kind: "default" };
  const cur = elements.find((x) => x.id === el.id && x.type === "text") as TextEl | undefined;
  if (!cur) return { kind: "default" };

  const text = adapter.value;
  const row = canvasTextsSameRowSorted(elements, cur.y);
  const chW = approxCharWidthCanvas();

  // ⌥ + ←/→: leave fragment or word-wise inside text
  if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    deps.verticalColumnRef.current = null;
    const stepPx = OPTION_BACKSPACE_CHAR_STEPS * chW;
    const isEmpty = isTextBlank(text);

    if (e.key === "ArrowLeft") {
      if (!isEmpty && lo !== 0) return { kind: "default" }; // word-wise → Tiptap
      const crossLeft = crossRowTextAbuttingLeft(elements, cur, cur.x);
      if (crossLeft) {
        e.preventDefault();
        return {
          kind: "apply",
          setFocusedId: crossLeft.id,
          caret: { on: "editor", elId: crossLeft.id, charOffset: crossLeft.text.length },
        };
      }
      const L = leftTextNeighborOnRow(row, cur.id);
      const abutLRow = L && L.x + textGlyphWidth(L) < cur.x - 0.5 ? L.x + textGlyphWidth(L) : null;
      const abutLCross = nearestBlockingRightEdgeLeft(elements, cur);
      const abutL = abutLRow != null && abutLCross != null
        ? Math.max(abutLRow, abutLCross)
        : abutLCross ?? abutLRow;
      const destX = pickNearerLeftSnapX(cur.x, stepPx, abutL);
      if (Math.abs(destX - cur.x) < 0.5) { e.preventDefault(); return { kind: "handled" }; }
      e.preventDefault();
      return leaveToEmptyAtResult(el.id, text, destX, cur.y);
    }

    if (e.key === "ArrowRight") {
      if (!isEmpty && lo !== text.length) return { kind: "default" };
      const tailX = caretGlyphX(cur, text.length);
      const crossRight = crossRowTextAbuttingRight(elements, cur, tailX);
      if (crossRight) {
        e.preventDefault();
        const c = canvasCaretIndexAtX(crossRight.text, crossRight.x, tailX, textScale(crossRight));
        return {
          kind: "apply",
          setFocusedId: crossRight.id,
          caret: { on: "editor", elId: crossRight.id, charOffset: c },
        };
      }
      const R = rightTextFromColumn(row, cur.id, tailX);
      const neighborLeftRow = R && R.x > tailX + 0.5 ? R.x : null;
      const neighborLeftCross = nearestBlockingLeftEdgeRight(elements, cur, tailX);
      const neighborLeft = neighborLeftRow != null && neighborLeftCross != null
        ? Math.min(neighborLeftRow, neighborLeftCross)
        : neighborLeftCross ?? neighborLeftRow;
      const destXR = pickJumpDestRight(tailX, neighborLeft, stepPx);
      if (destXR == null || destXR <= tailX + 0.5) { e.preventDefault(); return { kind: "handled" }; }
      e.preventDefault();
      return leaveToEmptyAtResult(el.id, text, destXR, cur.y);
    }
  }

  // ←/→ without Alt: fragment-edge nudge or neighbor focus
  if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && !e.altKey) {
    const isRight = e.key === "ArrowRight";
    deps.verticalColumnRef.current = null;
    if (isRight ? lo !== text.length : lo !== 0) return { kind: "default" };
    e.preventDefault();
    if (isTextBlank(text)) {
      const newX = cur.x + (isRight ? chW : -chW);
      return {
        kind: "apply",
        op: { kind: "move", id: el.id, to: { x: newX, y: snapTextLineY(cur.y) } },
        response: { merge: { focusId: el.id, caret: lo } },
      };
    }
    const destX = isRight ? caretGlyphX(cur, text.length) + chW : cur.x - chW;
    const res = resolveTextClick(elements, destX, cur.y);
    if (res.action === "caret" && res.id !== cur.id) {
      const target = elements.find((x) => x.id === res.id) as TextEl;
      return {
        kind: "apply",
        setFocusedId: target.id,
        caret: { on: "editor", elId: target.id, charOffset: res.caretIndex },
      };
    }
    const { op, id } = spawnText(destX, snapTextLineY(cur.y));
    return { kind: "apply", op, setNewElId: id };
  }

  // ↑/↓ without Alt: column-locked vertical navigation
  if (!e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    const dir = e.key === "ArrowUp" ? -1 : 1;
    const editorInst = editorMap.get(el.id);
    if (editorInst) {
      const { $from } = editorInst.state.selection;
      const doc = editorInst.state.doc;
      if (dir === -1) {
        if (doc.firstChild && $from.start(1) !== 1) return { kind: "default" };
      } else {
        if (doc.lastChild) {
          const lastBlockStart = doc.content.size - doc.lastChild.nodeSize;
          if ($from.start(1) !== lastBlockStart + 1) return { kind: "default" };
        }
      }
    }
    e.preventDefault();
    const colX = deps.verticalColumnRef.current ?? caretGlyphX(cur, lo);
    deps.verticalColumnRef.current = colX;
    const curH = textElHeight(cur);
    const k = textScale(cur);
    const lineH = textLineHeightForScale(k);
    let ty = snapTextLineY(dir === -1 ? cur.y - lineH : cur.y + curH);
    const ghost: TextEl = { id: "ghost", type: "text", x: colX, y: ty, text: "", measuredW: 4, measuredH: lineH };
    let hit = tryPlace(elements, ghost);
    for (let i = 1; i <= 5 && hit && hit.id === cur.id; i++) {
      ty = snapTextLineY(cur.y + dir * ((dir === 1 ? curH : 0) + lineH * i));
      hit = tryPlace(elements, { ...ghost, y: ty });
    }
    if (hit && hit.type === "text") {
      const target = hit as TextEl;
      const c = canvasCaretIndexAtX(target.text, target.x, colX, textScale(target));
      return {
        kind: "apply",
        setFocusedId: target.id,
        caret: { on: "editor", elId: target.id, charOffset: c },
      };
    }
    const { op, id } = spawnText(colX, ty);
    return { kind: "apply", op, setNewElId: id };
  }

  return { kind: "default" };
}

/** Leave the current (empty-ok) fragment and place an empty new one at `destX`. Shared by ⌥+← and ⌥+→. */
function leaveToEmptyAtResult(selfId: string, selfText: string, destX: number, origY: number): TextEventResult {
  const newId = crypto.randomUUID();
  const y = snapTextLineY(origY);
  const dropEmptySelf = isTextBlank(selfText);
  const newbie: TextEl = { id: newId, type: "text", x: destX, y, text: "" };
  return {
    kind: "apply",
    op: {
      kind: "transform",
      fn: (all) => {
        const base = dropEmptySelf ? all.filter((x) => x.id !== selfId) : all;
        return [...base, newbie];
      },
    },
    response: { merge: { focusId: newId, caret: 0 } },
  };
}
