"use client";

import { memo, useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { PdfEl, ToolId } from "../lib/canvas-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PDFDocProxy = any;

let pdfjsReady: Promise<typeof import("pdfjs-dist")> | null = null;
function getPdfjs() {
  if (!pdfjsReady) {
    pdfjsReady = import("pdfjs-dist").then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
      return lib;
    });
  }
  return pdfjsReady;
}

// ── Constants ───────────────────────────────────────────────────────────────

const HANDLE_SIZE = 8;
const MIN_W = 200;
const MIN_H = 200;
const PAGE_GAP = 8;

type Edge = "right" | "left" | "top" | "bottom" | "br" | "bl" | "tr" | "tl";
const EDGE_HAS_RIGHT  = new Set<Edge>(["right", "br", "tr"]);
const EDGE_HAS_LEFT   = new Set<Edge>(["left", "bl", "tl"]);
const EDGE_HAS_BOTTOM = new Set<Edge>(["bottom", "br", "bl"]);
const EDGE_HAS_TOP    = new Set<Edge>(["top", "tr", "tl"]);

// ── Props ───────────────────────────────────────────────────────────────────

export interface PdfContainerProps {
  pdfEl: PdfEl;
  canvasScale: number;
  activeTool: ToolId | null;
  locked: boolean;
  onResize: (id: string, changes: Partial<PdfEl>) => void;
}

// ── Component ───────────────────────────────────────────────────────────────

function PdfContainer({ pdfEl, canvasScale, activeTool, locked, onResize }: PdfContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const focusAnchorRef = useRef<HTMLInputElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [pdfDoc, setPdfDoc] = useState<PDFDocProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const textLayerRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const resizeDragRef = useRef<{
    edge: Edge;
    startScreenX: number;
    startScreenY: number;
    startW: number;
    startH: number;
    startX: number;
    startY: number;
    last?: { w: number; h: number; x: number; y: number };
  } | null>(null);

  // ── Load PDF document ──────────────────────────────────────────────────
  useEffect(() => {
    if (!pdfEl.src) return;
    let cancelled = false;
    (async () => {
      try {
        const pdfjsLib = await getPdfjs();
        // Convert data URL to Uint8Array
        const raw = atob(pdfEl.src.split(",")[1]);
        const arr = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);

        const doc = await pdfjsLib.getDocument({ data: arr }).promise;
        if (!cancelled) setPdfDoc(doc);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load PDF");
      }
    })();
    return () => { cancelled = true; };
  }, [pdfEl.src]);

  // ── Render visible pages ───────────────────────────────────────────────
  useEffect(() => {
    if (!pdfDoc) return;
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const activeTextLayers: any[] = [];

    (async () => {
      const pdfjsLib = await getPdfjs();
      for (let i = 1; i <= pdfDoc.numPages; i++) {
        if (cancelled) return;
        const page = await pdfDoc.getPage(i);
        const canvas = canvasRefs.current.get(i);
        if (!canvas || cancelled) continue;

        const viewport = page.getViewport({ scale: 1 });
        const renderScale = (pdfEl.w - 16) / viewport.width; // 16 = padding
        const scaled = page.getViewport({ scale: renderScale });

        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(scaled.width * dpr);
        canvas.height = Math.round(scaled.height * dpr);
        canvas.style.width = `${scaled.width}px`;
        canvas.style.height = `${scaled.height}px`;

        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        await page.render({ canvas, canvasContext: ctx, viewport: scaled }).promise;
        if (cancelled) return;

        // Text-selection overlay: pdfjs lays out transparent positioned spans
        // matching glyph rects so the browser can do native selection + copy.
        const textLayerDiv = textLayerRefs.current.get(i);
        if (!textLayerDiv) continue;
        textLayerDiv.replaceChildren();
        textLayerDiv.style.setProperty("--total-scale-factor", String(renderScale));
        const tl = new pdfjsLib.TextLayer({
          textContentSource: page.streamTextContent(),
          container: textLayerDiv,
          viewport: scaled,
        });
        activeTextLayers.push(tl);
        try { await tl.render(); } catch { /* re-render races; the next pass clears */ }
      }
    })();

    return () => {
      cancelled = true;
      for (const tl of activeTextLayers) {
        try { tl.cancel(); } catch { /* already done */ }
      }
    };
  }, [pdfDoc, pdfEl.w]);

  // ── Resize handlers ────────────────────────────────────────────────────

  const handleResizePointerDown = useCallback((e: React.PointerEvent, edge: Edge) => {
    if (locked) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    resizeDragRef.current = {
      edge,
      startScreenX: e.clientX,
      startScreenY: e.clientY,
      startW: pdfEl.w,
      startH: pdfEl.h,
      startX: pdfEl.x,
      startY: pdfEl.y,
    };
  }, [pdfEl.w, pdfEl.h, pdfEl.x, pdfEl.y, locked]);

  const handleResizePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = resizeDragRef.current;
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();

    const dx = (e.clientX - drag.startScreenX) / canvasScale;
    const dy = (e.clientY - drag.startScreenY) / canvasScale;
    const { edge } = drag;

    let newW = drag.startW;
    let newH = drag.startH;
    let newX = drag.startX;
    let newY = drag.startY;

    if (EDGE_HAS_RIGHT.has(edge))  newW = Math.max(MIN_W, drag.startW + dx);
    if (EDGE_HAS_LEFT.has(edge))   { newW = Math.max(MIN_W, drag.startW - dx); newX = drag.startX + (drag.startW - newW); }
    if (EDGE_HAS_BOTTOM.has(edge)) newH = Math.max(MIN_H, drag.startH + dy);
    if (EDGE_HAS_TOP.has(edge))    { newH = Math.max(MIN_H, drag.startH - dy); newY = drag.startY + (drag.startH - newH); }

    const node = containerRef.current;
    if (node) {
      node.style.left = `${newX}px`;
      node.style.top = `${newY}px`;
      node.style.width = `${newW}px`;
      node.style.height = `${newH}px`;
    }

    drag.last = { w: newW, h: newH, x: newX, y: newY };
  }, [canvasScale]);

  const handleResizePointerUp = useCallback((e: React.PointerEvent) => {
    const drag = resizeDragRef.current;
    if (!drag) return;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    if (drag.last) {
      onResize(pdfEl.id, drag.last);
    }
    resizeDragRef.current = null;
  }, [pdfEl.id, onResize]);

  const showHandles = !locked && (isHovered || resizeDragRef.current != null);

  const resizePointerProps = {
    onPointerMove: handleResizePointerMove,
    onPointerUp: handleResizePointerUp,
  };

  // ── Edge handle helper ─────────────────────────────────────────────────

  const edgeHandle = (edge: Edge, style: React.CSSProperties, cursor: string, pip: React.CSSProperties) => (
    <div
      onPointerDown={(e) => handleResizePointerDown(e, edge)}
      {...resizePointerProps}
      style={{
        position: "absolute",
        cursor,
        opacity: showHandles ? 1 : 0,
        transition: "opacity 0.15s",
        pointerEvents: "auto",
        ...style,
      }}
    >
      <div style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        borderRadius: 3,
        background: "var(--th-text)",
        opacity: 0.55,
        ...pip,
      }} />
    </div>
  );

  const cornerHandle = (edge: Edge, style: React.CSSProperties, cursor: string) => (
    <div
      onPointerDown={(e) => handleResizePointerDown(e, edge)}
      {...resizePointerProps}
      style={{
        position: "absolute",
        width: HANDLE_SIZE * 2,
        height: HANDLE_SIZE * 2,
        cursor,
        opacity: showHandles ? 1 : 0,
        transition: "opacity 0.15s",
        pointerEvents: "auto",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        ...style,
      }}
    >
      <div style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--th-text)", opacity: 0.55 }} />
    </div>
  );

  return (
    <div
      ref={containerRef}
      data-el
      data-el-id={pdfEl.id}
      data-pdf-container
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => { if (!resizeDragRef.current) setIsHovered(false); }}
      onClick={() => {
        if (locked || activeTool === "mover") return;
        focusAnchorRef.current?.focus({ preventScroll: true });
      }}
      onDoubleClick={(e) => {
        if (locked) return;
        e.stopPropagation();
        focusAnchorRef.current?.focus({ preventScroll: true });
      }}
      style={{
        position: "absolute",
        left: pdfEl.x,
        top: pdfEl.y,
        width: pdfEl.w,
        height: pdfEl.h,
        overflow: "visible",
      }}
    >
      {/* Invisible focus anchor (enables scroll capture via wheel handler) */}
      <input
        ref={focusAnchorRef}
        aria-hidden
        tabIndex={-1}
        style={{ position: "absolute", opacity: 0, width: 0, height: 0, pointerEvents: "none" }}
      />

      {/* Scrollable PDF pages */}
      <div
        ref={scrollRef}
        style={{
          width: "100%",
          height: "100%",
          overflow: "auto",
          overscrollBehaviorX: "none",
          borderRadius: 8,
          border: "1px solid var(--th-chart-border)",
          background: "var(--th-surface-hover)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: PAGE_GAP,
          padding: 8,
        }}
      >
        {error ? (
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            fontFamily: "var(--font-lexend), sans-serif",
            fontSize: 13,
            color: "#ef4444",
          }}>
            {error}
          </div>
        ) : (
          <>
            {/* Filename label */}
            <div style={{
              fontFamily: "var(--font-lexend), sans-serif",
              fontSize: 11,
              color: "var(--th-text-muted)",
              alignSelf: "flex-start",
              display: "flex",
              alignItems: "center",
              gap: 4,
              paddingBottom: 2,
            }}>
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>picture_as_pdf</span>
              {pdfEl.filename}
              <span style={{ color: "var(--th-text-faint)", marginLeft: 4 }}>
                {pdfEl.numPages} page{pdfEl.numPages !== 1 ? "s" : ""}
              </span>
            </div>

            {/* Pages */}
            {Array.from({ length: pdfEl.numPages }, (_, i) => {
              const pageNum = i + 1;
              return (
                <div
                  key={pageNum}
                  style={{
                    position: "relative",
                    borderRadius: 4,
                    boxShadow: "0 1px 4px rgba(0,0,0,0.15)",
                    background: "#fff",
                    userSelect: "text",
                  }}
                  // Selection drag must not start a canvas pan.
                  onMouseDown={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <canvas
                    ref={(node) => {
                      if (node) canvasRefs.current.set(pageNum, node);
                      else canvasRefs.current.delete(pageNum);
                    }}
                    style={{ display: "block", borderRadius: 4 }}
                  />
                  <div
                    className="textLayer"
                    ref={(node) => {
                      if (node) textLayerRefs.current.set(pageNum, node);
                      else textLayerRefs.current.delete(pageNum);
                    }}
                  />
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* ── Edge handles ───────────────────────────────────────────────── */}
      {edgeHandle("right",  { top: 0, right: -HANDLE_SIZE / 2, width: HANDLE_SIZE, height: "100%" }, "ew-resize", { width: 5, height: 32 })}
      {edgeHandle("left",   { top: 0, left: -HANDLE_SIZE / 2, width: HANDLE_SIZE, height: "100%" }, "ew-resize", { width: 5, height: 32 })}
      {edgeHandle("bottom", { bottom: -HANDLE_SIZE / 2, left: 0, width: "100%", height: HANDLE_SIZE }, "ns-resize", { width: 32, height: 5 })}
      {edgeHandle("top",    { top: -HANDLE_SIZE / 2, left: 0, width: "100%", height: HANDLE_SIZE }, "ns-resize", { width: 32, height: 5 })}

      {/* ── Corner handles ─────────────────────────────────────────────── */}
      {cornerHandle("br", { bottom: -HANDLE_SIZE / 2, right: -HANDLE_SIZE / 2 }, "nwse-resize")}
      {cornerHandle("tl", { top: -HANDLE_SIZE / 2, left: -HANDLE_SIZE / 2 }, "nwse-resize")}
      {cornerHandle("tr", { top: -HANDLE_SIZE / 2, right: -HANDLE_SIZE / 2 }, "nesw-resize")}
      {cornerHandle("bl", { bottom: -HANDLE_SIZE / 2, left: -HANDLE_SIZE / 2 }, "nesw-resize")}
    </div>
  );
}

export default memo(PdfContainer);
