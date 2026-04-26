"use client";

import type { DrawEl } from "../../lib/canvas-types";

/**
 * Renders a single committed draw (pencil) element as its own absolutely-
 * positioned SVG. Each drawing is its own stacking context so `zIndex` can
 * interleave it with shapes/images across layers — essential for the cross-
 * type z-level ordering to work.
 */
export function SingleDraw({ el }: { el: DrawEl }) {
  const parts = el.pts.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of parts) {
    const [xs, ys] = p.split(",").map(Number);
    if (!Number.isFinite(xs) || !Number.isFinite(ys)) continue;
    if (xs < minX) minX = xs;
    if (ys < minY) minY = ys;
    if (xs > maxX) maxX = xs;
    if (ys > maxY) maxY = ys;
  }
  if (!Number.isFinite(minX)) return null;

  const pad = 4; // room for 2px stroke + round caps
  const w = maxX - minX + pad * 2;
  const h = maxY - minY + pad * 2;
  const shifted = parts
    .map((p) => {
      const [xs, ys] = p.split(",").map(Number);
      return `${xs - minX + pad},${ys - minY + pad}`;
    })
    .join(" ");

  return (
    <svg
      data-el-id={el.id}
      className="canvas-el-fade-in"
      style={{
        position: "absolute",
        left: minX - pad,
        top: minY - pad,
        width: w,
        height: h,
        overflow: "visible",
        pointerEvents: "none",
        zIndex: el.z ?? 0,
      }}
      viewBox={`0 0 ${w} ${h}`}
    >
      <polyline
        points={shifted}
        fill="none"
        stroke="var(--th-stroke)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
