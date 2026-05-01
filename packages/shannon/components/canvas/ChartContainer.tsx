"use client";

import type { ChartEl } from "../../lib/canvas-types";
import { ChartBox } from "../../lib/canvas-utils";
import type { CanvasChildProps } from "./types";

type Props = CanvasChildProps<ChartEl>;

export function ChartContainer({ el, activeTool }: Props) {
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
        pointerEvents: activeTool === "eraser" ? "none" : "auto",
      }}
      onMouseDown={(e) => {
        if (activeTool !== "eraser" && activeTool !== "mover") e.stopPropagation();
      }}
    >
      <div
        className="w-full h-full rounded-lg"
        style={{ background: "var(--th-chart-bg)", border: "1px solid var(--th-chart-border)" }}
      >
        {el.loading ? (
          <div className="w-full h-full flex items-center justify-center chart-loading">
            <span className="material-symbols-outlined" style={{ fontSize: 48, color: "var(--th-text)", opacity: 0.4 }}>
              bar_chart
            </span>
          </div>
        ) : el.error ? (
          <div className="w-full h-full flex items-center justify-center p-6">
            <span style={{ fontFamily: "var(--font-lexend), sans-serif", fontSize: 14, color: "#ef4444", textAlign: "center" }}>
              {el.error}
            </span>
          </div>
        ) : (
          <ChartBox chartType={el.chartType} labels={el.labels} datasets={el.datasets} />
        )}
      </div>
    </div>
  );
}
