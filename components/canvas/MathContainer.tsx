"use client";

import katex from "katex";
import type { MathEl } from "../../lib/canvas-types";
import { TEXT_BASE_FONT_PX } from "../../lib/canvas-types";
import type { CanvasChildProps } from "./types";

export type MathContainerExtraProps = {
  /** Clicking a math element (outside eraser/mover + unlocked) converts it back to its `/math ...` text form. */
  onConvertToText: (el: MathEl) => void;
};

type Props = CanvasChildProps<MathEl> & MathContainerExtraProps;

export function MathContainer({ el, activeTool, locked, onMeasure, onConvertToText }: Props) {
  return (
    <div
      data-el
      data-el-id={el.id}
      className="canvas-el-fade-in"
      ref={(node) => {
        if (!node) return;
        onMeasure?.(el.id, node.offsetWidth, node.offsetHeight);
      }}
      style={{
        position: "absolute",
        left: el.x,
        top: el.y,
        pointerEvents: activeTool === "eraser" ? "none" : "auto",
        cursor: activeTool !== "eraser" && activeTool !== "mover" && !locked ? "text" : undefined,
      }}
      onMouseDown={(e) => {
        if (activeTool !== "eraser" && activeTool !== "mover") e.stopPropagation();
      }}
      onClick={() => {
        if (activeTool === "eraser" || activeTool === "mover" || locked) return;
        onConvertToText(el);
      }}
    >
      <div
        className="text-[var(--th-text)]"
        style={{ fontSize: `${TEXT_BASE_FONT_PX * 2}px` }}
        dangerouslySetInnerHTML={{ __html: katex.renderToString(el.latex, { throwOnError: false, displayMode: true }) }}
      />
    </div>
  );
}
