import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { MIN_SCALE, MAX_SCALE, DEFAULT_SCALE } from "../lib/canvas-types";
import { zoomStep } from "../lib/canvas-utils";

type Transform = { offset: { x: number; y: number }; scale: number };

/**
 * Owns the canvas transform pipeline: rAF-batched scheduling, cursor-anchored zoom,
 * zoom helpers, and the wheel listener. React state (`scale`, `offset`) stays in the shell
 * because many consumers read it directly — the hook just drives it.
 *
 * Note: touch listener is NOT here. It interleaves pan/zoom with marquee selection,
 * so it remains in the shell until the marquee refactor.
 */
export function useCanvasPanZoom(params: {
  viewportRef: RefObject<HTMLElement | null>;
  scale: number;
  offset: { x: number; y: number };
  setScale: (s: number) => void;
  setOffset: (o: { x: number; y: number }) => void;
  /** Invalidate viewport culling after a transform. */
  onTransform?: () => void;
}) {
  const { viewportRef, scale, offset, setScale, setOffset, onTransform } = params;

  const transformRef = useRef<Transform>({ offset: { x: 0, y: 0 }, scale: 1 });
  const pendingTransformRef = useRef<Transform | null>(null);
  const rafIdRef = useRef(0);

  // Sync transform ref on every pan/zoom so drag handlers read the latest value
  // without waiting for React state to commit.
  useLayoutEffect(() => {
    transformRef.current = { offset, scale };
    onTransform?.();
  }, [offset, scale, onTransform]);

  /** Queue a transform update; only the last value per frame flushes to React state. */
  const scheduleTransform = useCallback((newOffset: { x: number; y: number }, newScale: number) => {
    transformRef.current = { offset: newOffset, scale: newScale };
    pendingTransformRef.current = { offset: newOffset, scale: newScale };
    if (!rafIdRef.current) {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = 0;
        const p = pendingTransformRef.current;
        if (p) {
          pendingTransformRef.current = null;
          setOffset(p.offset);
          setScale(p.scale);
        }
      });
    }
  }, [setOffset, setScale]);

  const viewportCenter = useCallback((): { x: number; y: number } => {
    return {
      x: (viewportRef.current?.clientWidth ?? 800) / 2,
      y: (viewportRef.current?.clientHeight ?? 600) / 2,
    };
  }, [viewportRef]);

  const zoomByDiscrete = useCallback((direction: 1 | -1) => {
    const step = zoomStep(scale, 0.3);
    const ns = direction > 0
      ? Math.min(MAX_SCALE, scale + step)
      : Math.max(MIN_SCALE, scale - step);
    const { x: cx, y: cy } = viewportCenter();
    setOffset({ x: cx - (cx - offset.x) * (ns / scale), y: cy - (cy - offset.y) * (ns / scale) });
    setScale(ns);
  }, [scale, offset.x, offset.y, viewportCenter, setOffset, setScale]);

  const zoomByContinuous = useCallback((deltaY: number, cursorX: number, cursorY: number) => {
    const { offset: curOffset, scale: curScale } = transformRef.current;
    const intensity = Math.min(Math.abs(deltaY) / 10, 1);
    const step = zoomStep(curScale, 0.01 + 0.19 * intensity);
    const ns = Math.max(MIN_SCALE, Math.min(MAX_SCALE, deltaY < 0 ? curScale + step : curScale - step));
    scheduleTransform(
      { x: cursorX - (cursorX - curOffset.x) * (ns / curScale), y: cursorY - (cursorY - curOffset.y) * (ns / curScale) },
      ns,
    );
  }, [scheduleTransform]);

  const zoomCenterNormalized = useCallback((targetCanvasX?: number, targetCanvasY?: number, targetScale?: number) => {
    const ns = targetScale ?? DEFAULT_SCALE;
    const { x: vcx, y: vcy } = viewportCenter();
    const canvasCX = (vcx - offset.x) / scale;
    const canvasCY = (vcy - offset.y) / scale;
    const newOffset = (targetCanvasX != null && targetCanvasY != null)
      ? { x: vcx - targetCanvasX * ns, y: vcy - targetCanvasY * ns }
      : (scale === DEFAULT_SCALE && ns === DEFAULT_SCALE)
        ? { x: 0, y: 0 }
        : { x: vcx - canvasCX * ns, y: vcy - canvasCY * ns };
    transformRef.current = { offset: newOffset, scale: ns };
    onTransform?.();
    setOffset(newOffset);
    setScale(ns);
  }, [offset.x, offset.y, scale, viewportCenter, onTransform, setOffset, setScale]);

  // Wheel: two-finger scroll → pan; pinch (ctrl+wheel on trackpad) → zoom toward cursor
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      // Let floating panels (AI chat) scroll themselves
      if ((e.target as HTMLElement).closest("[data-overlay-panel]")) return;
      // Chat containers: pinch-zoom stays with canvas, regular scroll goes to chat
      const chatContainer = (e.target as HTMLElement).closest("[data-chat-container]");
      if (chatContainer && !e.ctrlKey) {
        const hasFocus = chatContainer.contains(document.activeElement);
        const sel = window.getSelection();
        const hasSelection = sel && !sel.isCollapsed && chatContainer.contains(sel.anchorNode);
        if (hasFocus || hasSelection) return;
      }
      // PDF containers: same pattern — click to focus, then scroll goes to PDF
      const pdfContainer = (e.target as HTMLElement).closest("[data-pdf-container]");
      if (pdfContainer && pdfContainer.contains(document.activeElement) && !e.ctrlKey) return;
      // Embed containers: same pattern
      const embedContainer = (e.target as HTMLElement).closest("[data-embed-container]");
      if (embedContainer && embedContainer.contains(document.activeElement) && !e.ctrlKey) return;
      // Table containers never consume wheel — cells grow to fit, so the canvas
      // always owns pan/zoom even while a cell is focused.
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey) {
        zoomByContinuous(e.deltaY, e.clientX - rect.left, e.clientY - rect.top);
      } else {
        const { offset: curOffset, scale: curScale } = transformRef.current;
        scheduleTransform({ x: curOffset.x - e.deltaX, y: curOffset.y - e.deltaY }, curScale);
      }
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [viewportRef, zoomByContinuous, scheduleTransform]);

  return {
    transformRef,
    scheduleTransform,
    viewportCenter,
    zoomByDiscrete,
    zoomByContinuous,
    zoomCenterNormalized,
    zoomPct: Math.round(scale * 100),
  };
}
