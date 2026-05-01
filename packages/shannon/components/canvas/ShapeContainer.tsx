"use client";

import type { MouseEvent } from "react";
import type { ShapeEl } from "../../lib/canvas-types";
import type { CanvasChildProps } from "./types";

/** Extension props beyond CanvasChildProps — shape corner-resize lives in the shell's mouse pipeline. */
export type ShapeContainerExtraProps = {
  onCornerMouseDown: (corner: "tl" | "tr" | "bl" | "br", el: ShapeEl, e: MouseEvent) => void;
  /** True while this shape is mid-resize — keeps handles visible when mouse leaves them. */
  isBeingResized?: boolean;
};

type Props = CanvasChildProps<ShapeEl> & ShapeContainerExtraProps;

const CORNERS = ["tl", "tr", "bl", "br"] as const;

export function ShapeContainer({ el, canvasScale, activeTool, locked, selected, onCornerMouseDown, isBeingResized }: Props) {
  const handleSize = 8 / canvasScale;
  const half = handleSize / 2;

  return (
    <div
      data-el
      data-el-id={el.id}
      className="canvas-el-fade-in"
      style={{
        position: "absolute",
        left: el.x,
        top: el.y,
        width: el.w,
        height: el.h,
        zIndex: el.z ?? 0,
        pointerEvents: activeTool === "mover" ? "auto" : "none",
      }}
    >
      {el.shape === "triangle" ? (
        <svg width={el.w} height={el.h} style={{ position: "absolute", top: 0, left: 0 }}>
          <polygon
            points={`${el.w / 2},0 0,${el.h} ${el.w},${el.h}`}
            fill="none"
            stroke="var(--th-stroke-faint)"
            strokeWidth="2"
          />
        </svg>
      ) : (
        <div
          style={{
            width: "100%",
            height: "100%",
            border: "2px solid var(--th-stroke-faint)",
            borderRadius: el.shape === "circle" ? "50%" : "3px",
          }}
        />
      )}

      {CORNERS.map((corner) => {
        const left = corner === "tl" || corner === "bl" ? -half : el.w - half;
        const top = corner === "tl" || corner === "tr" ? -half : el.h - half;
        const cursor = corner === "tl" || corner === "br" ? "nwse-resize" : "nesw-resize";
        return (
          <div
            key={corner}
            data-corner={corner}
            style={{
              position: "absolute",
              left,
              top,
              width: handleSize,
              height: handleSize,
              borderRadius: "50%",
              background: "var(--th-accent)",
              opacity: selected ? 1 : 0,
              border: `${1.5 / canvasScale}px solid var(--th-accent)`,
              pointerEvents: locked ? "none" : "auto",
              cursor,
              transition: "opacity 0.15s",
            }}
            onMouseEnter={(e) => {
              if (locked) return;
              e.currentTarget.style.opacity = "1";
            }}
            onMouseLeave={(e) => {
              if (isBeingResized) return;
              e.currentTarget.style.opacity = selected ? "1" : "0";
            }}
            onMouseDown={(e) => {
              if (locked) return;
              e.stopPropagation();
              e.preventDefault();
              onCornerMouseDown(corner, el, e);
            }}
          />
        );
      })}
    </div>
  );
}
