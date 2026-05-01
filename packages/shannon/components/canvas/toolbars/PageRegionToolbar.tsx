"use client";

import {
  PAGE_SIZES,
  pageRegionDims,
  type PageRegion,
  type PageSize,
} from "../../../lib/canvas-types";

type Props = {
  pageRegion: PageRegion;
  offset: { x: number; y: number };
  scale: number;
  onMutate: (updater: (regions: PageRegion[]) => PageRegion[]) => void;
  onPrint: (pr: PageRegion) => void;
  onDeselect: () => void;
};

export function PageRegionToolbar({ pageRegion: pr, offset, scale, onMutate, onPrint, onDeselect }: Props) {
  const { w } = pageRegionDims(pr.size, pr.rotation);
  const left = offset.x + pr.x * scale + (w * scale) / 2;
  const top = offset.y + pr.y * scale - 44;
  return (
    <div
      className="absolute z-30 flex items-center gap-1 p-1 rounded-xl -translate-x-1/2"
      style={{
        left, top,
        background: "var(--th-surface-overlay)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        border: "0.5px solid var(--th-border-subtle)",
        boxShadow: "0 8px 32px var(--th-shadow-heavy)",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="relative group">
        <button className="h-8 px-3 rounded-lg flex items-center gap-1 text-[11px] font-lexend font-medium text-[var(--th-text-secondary)] hover:bg-[var(--th-surface-hover)]">
          {PAGE_SIZES[pr.size].label}
          <span className="material-symbols-outlined text-base">arrow_drop_down</span>
        </button>
        <div className="absolute top-full left-0 pt-1 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity">
          <div className="rounded-lg p-1 flex flex-col gap-0.5 min-w-[120px]"
            style={{ background: "var(--th-surface-raised)", border: "0.5px solid var(--th-border-subtle)", boxShadow: "0 8px 32px var(--th-shadow-heavy)" }}>
            {(Object.keys(PAGE_SIZES) as PageSize[]).map((sz) => (
              <button key={sz}
                onClick={() => onMutate(rs => rs.map(r => r.id === pr.id ? { ...r, size: sz, marginX: undefined, marginY: undefined } : r))}
                className={`text-left text-[11px] font-lexend px-2 py-1 rounded ${pr.size === sz ? "bg-[var(--th-accent)] text-[var(--th-accent-on)]" : "text-[var(--th-text-muted)] hover:bg-[var(--th-surface-hover)] hover:text-[var(--th-text)]"}`}>
                {PAGE_SIZES[sz].label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <button
        onClick={() => onMutate(rs => rs.map(r => r.id === pr.id ? { ...r, rotation: r.rotation === 0 ? 90 : 0 } : r))}
        className="h-8 w-8 rounded-lg flex items-center justify-center text-[var(--th-text-muted)] hover:bg-[var(--th-surface-hover)] hover:text-[var(--th-text)]"
        title="Rotate 90°"
      >
        <span className="material-symbols-outlined text-lg">rotate_right</span>
      </button>

      <button
        onClick={() => onPrint(pr)}
        className="h-8 w-8 rounded-lg flex items-center justify-center text-[var(--th-text-muted)] hover:bg-[var(--th-surface-hover)] hover:text-[var(--th-text)]"
        title="Print"
      >
        <span className="material-symbols-outlined text-lg">print</span>
      </button>

      <button
        onClick={() => {
          onMutate(rs => rs.filter(r => r.id !== pr.id));
          onDeselect();
        }}
        className="h-8 w-8 rounded-lg flex items-center justify-center text-[var(--th-text-muted)] hover:bg-[var(--th-surface-hover)] hover:text-[var(--th-text)]"
        title="Remove"
      >
        <span className="material-symbols-outlined text-lg">close</span>
      </button>
    </div>
  );
}
