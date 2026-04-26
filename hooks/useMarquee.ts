import { useCallback, useRef, useState, type RefObject } from "react";
import type { CanvasEl, ToolId } from "../lib/canvas-types";
import {
  canvasAABBsTouchOrOverlap,
  elementTightCanvasAabb,
  idsHitByMarqueeScreenBox,
} from "../lib/canvas-utils";

export type MarqueeMode = "select" | "eraser" | "text";

export interface MarqueeAnchor { vx: number; vy: number }
export interface MarqueePreview { left: number; top: number; w: number; h: number }
export interface EraseBounds {
  leftCanvas: number;
  rightCanvas: number;
  topCanvas: number;
  bottomCanvas: number;
}

export interface MarqueeCallbacks {
  /** Big-drag select-mode result: element IDs hit, plus the canvas-space rect (used for Backspace char-erase). */
  onSelect: (ids: string[], bounds: EraseBounds) => void;
  /** Big-drag eraser-mode result: element IDs to erase, plus horizontal canvas bounds for text-fragment erase. */
  onErase: (ids: Set<string>, eraseLeftCanvas: number, eraseRightCanvas: number) => void;
  /** Text-mode selection change (fires live during drag AND once on finalize). */
  onTextMarqueeChange: (ids: Set<string>) => void;
  /** Click-suppression flag: set true after a real drag so the following click doesn't place text / deselect. */
  onDismissClick: (dismiss: boolean) => void;
  /** Called on finalize so the component can reset viewport cursor to the active tool's. */
  restoreCursor: () => void;
}

export interface MarqueeStateSnapshot {
  activeId: string | null;
  activeTool: ToolId | null;
  offset: { x: number; y: number };
  scale: number;
}

/** Minimum drag size (in viewport px) before a marquee is treated as a real drag rather than a click. */
const DRAG_GATE = 6;

/** Element types excluded when Shift is held during a select-mode marquee. */
const SHIFT_EXCLUDES = new Set(["draw"]);
/** Element types kept when the draw tool is active (inverse of: only draw is allowed). */
const DRAW_TOOL_EXCLUDES = new Set(["text", "image", "shape", "arrow", "math", "chart"]);

export function useMarquee(
  viewportRef: RefObject<HTMLDivElement | null>,
  stateRef: RefObject<MarqueeStateSnapshot>,
  allElementsRef: RefObject<CanvasEl[]>,
  callbacks: MarqueeCallbacks,
) {
  const [preview, setPreview] = useState<MarqueePreview | null>(null);
  const previewRef = useRef<MarqueePreview | null>(null);
  previewRef.current = preview;

  const modeRef = useRef<MarqueeMode | null>(null);
  const anchorRef = useRef<MarqueeAnchor>({ vx: 0, vy: 0 });
  const shiftRef = useRef(false);
  const touchModeRef = useRef(false);

  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const computeTextMarqueeSel = (
    prev: MarqueePreview,
    off: { x: number; y: number },
    sc: number,
  ): Set<string> => {
    const canvasBox = {
      x: (prev.left - off.x) / sc,
      y: (prev.top - off.y) / sc,
      w: prev.w / sc,
      h: prev.h / sc,
    };
    const sel = new Set<string>();
    for (const el of allElementsRef.current ?? []) {
      if (el.type !== "text" && el.type !== "table") continue;
      const aabb = elementTightCanvasAabb(el);
      if (aabb && canvasAABBsTouchOrOverlap(canvasBox, aabb)) sel.add(el.id);
    }
    return sel;
  };

  const start = useCallback((
    mode: MarqueeMode,
    anchor: MarqueeAnchor,
    opts?: { shift?: boolean; touchMode?: boolean },
  ) => {
    modeRef.current = mode;
    anchorRef.current = anchor;
    shiftRef.current = opts?.shift ?? false;
    touchModeRef.current = opts?.touchMode ?? false;
    setPreview({ left: anchor.vx, top: anchor.vy, w: 0, h: 0 });
  }, []);

  const move = useCallback((cur: MarqueeAnchor) => {
    const mode = modeRef.current;
    if (mode == null) return;
    const ax = anchorRef.current.vx;
    const ay = anchorRef.current.vy;
    const next: MarqueePreview = {
      left: Math.min(ax, cur.vx),
      top: Math.min(ay, cur.vy),
      w: Math.abs(cur.vx - ax),
      h: Math.abs(cur.vy - ay),
    };
    setPreview(next);

    if (mode === "text") {
      const st = stateRef.current;
      if (!st) return;
      const sel = computeTextMarqueeSel(next, st.offset, st.scale);
      callbacksRef.current.onTextMarqueeChange(sel);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finalize = useCallback(() => {
    const mode = modeRef.current;
    if (mode == null) return;
    modeRef.current = null;
    const shiftHeld = shiftRef.current;
    shiftRef.current = false;
    const touchMode = touchModeRef.current;
    touchModeRef.current = false;

    const vp = viewportRef.current;
    const prev = previewRef.current;
    setPreview(null);
    callbacksRef.current.restoreCursor();

    // Size gate. Touch is more permissive (needs both axes below threshold).
    const tooSmall = !prev || (touchMode
      ? (prev.w < DRAG_GATE && prev.h < DRAG_GATE)
      : (prev.w < DRAG_GATE || prev.h < DRAG_GATE));

    if (tooSmall) {
      // Only "select" and "text" explicitly clear dismissClick on a tiny drag.
      // Eraser preserves its prior value; touchMode never touches dismissClick.
      if (!touchMode && mode !== "eraser") {
        callbacksRef.current.onDismissClick(false);
      }
      return;
    }
    if (!vp || !prev) return;

    const st = stateRef.current;
    if (!st) return;
    const aid = st.activeId;
    if (!aid) return;

    const r = vp.getBoundingClientRect();
    const box = {
      left: r.left + prev.left,
      top: r.top + prev.top,
      right: r.left + prev.left + prev.w,
      bottom: r.top + prev.top + prev.h,
    };
    const off = st.offset;
    const sc = st.scale;
    const tool = st.activeTool;

    if (mode === "select") {
      const noteEnvelope = { id: aid, title: "", elements: allElementsRef.current ?? [], updatedAt: 0 };
      const exclude = tool === "draw"
        ? DRAW_TOOL_EXCLUDES
        : (shiftHeld ? SHIFT_EXCLUDES : undefined);
      const ids = idsHitByMarqueeScreenBox(noteEnvelope, box, r, off, sc, exclude);
      const leftCanvas = (box.left - r.left - off.x) / sc;
      const rightCanvas = (box.right - r.left - off.x) / sc;
      const topCanvas = (box.top - r.top - off.y) / sc;
      const bottomCanvas = (box.bottom - r.top - off.y) / sc;
      const bounds: EraseBounds = {
        leftCanvas: Math.min(leftCanvas, rightCanvas),
        rightCanvas: Math.max(leftCanvas, rightCanvas),
        topCanvas: Math.min(topCanvas, bottomCanvas),
        bottomCanvas: Math.max(topCanvas, bottomCanvas),
      };
      callbacksRef.current.onSelect(ids, bounds);
      if (!touchMode) callbacksRef.current.onDismissClick(true);
      return;
    }

    if (mode === "eraser") {
      const noteEnvelope = { id: aid, title: "", elements: allElementsRef.current ?? [], updatedAt: 0 };
      const hitIds = idsHitByMarqueeScreenBox(noteEnvelope, box, r, off, sc);
      callbacksRef.current.onDismissClick(true);
      if (hitIds.length === 0) return;
      const rm = new Set(hitIds);
      const eraseLeftCanvas = (box.left - r.left - off.x) / sc;
      const eraseRightCanvas = (box.right - r.left - off.x) / sc;
      callbacksRef.current.onErase(rm, eraseLeftCanvas, eraseRightCanvas);
      return;
    }

    if (mode === "text") {
      const sel = computeTextMarqueeSel(prev, off, sc);
      callbacksRef.current.onTextMarqueeChange(sel);
      callbacksRef.current.onDismissClick(true);
      return;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isActive = useCallback(() => modeRef.current != null, []);
  const getMode = useCallback(() => modeRef.current, []);

  return { start, move, finalize, preview, isActive, getMode };
}
