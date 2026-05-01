// Live-drag state machines. Each drag has a `.move(ref, event, deps)` that
// mutates the ref in place and writes direct DOM updates (so the drag runs
// at ~60fps without re-rendering React), and a `.commit(ref, deps)` that
// dispatches the single React state mutation on pointerup.

import type { Editor } from "@tiptap/react";
import type { RefObject } from "react";
import { canvasCaretIndexAtPoint } from "./canvas-utils";
import { charOffsetToPmPos } from "../components/RichTextEditor";
import type {
  ArrowEl,
  CanvasEl,
  ImageEl,
  PageRegion,
  PlacementOp,
  PlacementResponse,
  ShapeEl,
  TextEl,
} from "./canvas-types";

// ── Drag state shapes ───────────────────────────────────────────────────────

export type PageMarginDragState = {
  id: string;
  axis: "x" | "y";
  side: "start" | "end";
  originClient: number;
  startMargin: number;
  w: number;
  h: number;
  last?: number;
};

export type PageRegionDragState = {
  id: string;
  originClient: { x: number; y: number };
  originPr: { x: number; y: number };
  lastXY?: { x: number; y: number };
};

export type ArrowTipDragState = {
  arrowId: string;
  endpoint: "start" | "end";
  cx: number;
  cy: number;
};

export type ShapeResizeDragState = {
  shapeId: string;
  corner: "tl" | "tr" | "bl" | "br";
  x: number;
  y: number;
  w: number;
  h: number;
};

export type ImageResizeDragState = {
  imageId: string;
  corner: "tl" | "tr" | "bl" | "br";
  origX: number;
  origY: number;
  origW: number;
  origH: number;
  startScreenX: number;
  startScreenY: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type TextSelectDragState = {
  elId: string;
  anchor: number;
};

// ── Shared deps ─────────────────────────────────────────────────────────────

export interface DragDeps {
  canvasWorldRef: RefObject<HTMLDivElement | null>;
  viewportRef: RefObject<HTMLDivElement | null>;
  /** Current canvas scale, read from `transformRef` (always fresh). */
  getScale: () => number;
  /** Convert client-coords to canvas-coords via current viewport rect + offset/scale. */
  toCanvasPoint: (e: { clientX: number; clientY: number }) => { x: number; y: number };
  /** Latest elements array (source of truth). */
  readAllElements: () => CanvasEl[];
  /** Look up the Tiptap editor for a text element id (for live selection drags). */
  getTextEditor: (elId: string) => Editor | undefined;
  execPlace: (
    op: PlacementOp,
    opts?: PlacementResponse & { immediate?: boolean; skipHistory?: boolean; changedId?: string },
  ) => void;
  commitPageRegions: (
    mutator: (regions: PageRegion[]) => PageRegion[],
    opts?: { skipHistory?: boolean },
  ) => void;
}

// ── Page margin drag ────────────────────────────────────────────────────────

export const pageMarginDrag = {
  move(ref: PageMarginDragState, e: { clientX: number; clientY: number }, deps: DragDeps) {
    const sc = deps.getScale();
    const cur = ref.axis === "x" ? e.clientX : e.clientY;
    const rawDelta = (cur - ref.originClient) / sc;
    const delta = ref.side === "end" ? -rawDelta : rawDelta;
    const dim = ref.axis === "x" ? ref.w : ref.h;
    const next = Math.max(0, Math.min(dim / 2, ref.startMargin + delta));
    ref.last = next;

    const marker = deps.canvasWorldRef.current?.querySelector(
      `[data-page-margin-marker="${ref.id}"]`,
    ) as HTMLElement | null;
    if (marker) {
      if (ref.axis === "x") { marker.style.left = `${next}px`; marker.style.right = `${next}px`; }
      else                  { marker.style.top  = `${next}px`; marker.style.bottom = `${next}px`; }
    }
    // Slide the two handles on that axis to the new margin position.
    const region = deps.canvasWorldRef.current?.querySelector(
      `[data-page-region-id="${ref.id}"]`,
    ) as HTMLElement | null;
    if (region) {
      const handles = region.querySelectorAll<HTMLElement>(".page-region-handle");
      const handleThick = 10 / sc;
      handles.forEach((el) => {
        const isX = el.style.cursor === "ew-resize";
        if (isX !== (ref.axis === "x")) return;
        const curPos = parseFloat(isX ? el.style.left : el.style.top);
        const mid = (isX ? ref.w : ref.h) / 2;
        const isStart = curPos < mid;
        const crossPos = isStart ? next : (isX ? ref.w : ref.h) - next;
        if (isX) el.style.left = `${crossPos - handleThick / 2}px`;
        else     el.style.top  = `${crossPos - handleThick / 2}px`;
      });
    }
  },
  commit(ref: PageMarginDragState, deps: DragDeps) {
    if (ref.last == null) return;
    const val = ref.last;
    const key = ref.axis === "x" ? "marginX" : "marginY";
    deps.commitPageRegions((rs) => rs.map((r) => (r.id === ref.id ? { ...r, [key]: val } : r)));
  },
};

// ── Page region drag ────────────────────────────────────────────────────────

export const pageRegionDrag = {
  move(ref: PageRegionDragState, e: { clientX: number; clientY: number }, deps: DragDeps) {
    const sc = deps.getScale();
    const dx = (e.clientX - ref.originClient.x) / sc;
    const dy = (e.clientY - ref.originClient.y) / sc;
    const nx = ref.originPr.x + dx;
    const ny = ref.originPr.y + dy;
    ref.lastXY = { x: nx, y: ny };
    const node = deps.canvasWorldRef.current?.querySelector(
      `[data-page-region-id="${ref.id}"]`,
    ) as HTMLElement | null;
    if (node) {
      node.style.left = `${nx}px`;
      node.style.top = `${ny}px`;
    }
  },
  commit(ref: PageRegionDragState, deps: DragDeps) {
    if (!ref.lastXY) return;
    const { x, y } = ref.lastXY;
    deps.commitPageRegions((rs) => rs.map((r) => (r.id === ref.id ? { ...r, x, y } : r)));
  },
};

// ── Text selection drag ─────────────────────────────────────────────────────

export const textSelectDrag = {
  move(ref: TextSelectDragState, e: { clientX: number; clientY: number }, deps: DragDeps) {
    const el = deps.readAllElements().find((x) => x.id === ref.elId && x.type === "text") as TextEl | undefined;
    if (!el) return;
    const cp = deps.toCanvasPoint(e);
    const cur = canvasCaretIndexAtPoint(el, cp.x, cp.y);
    const ed = deps.getTextEditor(ref.elId);
    if (!ed) return;
    const start = Math.min(ref.anchor, cur);
    const end = Math.max(ref.anchor, cur);
    const from = charOffsetToPmPos(ed.state.doc, start);
    const to = charOffsetToPmPos(ed.state.doc, end);
    ed.commands.setTextSelection({ from, to });
  },
  // No commit — releasing the mouse just leaves the selection in place.
};

// ── Arrow endpoint drag ─────────────────────────────────────────────────────

export const arrowTipDrag = {
  move(ref: ArrowTipDragState, e: { clientX: number; clientY: number }, deps: DragDeps) {
    const arrow = deps.readAllElements().find(
      (el) => el.id === ref.arrowId && el.type === "arrow",
    ) as ArrowEl | undefined;
    if (!arrow) return;
    const cp = deps.toCanvasPoint(e);
    const vp = deps.viewportRef.current;
    if (vp) {
      const g = vp.querySelector(`[data-el-id="${ref.arrowId}"]`);
      if (g) {
        const lines = g.querySelectorAll("line");
        lines.forEach((line) => {
          if (ref.endpoint === "end") {
            line.setAttribute("x2", String(cp.x)); line.setAttribute("y2", String(cp.y));
          } else {
            line.setAttribute("x1", String(cp.x)); line.setAttribute("y1", String(cp.y));
          }
        });
        const circles = g.querySelectorAll("circle");
        const circleIdx = ref.endpoint === "start" ? 0 : 1;
        if (circles[circleIdx]) {
          circles[circleIdx].setAttribute("cx", String(cp.x));
          circles[circleIdx].setAttribute("cy", String(cp.y));
        }
      }
    }
    ref.cx = cp.x;
    ref.cy = cp.y;
  },
  commit(ref: ArrowTipDragState, deps: DragDeps) {
    const changes = ref.endpoint === "end" ? { x2: ref.cx, y2: ref.cy } : { x1: ref.cx, y1: ref.cy };
    deps.execPlace({ kind: "mutate", id: ref.arrowId, changes: changes as Partial<CanvasEl> });
  },
};

// ── Shape corner resize ─────────────────────────────────────────────────────

export const shapeResizeDrag = {
  move(ref: ShapeResizeDragState, e: { clientX: number; clientY: number }, deps: DragDeps) {
    const shape = deps.readAllElements().find(
      (el) => el.id === ref.shapeId && el.type === "shape",
    ) as ShapeEl | undefined;
    if (!shape) return;

    const cp = deps.toCanvasPoint(e);
    const orig = { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
    let nx: number, ny: number, nw: number, nh: number;
    if (ref.corner === "br") {
      nx = orig.x; ny = orig.y; nw = cp.x - orig.x; nh = cp.y - orig.y;
    } else if (ref.corner === "bl") {
      nx = cp.x; ny = orig.y; nw = orig.x + orig.w - cp.x; nh = cp.y - orig.y;
    } else if (ref.corner === "tr") {
      nx = orig.x; ny = cp.y; nw = cp.x - orig.x; nh = orig.y + orig.h - cp.y;
    } else {
      nx = cp.x; ny = cp.y; nw = orig.x + orig.w - cp.x; nh = orig.y + orig.h - cp.y;
    }
    // Enforce minimum size (pin the opposite edge)
    if (nw < 10) { nw = 10; if (ref.corner === "tl" || ref.corner === "bl") nx = orig.x + orig.w - 10; }
    if (nh < 10) { nh = 10; if (ref.corner === "tl" || ref.corner === "tr") ny = orig.y + orig.h - 10; }

    const vp = deps.viewportRef.current;
    if (vp) {
      const node = vp.querySelector(`[data-el-id="${ref.shapeId}"]`) as HTMLElement | null;
      if (node) {
        node.style.left = `${nx}px`; node.style.top = `${ny}px`;
        node.style.width = `${nw}px`; node.style.height = `${nh}px`;
        const handles = node.querySelectorAll<HTMLElement>("[data-corner]");
        handles.forEach((h) => {
          const c = h.dataset.corner;
          if (c === "tl") { h.style.left = "-4px"; h.style.top = "-4px"; }
          else if (c === "tr") { h.style.left = `${nw - 4}px`; h.style.top = "-4px"; }
          else if (c === "bl") { h.style.left = "-4px"; h.style.top = `${nh - 4}px`; }
          else if (c === "br") { h.style.left = `${nw - 4}px`; h.style.top = `${nh - 4}px`; }
        });
        // Triangle's inner SVG must track the new dims too.
        const svg = node.querySelector("svg");
        if (svg) {
          svg.setAttribute("width", String(nw));
          svg.setAttribute("height", String(nh));
          const poly = svg.querySelector("polygon");
          if (poly) poly.setAttribute("points", `${nw / 2},0 0,${nh} ${nw},${nh}`);
        }
      }
    }
    ref.x = nx; ref.y = ny; ref.w = nw; ref.h = nh;
  },
  commit(ref: ShapeResizeDragState, deps: DragDeps) {
    deps.execPlace({
      kind: "mutate",
      id: ref.shapeId,
      changes: { x: ref.x, y: ref.y, w: ref.w, h: ref.h } as Partial<CanvasEl>,
    });
    // Hide the corner handles — onMouseLeave was suppressed during the drag.
    const vp = deps.viewportRef.current;
    if (vp) {
      const node = vp.querySelector(`[data-el-id="${ref.shapeId}"]`);
      if (node) node.querySelectorAll<HTMLElement>("[data-corner]").forEach((h) => { h.style.opacity = "0"; });
    }
  },
};

// ── Image corner resize (aspect-ratio locked) ───────────────────────────────

export const imageResizeDrag = {
  move(ref: ImageResizeDragState, e: { clientX: number; clientY: number; shiftKey?: boolean }, deps: DragDeps) {
    const sc = deps.getScale();
    const dx = (e.clientX - ref.startScreenX) / sc;
    const ratio = ref.origH / ref.origW;
    const xSign = ref.corner === "tr" || ref.corner === "br" ? 1 : -1;
    // Shift = scale from center, so width changes by 2× the drag distance.
    const factor = e.shiftKey ? 2 : 1;
    const nw = Math.max(24, ref.origW + xSign * dx * factor);
    const nh = Math.round(nw * ratio);
    let nx: number;
    let ny: number;
    if (e.shiftKey) {
      nx = ref.origX + (ref.origW - nw) / 2;
      ny = ref.origY + (ref.origH - nh) / 2;
    } else {
      nx = ref.corner === "tl" || ref.corner === "bl" ? ref.origX + (ref.origW - nw) : ref.origX;
      ny = ref.corner === "tl" || ref.corner === "tr" ? ref.origY + (ref.origH - nh) : ref.origY;
    }
    const vp = deps.viewportRef.current;
    if (vp) {
      const node = vp.querySelector(`[data-el-id="${ref.imageId}"]`) as HTMLElement | null;
      if (node) {
        node.style.left = `${nx}px`;
        node.style.top = `${ny}px`;
        const imgEl = node.querySelector("img") as HTMLImageElement | null;
        if (imgEl) { imgEl.style.width = `${nw}px`; imgEl.style.height = `${nh}px`; }
        // Cropped images wrap the <img> in a clipping div sized to el.w/el.h.
        const wrapper = imgEl?.parentElement as HTMLElement | null;
        if (wrapper && wrapper !== node) {
          wrapper.style.width = `${nw}px`;
          wrapper.style.height = `${nh}px`;
        }
        const half = 4 / sc;
        node.querySelectorAll<HTMLElement>("[data-img-corner]").forEach((h) => {
          const c = h.dataset.imgCorner;
          h.style.left = `${(c === "tl" || c === "bl") ? -half : nw - half}px`;
          h.style.top  = `${(c === "tl" || c === "tr") ? -half : nh - half}px`;
        });
      }
    }
    ref.w = nw; ref.h = nh; ref.x = nx; ref.y = ny;
  },
  commit(ref: ImageResizeDragState, deps: DragDeps) {
    deps.execPlace({
      kind: "mutate",
      id: ref.imageId,
      changes: { x: ref.x, y: ref.y, w: ref.w, h: ref.h } as Partial<CanvasEl>,
    });
  },
};
