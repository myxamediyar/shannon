"use client";

import type { RefObject } from "react";
import type { Editor } from "@tiptap/react";

export type SelectedImage = { editorId: string; pos: number; rect: DOMRect; width: number };

type Props = {
  selectedImage: SelectedImage;
  editorMapRef: RefObject<Map<string, Editor>>;
  locked: boolean;
};

type Corner = "nw" | "ne" | "sw" | "se";

const HANDLE_SIZE = 14;
const HALF = HANDLE_SIZE / 2;

export function ImageResizeOverlay({ selectedImage, editorMapRef, locked }: Props) {
  const { editorId, pos, rect, width } = selectedImage;
  const updateWidth = (nextW: number) => {
    const editor = editorMapRef.current?.get(editorId);
    if (!editor) return;
    const clamped = Math.max(32, Math.min(2000, Math.round(nextW)));
    editor.chain().focus().setNodeSelection(pos).updateAttributes("image", { width: clamped }).run();
  };
  const makeHandlePointerDown = (corner: Corner) => (e: React.PointerEvent) => {
    if (locked) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = width;
    // Right corners grow with +dx, left corners with -dx.
    const sign = corner === "ne" || corner === "se" ? 1 : -1;
    const onMove = (me: PointerEvent) => {
      const dx = (me.clientX - startX) * sign;
      // Shift = scale from center → both sides expand, so total width change is 2× the drag.
      const factor = me.shiftKey ? 2 : 1;
      updateWidth(startW + dx * factor);
    };
    const onUp = (ue: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      try { (ue.target as HTMLElement).releasePointerCapture(ue.pointerId); } catch {}
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const corners: { corner: Corner; left: number; top: number; cursor: string }[] = [
    { corner: "nw", left: rect.left - HALF,  top: rect.top - HALF,    cursor: "nwse-resize" },
    { corner: "ne", left: rect.right - HALF, top: rect.top - HALF,    cursor: "nesw-resize" },
    { corner: "sw", left: rect.left - HALF,  top: rect.bottom - HALF, cursor: "nesw-resize" },
    { corner: "se", left: rect.right - HALF, top: rect.bottom - HALF, cursor: "nwse-resize" },
  ];
  return (
    <>
      {corners.map(({ corner, left, top, cursor }) => (
        <div
          key={corner}
          onPointerDown={makeHandlePointerDown(corner)}
          style={{
            position: "fixed",
            left,
            top,
            width: HANDLE_SIZE,
            height: HANDLE_SIZE,
            borderRadius: "50%",
            background: "var(--th-accent, #60a5fa)",
            border: "2px solid var(--th-surface, #fff)",
            cursor,
            zIndex: 23,
          }}
        />
      ))}
      <div
        style={{
          position: "fixed",
          left: rect.left + rect.width / 2,
          top: rect.top - 10,
          transform: "translate(-50%, -100%)",
          padding: "4px 8px",
          fontSize: 11,
          fontFamily: "var(--font-lexend), sans-serif",
          color: "var(--th-text)",
          background: "var(--th-surface-raised)",
          border: "1px solid var(--th-border-30)",
          borderRadius: 4,
          zIndex: 23,
          pointerEvents: "none",
        }}
      >
        {Math.round(width)}px
      </div>
    </>
  );
}
