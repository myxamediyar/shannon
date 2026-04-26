"use client";

import type { ArrowEl, ToolId } from "../../lib/canvas-types";

type Props = {
  elements: ArrowEl[];
  canvasScale: number;
  activeTool: ToolId | null;
  locked: boolean;
  selectedIds: string[];
  /** True while the given arrow endpoint is being dragged — keeps the handle visible during drag. */
  isEndpointBeingDragged: (arrowId: string) => boolean;
  onTipMouseDown: (el: ArrowEl, endpoint: "start" | "end", clientCx: number, clientCy: number) => void;
};

export function ArrowLayer({ elements, canvasScale, activeTool, locked, selectedIds, isEndpointBeingDragged, onTipMouseDown }: Props) {
  return (
    <>
      {elements.map((el) => {
        const isArrowSelected = selectedIds.includes(el.id);
        return (
          <g key={el.id} data-el-id={el.id} className="canvas-el-fade-in">
            {activeTool === "mover" && (
              <line
                x1={el.x1} y1={el.y1} x2={el.x2} y2={el.y2}
                stroke="transparent" strokeWidth={12 / canvasScale}
                style={{ pointerEvents: "auto", cursor: "default" }}
              />
            )}
            <line
              x1={el.x1}
              y1={el.y1}
              x2={el.x2}
              y2={el.y2}
              stroke="var(--th-stroke)"
              strokeWidth={2}
              markerEnd="url(#arrowhead)"
              style={activeTool === "mover" ? { pointerEvents: "auto", cursor: "default" } : undefined}
            />
            {[
              { cx: el.x1, cy: el.y1, endpoint: "start" as const },
              { cx: el.x2, cy: el.y2, endpoint: "end" as const },
            ].map((h) => (
              <circle
                key={h.endpoint}
                cx={h.cx}
                cy={h.cy}
                r={5 / canvasScale}
                fill="var(--th-accent)"
                stroke="var(--th-accent)"
                strokeWidth={1.5 / canvasScale}
                opacity={isArrowSelected ? 1 : 0}
                style={{ pointerEvents: locked ? "none" : "auto", cursor: "grab", transition: "opacity 0.15s" }}
                onMouseEnter={(e) => {
                  if (locked) return;
                  e.currentTarget.setAttribute("opacity", "1");
                }}
                onMouseLeave={(e) => {
                  if (isEndpointBeingDragged(el.id)) return;
                  e.currentTarget.setAttribute("opacity", isArrowSelected ? "1" : "0");
                }}
                onMouseDown={(e) => {
                  if (locked) return;
                  e.stopPropagation();
                  e.preventDefault();
                  onTipMouseDown(el, h.endpoint, h.cx, h.cy);
                }}
              />
            ))}
          </g>
        );
      })}
    </>
  );
}
