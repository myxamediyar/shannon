"use client";

import type { MouseEvent } from "react";
import type { PageRegion } from "../../lib/canvas-types";
import { pageRegionDims, PAGE_MARGIN } from "../../lib/canvas-types";

type MarginDragInit = {
  id: string;
  axis: "x" | "y";
  side: "start" | "end";
  originClient: number;
  startMargin: number;
  w: number;
  h: number;
};

type Props = {
  regions: PageRegion[];
  canvasScale: number;
  locked: boolean;
  selectedPageRegionId: string | null;
  onSelectRegion: (id: string) => void;
  onStartMarginDrag: (init: MarginDragInit) => void;
  onStartRegionDrag: (id: string, e: MouseEvent, pr: PageRegion) => void;
};

/**
 * Overlay layer for print regions. Regions aren't canvas elements — they're
 * overlays above the element tree, managed as a separate list on the note.
 */
export function PageRegionLayer({
  regions, canvasScale, locked, selectedPageRegionId,
  onSelectRegion, onStartMarginDrag, onStartRegionDrag,
}: Props) {
  return (
    <>
      {regions.map((pr) => {
        const { w, h } = pageRegionDims(pr.size, pr.rotation);
        const mx = pr.marginX ?? PAGE_MARGIN;
        const my = pr.marginY ?? PAGE_MARGIN;
        const isSel = selectedPageRegionId === pr.id;
        const hashLabel = pr.id.replace(/-/g, "").slice(0, 4);

        return (
          <div
            key={pr.id}
            data-page-region-id={pr.id}
            className="absolute pointer-events-none page-region-frame"
            style={{
              left: pr.x,
              top: pr.y,
              width: w,
              height: h,
              border: `${(isSel ? 2 : 1) / canvasScale}px ${isSel ? "solid" : "dashed"} var(--th-accent)`,
            }}
          >
            <div
              className="absolute pointer-events-none page-region-label"
              style={{
                left: 0,
                bottom: `calc(100% + ${4 / canvasScale}px)`,
                fontSize: `${11 / canvasScale}px`,
                lineHeight: 1,
                fontFamily: "var(--font-lexend), sans-serif",
                color: "var(--th-text)",
                opacity: 0.45,
                userSelect: "none",
                whiteSpace: "nowrap",
              }}
            >
              #{hashLabel}
            </div>

            <div
              className="absolute pointer-events-none page-region-margin"
              data-page-margin-marker={pr.id}
              style={{
                left: mx,
                top: my,
                right: mx,
                bottom: my,
                border: `${1 / canvasScale}px dashed var(--th-text-faint)`,
                opacity: 0.4,
              }}
            />

            {isSel && !locked && (() => {
              const handleThick = 10 / canvasScale;
              const handleLen = 64 / canvasScale;
              const makeH = (axis: "x" | "y", pos: "start" | "end") => {
                const isX = axis === "x";
                const along = isX ? h / 2 : w / 2;
                const cross = pos === "start" ? (isX ? mx : my) : (isX ? w - mx : h - my);
                const left = isX ? cross - handleThick / 2 : along - handleLen / 2;
                const top  = isX ? along - handleLen / 2   : cross - handleThick / 2;
                const width  = isX ? handleThick : handleLen;
                const height = isX ? handleLen   : handleThick;
                return (
                  <div
                    key={`mh-${axis}-${pos}`}
                    className="absolute pointer-events-auto page-region-handle"
                    style={{
                      left, top, width, height,
                      background: "var(--th-accent)",
                      borderRadius: 999,
                      cursor: isX ? "ew-resize" : "ns-resize",
                      opacity: 0.85,
                    }}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      onSelectRegion(pr.id);
                      onStartMarginDrag({
                        id: pr.id,
                        axis,
                        side: pos,
                        originClient: isX ? e.clientX : e.clientY,
                        startMargin: isX ? mx : my,
                        w, h,
                      });
                    }}
                  />
                );
              };
              return <>{makeH("x", "start")}{makeH("x", "end")}{makeH("y", "start")}{makeH("y", "end")}</>;
            })()}

            {!locked && ([
              ["top-0 left-0", "border-t border-l"],
              ["top-0 right-0", "border-t border-r"],
              ["bottom-0 left-0", "border-b border-l"],
              ["bottom-0 right-0", "border-b border-r"],
            ] as const).map(([pos, brd]) => (
              <div
                key={pos}
                className={`absolute pointer-events-auto page-region-corner ${pos}`}
                style={{
                  width: 16 / canvasScale,
                  height: 16 / canvasScale,
                  borderColor: "var(--th-accent)",
                  borderStyle: "solid",
                  borderTopWidth: brd.includes("border-t") ? `${2 / canvasScale}px` : 0,
                  borderLeftWidth: brd.includes("border-l") ? `${2 / canvasScale}px` : 0,
                  borderRightWidth: brd.includes("border-r") ? `${2 / canvasScale}px` : 0,
                  borderBottomWidth: brd.includes("border-b") ? `${2 / canvasScale}px` : 0,
                  cursor: "move",
                }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  onSelectRegion(pr.id);
                  onStartRegionDrag(pr.id, e, pr);
                }}
              />
            ))}
          </div>
        );
      })}
    </>
  );
}

export type { MarginDragInit };
