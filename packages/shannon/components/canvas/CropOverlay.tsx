"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ImageEl, CanvasEl, PlacementOp, PlacementResponse } from "../../lib/canvas-types";

type Props = {
  el: ImageEl;
  canvasScale: number;
  /** Function that converts a clientX/clientY pair into canvas-space (matches NotesCanvas's toCanvasPoint). */
  toCanvasPoint: (e: { clientX: number; clientY: number }) => { x: number; y: number };
  /** Mutate the element via the canvas's placement pipeline (gets us history + push resolution). */
  execPlace: (op: PlacementOp, opts?: PlacementResponse & { immediate?: boolean; skipHistory?: boolean; changedId?: string }) => void;
  onClose: () => void;
};

type CropRect = { x: number; y: number; w: number; h: number };
type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const HANDLE_PX = 10;
const MIN_CROP_SRC = 16;

export function CropOverlay({ el, canvasScale, toCanvasPoint, execPlace, onClose }: Props) {
  // Source-image natural dims, loaded async on mount.
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  // Live crop rect during edit, in source-image px coords.
  const [crop, setCrop] = useState<CropRect | null>(null);
  // Stable starting state for drag math.
  const dragRef = useRef<{
    kind: "edge" | "pan";
    edge?: Edge;
    startCanvas: { x: number; y: number };
    startCrop: CropRect;
  } | null>(null);

  // Probe the natural dimensions exactly once per src.
  useEffect(() => {
    const img = new window.Image();
    let cancelled = false;
    img.onload = () => {
      if (cancelled) return;
      setNat({ w: img.naturalWidth, h: img.naturalHeight });
      setCrop(el.crop ?? { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => { if (!cancelled) onClose(); };
    img.src = el.src;
    return () => { cancelled = true; };
    // src is the only meaningful identity here; el.crop is captured intentionally on first mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el.src]);

  // dispScale: canvas-px per source-px. Same in both axes (resize is aspect-locked).
  const dispScale = nat ? (el.crop ? el.w / el.crop.w : el.w / nat.w) : 0;
  // Anchor: where the FULL (uncropped) image's top-left would sit in canvas coords.
  const anchorX = nat ? (el.crop ? el.x - el.crop.x * dispScale : el.x) : el.x;
  const anchorY = nat ? (el.crop ? el.y - el.crop.y * dispScale : el.y) : el.y;
  const fullW = nat ? nat.w * dispScale : 0;
  const fullH = nat ? nat.h * dispScale : 0;

  const beginDrag = useCallback((e: React.MouseEvent, kind: "edge" | "pan", edge?: Edge) => {
    if (!crop) return;
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = {
      kind,
      edge,
      startCanvas: toCanvasPoint(e),
      startCrop: { ...crop },
    };
  }, [crop, toCanvasPoint]);

  useEffect(() => {
    if (!nat) return;
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const cur = toCanvasPoint(e);
      const dxCanvas = cur.x - drag.startCanvas.x;
      const dyCanvas = cur.y - drag.startCanvas.y;
      const dxSrc = dxCanvas / dispScale;
      const dySrc = dyCanvas / dispScale;
      const s = drag.startCrop;
      let next: CropRect;
      if (drag.kind === "pan") {
        const nx = clamp(s.x + dxSrc, 0, nat.w - s.w);
        const ny = clamp(s.y + dySrc, 0, nat.h - s.h);
        next = { x: nx, y: ny, w: s.w, h: s.h };
      } else {
        let { x, y, w, h } = s;
        const ed = drag.edge!;
        if (ed.includes("w")) {
          const nx = clamp(s.x + dxSrc, 0, s.x + s.w - MIN_CROP_SRC);
          w = s.w + (s.x - nx);
          x = nx;
        }
        if (ed.includes("e")) {
          const nr = clamp(s.x + s.w + dxSrc, s.x + MIN_CROP_SRC, nat.w);
          w = nr - s.x;
        }
        if (ed.includes("n")) {
          const ny = clamp(s.y + dySrc, 0, s.y + s.h - MIN_CROP_SRC);
          h = s.h + (s.y - ny);
          y = ny;
        }
        if (ed.includes("s")) {
          const nb = clamp(s.y + s.h + dySrc, s.y + MIN_CROP_SRC, nat.h);
          h = nb - s.y;
        }
        next = { x, y, w, h };
      }
      setCrop(next);
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [nat, dispScale, toCanvasPoint]);

  const apply = useCallback(() => {
    if (!nat || !crop) { onClose(); return; }
    // No change → no history entry.
    const sameAsCurrent =
      el.crop &&
      Math.abs(el.crop.x - crop.x) < 0.5 &&
      Math.abs(el.crop.y - crop.y) < 0.5 &&
      Math.abs(el.crop.w - crop.w) < 0.5 &&
      Math.abs(el.crop.h - crop.h) < 0.5;
    const fullCrop = crop.x === 0 && crop.y === 0 && crop.w === nat.w && crop.h === nat.h;
    if (sameAsCurrent || (!el.crop && fullCrop)) { onClose(); return; }

    const newW = crop.w * dispScale;
    const newH = crop.h * dispScale;
    const newX = anchorX + crop.x * dispScale;
    const newY = anchorY + crop.y * dispScale;
    const id = el.id;

    execPlace({
      kind: "transform",
      fn: (els) => els.map((it) => {
        if (it.id !== id || it.type !== "image") return it;
        const orig = it.originalW !== undefined
          ? { originalX: it.originalX, originalY: it.originalY, originalW: it.originalW, originalH: it.originalH }
          : { originalX: it.x, originalY: it.y, originalW: it.w, originalH: it.h };
        return {
          ...it,
          x: newX,
          y: newY,
          w: newW,
          h: newH,
          crop: { x: crop.x, y: crop.y, w: crop.w, h: crop.h },
          ...orig,
        } as CanvasEl;
      }),
    });
    onClose();
  }, [anchorX, anchorY, crop, dispScale, el.crop, el.id, execPlace, nat, onClose]);

  // Esc / Enter shortcuts. Capture-phase so we beat NotesCanvas's global keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); onClose(); }
      else if (e.key === "Enter") { e.stopPropagation(); e.preventDefault(); apply(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [apply, onClose]);

  if (!nat || !crop) return null;

  // Crop rect in canvas coords (relative to anchor).
  const cropPx = {
    x: crop.x * dispScale,
    y: crop.y * dispScale,
    w: crop.w * dispScale,
    h: crop.h * dispScale,
  };
  const handle = HANDLE_PX / canvasScale;
  const half = handle / 2;
  const stroke = 1.5 / canvasScale;
  const maskColor = "rgba(0,0,0,0.55)";

  return (
    <div
      style={{
        position: "absolute",
        left: anchorX,
        top: anchorY,
        width: fullW,
        height: fullH,
        zIndex: 25,
        // The full uncropped image is shown beneath via background; div itself
        // is just the geometry root for handles + masks.
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={el.src}
        alt=""
        draggable={false}
        style={{
          position: "absolute",
          left: 0, top: 0,
          width: fullW,
          height: fullH,
          display: "block",
          opacity: 1,
          pointerEvents: "none",
        }}
      />

      {/* Dim mask outside the crop rect (4 sides) */}
      <div style={{ position: "absolute", left: 0, top: 0, width: fullW, height: cropPx.y, background: maskColor, pointerEvents: "none" }} />
      <div style={{ position: "absolute", left: 0, top: cropPx.y + cropPx.h, width: fullW, height: Math.max(0, fullH - cropPx.y - cropPx.h), background: maskColor, pointerEvents: "none" }} />
      <div style={{ position: "absolute", left: 0, top: cropPx.y, width: cropPx.x, height: cropPx.h, background: maskColor, pointerEvents: "none" }} />
      <div style={{ position: "absolute", left: cropPx.x + cropPx.w, top: cropPx.y, width: Math.max(0, fullW - cropPx.x - cropPx.w), height: cropPx.h, background: maskColor, pointerEvents: "none" }} />

      {/* Crop frame border */}
      <div
        style={{
          position: "absolute",
          left: cropPx.x,
          top: cropPx.y,
          width: cropPx.w,
          height: cropPx.h,
          border: `${stroke}px solid #fff`,
          boxShadow: `0 0 0 ${stroke}px rgba(0,0,0,0.4)`,
          cursor: "move",
        }}
        onMouseDown={(e) => beginDrag(e, "pan")}
      />

      {/* Edge handles */}
      {(["n", "s", "e", "w"] as Edge[]).map((ed) => {
        const horiz = ed === "n" || ed === "s";
        const len = (horiz ? cropPx.w : cropPx.h) * 0.4;
        const thick = handle * 0.7;
        const left = ed === "w" ? cropPx.x - thick / 2
                  : ed === "e" ? cropPx.x + cropPx.w - thick / 2
                  : cropPx.x + (cropPx.w - len) / 2;
        const top  = ed === "n" ? cropPx.y - thick / 2
                  : ed === "s" ? cropPx.y + cropPx.h - thick / 2
                  : cropPx.y + (cropPx.h - len) / 2;
        const w = horiz ? len : thick;
        const h = horiz ? thick : len;
        const cursor = horiz ? "ns-resize" : "ew-resize";
        return (
          <div
            key={ed}
            onMouseDown={(e) => beginDrag(e, "edge", ed)}
            style={{ position: "absolute", left, top, width: w, height: h, background: "#fff", borderRadius: thick / 2, cursor, boxShadow: `0 0 0 ${stroke}px rgba(0,0,0,0.35)` }}
          />
        );
      })}

      {/* Corner handles */}
      {(["nw", "ne", "sw", "se"] as Edge[]).map((ed) => {
        const left = ed.includes("w") ? cropPx.x - half : cropPx.x + cropPx.w - half;
        const top  = ed.includes("n") ? cropPx.y - half : cropPx.y + cropPx.h - half;
        const cursor = ed === "nw" || ed === "se" ? "nwse-resize" : "nesw-resize";
        return (
          <div
            key={ed}
            onMouseDown={(e) => beginDrag(e, "edge", ed)}
            style={{ position: "absolute", left, top, width: handle, height: handle, background: "#fff", borderRadius: 2 / canvasScale, cursor, boxShadow: `0 0 0 ${stroke}px rgba(0,0,0,0.35)` }}
          />
        );
      })}

      {/* Apply / Cancel pill, anchored under the crop rect, sized in screen px. */}
      <div
        style={{
          position: "absolute",
          left: cropPx.x + cropPx.w / 2,
          top: cropPx.y + cropPx.h,
          transform: `translate(-50%, ${10 / canvasScale}px) scale(${1 / canvasScale})`,
          transformOrigin: "top center",
        }}
      >
        <div className="flex items-center gap-1 rounded-lg border border-[var(--th-border-30)] bg-[var(--th-surface-raised)] p-1 shadow-2xl">
          <button
            className="flex items-center justify-center w-7 h-7 rounded hover:bg-[var(--th-hover)] text-[var(--th-text-secondary)] transition-colors"
            title="Cancel (Esc)"
            onClick={(e) => { e.stopPropagation(); onClose(); }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>close</span>
          </button>
          <button
            className="flex items-center justify-center w-7 h-7 rounded hover:bg-[var(--th-hover)] text-[var(--th-accent)] transition-colors"
            title="Apply crop (Enter)"
            onClick={(e) => { e.stopPropagation(); apply(); }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>check</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
