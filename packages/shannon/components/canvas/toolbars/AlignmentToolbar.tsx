"use client";

import type { CanvasAabb, CanvasEl, ImageEl, PlacementOp, PlacementResponse } from "../../../lib/canvas-types";
import {
  elementTightCanvasAabb,
  translateCanvasElBy,
  resolveCollisions,
  dragResolvePush,
  getZ,
} from "../../../lib/canvas-utils";

type Props = {
  screenPos: { left: number; top: number };
  selectedIds: string[];
  allElements: CanvasEl[];
  execPlace: (op: PlacementOp) => PlacementResponse | void;
  /** Enter crop mode for a single image. Provided by NotesCanvas. */
  onStartCrop?: (imageId: string) => void;
};

/** Element types that currently carry a z-level. Others are ignored by the z controls. */
const Z_TYPES: ReadonlySet<CanvasEl["type"]> = new Set(["shape", "draw", "image"]);

export function AlignmentToolbar({ screenPos, selectedIds, allElements, execPlace, onStartCrop }: Props) {
  // ── Z controls ───────────────────────────────────────────────────────────
  const zTargets = allElements.filter((el) => selectedIds.includes(el.id) && Z_TYPES.has(el.type));
  const zValues = zTargets.map(getZ);
  const zDisplay = (() => {
    if (zValues.length === 0) return null;
    const min = Math.min(...zValues);
    const max = Math.max(...zValues);
    return min === max ? String(max) : "—";
  })();

  const bumpZ = (dir: 1 | -1) => {
    if (zTargets.length === 0) return;
    const target = dir === 1
      ? Math.max(...zValues) + 1
      : Math.min(...zValues) - 1;
    const ids = new Set(zTargets.map((el) => el.id));
    execPlace({
      kind: "transform",
      fn: (elements) =>
        elements.map((el) => (ids.has(el.id) ? ({ ...el, z: target } as CanvasEl) : el)),
      anchorIds: new Set(allElements.map((el) => el.id)),
    });
  };

  // ── Ghost (no-push) toggle for images ────────────────────────────────────
  const imageTargets = allElements.filter(
    (el): el is ImageEl => selectedIds.includes(el.id) && el.type === "image",
  );
  // Majority rule: if most selected images are currently ghosted, clicking
  // turns them all solid; otherwise clicking ghosts them all.
  const ghostedCount = imageTargets.filter((el) => !!el.noPush).length;
  const allGhosted = imageTargets.length > 0 && ghostedCount === imageTargets.length;
  const toggleGhost = () => {
    if (imageTargets.length === 0) return;
    const next = !(ghostedCount > imageTargets.length / 2);
    const ids = new Set(imageTargets.map((el) => el.id));
    execPlace({
      kind: "transform",
      fn: (elements) =>
        elements.map((el) =>
          ids.has(el.id) && el.type === "image"
            ? ({ ...el, noPush: next || undefined } as CanvasEl)
            : el,
        ),
      anchorIds: new Set(allElements.map((el) => el.id)),
    });
  };

  // ── Crop / Revert ────────────────────────────────────────────────────────
  const cropTarget = imageTargets.length === 1 ? imageTargets[0] : null;
  const revertTargets = imageTargets.filter((el) => el.originalW !== undefined);
  const showCrop = !!cropTarget && !!onStartCrop;
  const showRevert = revertTargets.length > 0;

  const doRevert = () => {
    if (revertTargets.length === 0) return;
    const ids = new Set(revertTargets.map((el) => el.id));
    execPlace({
      kind: "transform",
      fn: (elements) =>
        elements.map((el) => {
          if (!ids.has(el.id) || el.type !== "image" || el.originalW === undefined || el.originalH === undefined) {
            return el;
          }
          return {
            ...el,
            x: el.originalX ?? el.x,
            y: el.originalY ?? el.y,
            w: el.originalW,
            h: el.originalH,
            crop: undefined,
            originalX: undefined,
            originalY: undefined,
            originalW: undefined,
            originalH: undefined,
          } as CanvasEl;
        }),
      anchorIds: new Set(allElements.map((el) => el.id)),
    });
  };

  // No controls to show → don't render an empty pill (otherwise it reads as a
  // stray dot above the selection — e.g. single text element, which has no z).
  const showAlignment = selectedIds.length >= 2;
  const showZ = zDisplay !== null;
  const showGhost = imageTargets.length > 0;
  if (!showAlignment && !showZ && !showGhost && !showCrop && !showRevert) return null;
  /** Two-phase alignment:
   *  Phase 1 — Apply alignment delta, then resolve collisions among selected elements only
   *            (anchoring on the median element along the perpendicular axis).
   *  Phase 2 — Place the resolved group back into the canvas with all selected as anchors,
   *            letting dragResolvePush() push non-selected elements out of the way. */
  const alignSelection = (mode: "left" | "center" | "right") => {
    const idSet = new Set(selectedIds);
    const aabbs: { id: string; aabb: CanvasAabb }[] = [];
    for (const el of allElements) {
      if (!idSet.has(el.id)) continue;
      const a = elementTightCanvasAabb(el);
      if (a) aabbs.push({ id: el.id, aabb: a });
    }
    if (aabbs.length < 2) return;

    let targetX: number;
    if (mode === "left") targetX = Math.min(...aabbs.map(a => a.aabb.x));
    else if (mode === "right") targetX = Math.max(...aabbs.map(a => a.aabb.x + a.aabb.w));
    else targetX = aabbs.reduce((sum, a) => sum + a.aabb.x + a.aabb.w / 2, 0) / aabbs.length;

    const sortedByY = [...aabbs].sort((a, b) => (a.aabb.y + a.aabb.h / 2) - (b.aabb.y + b.aabb.h / 2));
    const medianId = sortedByY[Math.floor(sortedByY.length / 2)].id;

    let group = allElements.filter(el => idSet.has(el.id));
    const aabbMap = new Map(aabbs.map(a => [a.id, a.aabb]));
    group = group.map(el => {
      const ab = aabbMap.get(el.id);
      if (!ab) return el;
      let dx: number;
      if (mode === "left") dx = targetX - ab.x;
      else if (mode === "right") dx = targetX - (ab.x + ab.w);
      else dx = targetX - (ab.x + ab.w / 2);
      return translateCanvasElBy(el, dx, 0);
    });
    group = resolveCollisions(group, new Set([medianId]), {
      axis: "vertical", quantum: { kind: "exact" }, excludeTypes: [], maxPasses: 15, flatResolve: true,
    });
    const resolvedMap = new Map(group.map(el => [el.id, el]));

    execPlace({
      kind: "transform",
      fn: (elements) => elements.map(el => resolvedMap.get(el.id) ?? el),
      anchorIds: idSet,
      resolve: dragResolvePush(),
    });
  };

  const alignSelectionV = (mode: "top" | "vcenter" | "bottom") => {
    const idSet = new Set(selectedIds);
    const aabbs: { id: string; aabb: CanvasAabb }[] = [];
    for (const el of allElements) {
      if (!idSet.has(el.id)) continue;
      const a = elementTightCanvasAabb(el);
      if (a) aabbs.push({ id: el.id, aabb: a });
    }
    if (aabbs.length < 2) return;

    let targetY: number;
    if (mode === "top") targetY = Math.min(...aabbs.map(a => a.aabb.y));
    else if (mode === "bottom") targetY = Math.max(...aabbs.map(a => a.aabb.y + a.aabb.h));
    else targetY = aabbs.reduce((sum, a) => sum + a.aabb.y + a.aabb.h / 2, 0) / aabbs.length;

    const sortedByX = [...aabbs].sort((a, b) => (a.aabb.x + a.aabb.w / 2) - (b.aabb.x + b.aabb.w / 2));
    const medianId = sortedByX[Math.floor(sortedByX.length / 2)].id;

    let group = allElements.filter(el => idSet.has(el.id));
    const aabbMap = new Map(aabbs.map(a => [a.id, a.aabb]));
    group = group.map(el => {
      const ab = aabbMap.get(el.id);
      if (!ab) return el;
      let dy: number;
      if (mode === "top") dy = targetY - ab.y;
      else if (mode === "bottom") dy = targetY - (ab.y + ab.h);
      else dy = targetY - (ab.y + ab.h / 2);
      return translateCanvasElBy(el, 0, dy);
    });
    group = resolveCollisions(group, new Set([medianId]), {
      axis: "horizontal", quantum: { kind: "exact" }, excludeTypes: [], maxPasses: 15, flatResolve: true,
    });
    const resolvedMap = new Map(group.map(el => [el.id, el]));

    execPlace({
      kind: "transform",
      fn: (elements) => elements.map(el => resolvedMap.get(el.id) ?? el),
      anchorIds: idSet,
      resolve: dragResolvePush(),
    });
  };

  return (
    <div
      className="absolute z-[21] flex items-center gap-1 rounded-lg border border-[var(--th-border-30)] bg-[var(--th-surface-raised)] p-1 shadow-2xl"
      style={{
        left: screenPos.left,
        top: screenPos.top - 10,
        transform: "translate(-50%, -100%)",
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {selectedIds.length >= 2 && (<>
      <button
        className="flex items-center justify-center w-7 h-7 rounded hover:bg-[var(--th-hover)] text-[var(--th-text-secondary)] transition-colors"
        title="Align left"
        onClick={() => alignSelection("left")}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>align_horizontal_left</span>
      </button>
      <button
        className="flex items-center justify-center w-7 h-7 rounded hover:bg-[var(--th-hover)] text-[var(--th-text-secondary)] transition-colors"
        title="Align center"
        onClick={() => alignSelection("center")}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>align_horizontal_center</span>
      </button>
      <button
        className="flex items-center justify-center w-7 h-7 rounded hover:bg-[var(--th-hover)] text-[var(--th-text-secondary)] transition-colors"
        title="Align right"
        onClick={() => alignSelection("right")}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>align_horizontal_right</span>
      </button>
      <div className="w-px h-5 bg-[var(--th-border-30)]" />
      <button
        className="flex items-center justify-center w-7 h-7 rounded hover:bg-[var(--th-hover)] text-[var(--th-text-secondary)] transition-colors"
        title="Align top"
        onClick={() => alignSelectionV("top")}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>align_vertical_top</span>
      </button>
      <button
        className="flex items-center justify-center w-7 h-7 rounded hover:bg-[var(--th-hover)] text-[var(--th-text-secondary)] transition-colors"
        title="Align middle"
        onClick={() => alignSelectionV("vcenter")}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>align_vertical_center</span>
      </button>
      <button
        className="flex items-center justify-center w-7 h-7 rounded hover:bg-[var(--th-hover)] text-[var(--th-text-secondary)] transition-colors"
        title="Align bottom"
        onClick={() => alignSelectionV("bottom")}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>align_vertical_bottom</span>
      </button>
      </>)}
      {zDisplay !== null && (<>
        {selectedIds.length >= 2 && <div className="w-px h-5 bg-[var(--th-border-30)]" />}
        <button
          className="flex items-center justify-center w-7 h-7 rounded hover:bg-[var(--th-hover)] text-[var(--th-text-secondary)] transition-colors disabled:opacity-40"
          title="Send backward"
          onClick={() => bumpZ(-1)}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>flip_to_back</span>
        </button>
        <span
          className="px-1.5 text-[11px] font-lexend font-semibold text-[var(--th-text-secondary)] tabular-nums select-none"
          title="Current z-level"
        >
          z: {zDisplay}
        </span>
        <button
          className="flex items-center justify-center w-7 h-7 rounded hover:bg-[var(--th-hover)] text-[var(--th-text-secondary)] transition-colors disabled:opacity-40"
          title="Bring forward"
          onClick={() => bumpZ(1)}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>flip_to_front</span>
        </button>
      </>)}
      {showGhost && (<>
        {(showAlignment || showZ) && <div className="w-px h-5 bg-[var(--th-border-30)]" />}
        <button
          className={`flex items-center justify-center w-7 h-7 rounded hover:bg-[var(--th-hover)] transition-colors ${allGhosted ? "text-[var(--th-accent)]" : "text-[var(--th-text-secondary)]"}`}
          title={allGhosted ? "Push on collision (currently ghosted)" : "Ghost — let elements pass through"}
          onClick={toggleGhost}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
            {allGhosted ? "layers_clear" : "layers"}
          </span>
        </button>
      </>)}
      {(showCrop || showRevert) && (<>
        {(showAlignment || showZ || showGhost) && <div className="w-px h-5 bg-[var(--th-border-30)]" />}
        {showCrop && (
          <button
            className="flex items-center justify-center w-7 h-7 rounded hover:bg-[var(--th-hover)] text-[var(--th-text-secondary)] transition-colors"
            title="Crop image"
            onClick={() => onStartCrop?.(cropTarget!.id)}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>crop</span>
          </button>
        )}
        {showRevert && (
          <button
            className="flex items-center justify-center w-7 h-7 rounded hover:bg-[var(--th-hover)] text-[var(--th-text-secondary)] transition-colors"
            title="Revert to original"
            onClick={doRevert}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>restart_alt</span>
          </button>
        )}
      </>)}
    </div>
  );
}
