"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EmbedEl } from "../lib/canvas-types";

// ── Constants ───────────────────────────────────────────────────────────────

const HANDLE_SIZE = 8;
const MIN_W = 200;
const MIN_H = 200;

type Edge = "right" | "left" | "top" | "bottom" | "br" | "bl" | "tr" | "tl";
const EDGE_HAS_RIGHT  = new Set<Edge>(["right", "br", "tr"]);
const EDGE_HAS_LEFT   = new Set<Edge>(["left", "bl", "tl"]);
const EDGE_HAS_BOTTOM = new Set<Edge>(["bottom", "br", "bl"]);
const EDGE_HAS_TOP    = new Set<Edge>(["top", "tr", "tl"]);

const PROVIDER_ICONS: Record<EmbedEl["provider"], { icon: string; label: string }> = {
  "google-docs":   { icon: "description",      label: "Google Docs" },
  "google-sheets": { icon: "table_chart",       label: "Google Sheets" },
  "google-slides": { icon: "slideshow",         label: "Google Slides" },
  "youtube":       { icon: "play_circle",       label: "YouTube" },
  "generic":       { icon: "language",          label: "Embed" },
};

// ── Info tooltip ────────────────────────────────────────────────────────────

function InfoTip() {
  const [show, setShow] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };

  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  useEffect(() => {
    if (!show || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
  }, [show]);

  return (
    <>
      <span
        ref={anchorRef}
        className="material-symbols-outlined"
        style={{ fontSize: 13, color: "var(--th-text-faint)", cursor: "help", marginLeft: 4, flexShrink: 0 }}
        onMouseEnter={() => { clear(); timer.current = setTimeout(() => setShow(true), 180); }}
        onMouseLeave={() => { clear(); setShow(false); setPos(null); }}
      >info</span>
      {show && pos && createPortal(
        <div style={{
          position: "fixed",
          top: pos.top,
          right: pos.right,
          pointerEvents: "none",
          zIndex: 9999,
          background: "var(--th-surface-overlay)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          border: "0.5px solid var(--th-border-subtle)",
          boxShadow: "0 8px 32px var(--th-shadow-heavy)",
          borderRadius: 10,
          padding: "8px 14px",
          whiteSpace: "nowrap",
          fontFamily: "var(--font-lexend), sans-serif",
          fontSize: 13,
          color: "var(--th-text-secondary)",
          lineHeight: 1.4,
        }}>
          Shannon can only read public documents
        </div>,
        document.body,
      )}
    </>
  );
}

// ── Props ───────────────────────────────────────────────────────────────────

export interface EmbedContainerProps {
  embedEl: EmbedEl;
  canvasScale: number;
  locked: boolean;
  onResize: (id: string, changes: Partial<EmbedEl>) => void;
}

// ── Component ───────────────────────────────────────────────────────────────

function EmbedContainer({ embedEl, canvasScale, locked, onResize }: EmbedContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const focusAnchorRef = useRef<HTMLInputElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [iframeError, setIframeError] = useState(false);
  const [isFocused, setIsFocused] = useState(false);

  // Unfocus when clicking outside the container
  useEffect(() => {
    if (!isFocused) return;
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setIsFocused(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [isFocused]);

  // Prevent horizontal overscroll (browser back/forward) on the container
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
      }
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

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

  // ── Resize handlers ────────────────────────────────────────────────────

  const handleResizePointerDown = useCallback((e: React.PointerEvent, edge: Edge) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    resizeDragRef.current = {
      edge,
      startScreenX: e.clientX,
      startScreenY: e.clientY,
      startW: embedEl.w,
      startH: embedEl.h,
      startX: embedEl.x,
      startY: embedEl.y,
    };
  }, [embedEl.w, embedEl.h, embedEl.x, embedEl.y]);

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
      onResize(embedEl.id, drag.last);
    }
    resizeDragRef.current = null;
  }, [embedEl.id, onResize]);

  const showHandles = isHovered || resizeDragRef.current != null;

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

  const { icon, label } = PROVIDER_ICONS[embedEl.provider];

  return (
    <div
      ref={containerRef}
      data-el
      data-el-id={embedEl.id}
      data-embed-container
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => { if (!resizeDragRef.current) setIsHovered(false); }}
      onClick={() => {
        if (locked) return;
        focusAnchorRef.current?.focus({ preventScroll: true });
        setIsFocused(true);
      }}
      onDoubleClick={(e) => {
        if (locked) return;
        e.stopPropagation();
        focusAnchorRef.current?.focus({ preventScroll: true });
        setIsFocused(true);
      }}
      style={{
        position: "absolute",
        left: embedEl.x,
        top: embedEl.y,
        width: embedEl.w,
        height: embedEl.h,
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

      {/* Embed content */}
      <div
        style={{
          width: "100%",
          height: "100%",
          borderRadius: 8,
          border: "1px solid var(--th-chart-border)",
          background: "var(--th-surface-hover)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          overscrollBehaviorX: "none",
        }}
      >
        {/* Title bar */}
        <div style={{
          fontFamily: "var(--font-lexend), sans-serif",
          fontSize: 11,
          color: "var(--th-text-muted)",
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "6px 8px",
          borderBottom: "1px solid var(--th-chart-border)",
          flexShrink: 0,
        }}>
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{icon}</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
            {embedEl.title || label}
          </span>
          <span style={{ color: "var(--th-text-faint)", fontSize: 10, flexShrink: 0 }}>{label}</span>
          <InfoTip />
        </div>

        {/* iframe */}
        <div style={{ flex: 1, position: "relative" }}>
          {!iframeLoaded && !iframeError && (
            <div style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "var(--font-lexend), sans-serif",
              fontSize: 13,
              color: "var(--th-text-muted)",
            }}>
              <span className="chart-loading">Loading...</span>
            </div>
          )}
          {iframeError && (
            <div style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "var(--font-lexend), sans-serif",
              fontSize: 13,
              color: "#ef4444",
              padding: 16,
              textAlign: "center",
            }}>
              Failed to load embed. Make sure the document is shared as &quot;Anyone with the link&quot;.
            </div>
          )}
          <iframe
            src={embedEl.embedUrl}
            style={{
              width: "100%",
              height: "100%",
              border: "none",
              display: iframeError ? "none" : "block",
              opacity: iframeLoaded ? 1 : 0,
              transition: "opacity 0.2s",
            }}
            sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
            loading="lazy"
            onLoad={() => setIframeLoaded(true)}
            onError={() => setIframeError(true)}
          />
          {/* Pointer shield: click to interact — shield drops when focused */}
          {!isFocused && (
            <div style={{ position: "absolute", inset: 0, cursor: "default" }} />
          )}
        </div>
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

export default memo(EmbedContainer);
