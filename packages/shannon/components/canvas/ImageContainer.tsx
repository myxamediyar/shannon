"use client";

import type { MouseEvent } from "react";
import type { ImageEl } from "../../lib/canvas-types";
import type { CanvasChildProps } from "./types";

export type ImageCorner = "tl" | "tr" | "bl" | "br";

export type ImageContainerExtraProps = {
  onResizeHandleMouseDown: (el: ImageEl, corner: ImageCorner, e: MouseEvent) => void;
  /** True while this image is mid-resize — keeps handle visible when mouse leaves it. */
  isBeingResized?: boolean;
  /** True while this image is in crop-edit mode — hide the regular resize handle. */
  isBeingCropped?: boolean;
  /** Pressing down on an image while Text tool is active switches to Mover. */
  onEnterMover: () => void;
};

type Props = CanvasChildProps<ImageEl> & ImageContainerExtraProps;

export function ImageContainer({ el, canvasScale, activeTool, locked, selected, onResizeHandleMouseDown, isBeingResized, isBeingCropped, onEnterMover }: Props) {
  const handleSize = 8 / canvasScale;
  const crop = el.crop;
  // dispScale = displayed canvas-px per source-image-px. Same in x and y while
  // the resize handle preserves aspect, so we derive it from width.
  const dispScale = crop ? el.w / crop.w : null;

  // Ghosted images intentionally pass through other elements visually, which
  // also buries the resize handle under whatever stacks on top. While the
  // image is selected, lift the whole container above element z (still under
  // the selection outline at zIndex 20) so the handle stays grabbable.
  const lifted = !!el.noPush && selected;
  return (
    <div
      data-el
      data-el-id={el.id}
      className="canvas-el-fade-in"
      style={{
        position: "absolute",
        left: el.x,
        top: el.y,
        zIndex: lifted ? 100000 : (el.z ?? 0),
        pointerEvents: activeTool === "eraser" ? "none" : "auto",
      }}
      onMouseDown={() => {
        if (activeTool === "text") onEnterMover();
      }}
    >
      {crop && dispScale ? (
        // Cropped: clip a window over a virtually-full image, positioned so
        // (crop.x, crop.y) lands at our top-left.
        <div
          style={{
            width: el.w,
            height: el.h,
            overflow: "hidden",
            borderRadius: "3px",
            position: "relative",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={el.src}
            alt=""
            className="max-w-none"
            style={{
              position: "absolute",
              left: -crop.x * dispScale,
              top: -crop.y * dispScale,
              width: "auto",
              height: "auto",
              maxWidth: "none",
              maxHeight: "none",
              transformOrigin: "top left",
              transform: `scale(${dispScale})`,
              display: "block",
            }}
            draggable={false}
          />
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={el.src}
          alt=""
          className="max-w-none"
          style={{ width: el.w, height: el.h, display: "block", borderRadius: "3px" }}
          draggable={false}
        />
      )}
      {!isBeingCropped && ([
        { c: "tl" as const, cursor: "nwse-resize", left: -handleSize / 2,        top: -handleSize / 2 },
        { c: "tr" as const, cursor: "nesw-resize", left: el.w - handleSize / 2,  top: -handleSize / 2 },
        { c: "bl" as const, cursor: "nesw-resize", left: -handleSize / 2,        top: el.h - handleSize / 2 },
        { c: "br" as const, cursor: "nwse-resize", left: el.w - handleSize / 2,  top: el.h - handleSize / 2 },
      ]).map(({ c, cursor, left, top }) => (
        <div
          key={c}
          data-img-corner={c}
          style={{
            position: "absolute",
            left,
            top,
            width: handleSize,
            height: handleSize,
            borderRadius: "50%",
            background: "var(--th-accent)",
            border: `${1.5 / canvasScale}px solid var(--th-accent)`,
            opacity: selected ? 1 : 0,
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
            onResizeHandleMouseDown(el, c, e);
          }}
        />
      ))}
    </div>
  );
}
