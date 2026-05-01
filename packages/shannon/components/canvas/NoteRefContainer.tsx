"use client";

import { useRouter } from "next/navigation";
import type { CanvasEl, NoteItem, NoteRefEl } from "../../lib/canvas-types";
import { NOTE_REF_W, NOTE_REF_H, STORAGE_KEY } from "../../lib/canvas-types";
import { elementTightCanvasAabb } from "../../lib/canvas-utils";
import type { CanvasChildProps } from "./types";

const PREVIEW_PADDING = 8;

type Props = CanvasChildProps<NoteRefEl>;

export function NoteRefContainer({ el, activeTool }: Props) {
  const router = useRouter();
  let targetTitle = "Untitled";
  let previewEls: CanvasEl[] = [];
  try {
    const allNotes: NoteItem[] = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    const target = allNotes.find((n) => n.id === el.targetNoteId);
    if (target) {
      targetTitle = target.title || "Untitled";
      previewEls = target.elements ?? [];
    }
  } catch { /* ignore */ }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pe of previewEls) {
    const aabb = elementTightCanvasAabb(pe);
    if (!aabb) continue;
    minX = Math.min(minX, aabb.x);
    minY = Math.min(minY, aabb.y);
    maxX = Math.max(maxX, aabb.x + aabb.w);
    maxY = Math.max(maxY, aabb.y + aabb.h);
  }
  const previewAreaW = NOTE_REF_W - PREVIEW_PADDING * 2;
  const previewAreaH = NOTE_REF_H - 36 - PREVIEW_PADDING * 2;
  const contentW = maxX - minX || 1;
  const contentH = maxY - minY || 1;
  const previewScale = Math.min(previewAreaW / contentW, previewAreaH / contentH, 1);

  return (
    <div
      data-el
      data-el-id={el.id}
      className="canvas-el-fade-in"
      style={{
        position: "absolute",
        left: el.x,
        top: el.y,
        width: NOTE_REF_W,
        height: NOTE_REF_H,
        pointerEvents: activeTool === "eraser" ? "none" : "auto",
      }}
      onDoubleClick={() => {
        router.push(`/notes?id=${el.targetNoteId}`, { scroll: false });
      }}
      onMouseDown={(e) => {
        if (activeTool !== "eraser" && activeTool !== "mover") e.stopPropagation();
      }}
    >
      <div
        className="rounded-lg overflow-hidden select-none"
        style={{
          width: NOTE_REF_W,
          height: NOTE_REF_H,
          background: "var(--th-surface, #1a1a2e)",
          border: "1px solid var(--th-border-30, #333)",
          cursor: activeTool === "mover" ? "grab" : "pointer",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            flex: 1,
            position: "relative",
            overflow: "hidden",
            filter: "blur(1.5px)",
            opacity: 0.6,
            padding: PREVIEW_PADDING,
          }}
        >
          {Number.isFinite(minX) && previewEls.map((pe) => {
            const aabb = elementTightCanvasAabb(pe);
            if (!aabb) return null;
            const px = (aabb.x - minX) * previewScale;
            const py = (aabb.y - minY) * previewScale;
            const pw = aabb.w * previewScale;
            const ph = aabb.h * previewScale;
            const color = pe.type === "text" ? "var(--th-text)"
              : pe.type === "chart" ? "var(--th-chart-border, #6c63ff)"
              : pe.type === "draw" || pe.type === "arrow" ? "var(--th-stroke-faint)"
              : "var(--th-border-30, #444)";
            return (
              <div
                key={pe.id}
                style={{
                  position: "absolute",
                  left: PREVIEW_PADDING + px,
                  top: PREVIEW_PADDING + py,
                  width: Math.max(pw, 2),
                  height: Math.max(ph, 2),
                  background: color,
                  borderRadius: 1,
                  opacity: pe.type === "text" ? 0.4 : 0.5,
                }}
              />
            );
          })}
        </div>
        <div
          style={{
            height: 36,
            padding: "0 10px",
            display: "flex",
            alignItems: "center",
            borderTop: "1px solid var(--th-border-30, #333)",
            gap: 6,
          }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 16, color: "var(--th-text-dim, #888)", flexShrink: 0 }}>description</span>
          <span
            className="font-lexend text-xs"
            style={{
              color: "var(--th-text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {targetTitle}
          </span>
        </div>
      </div>
    </div>
  );
}
