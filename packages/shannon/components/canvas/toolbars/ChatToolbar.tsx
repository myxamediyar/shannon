"use client";

import type { ChatEl } from "../../../lib/canvas-types";

type Props = {
  chatEl: ChatEl;
  /** Toolbar position in screen coords (centered above the chat). */
  screenPos: { left: number; top: number };
  onToggleDim: (chatId: string) => void;
};

/** Floating pill above a selected chat. Mirrors PageRegionToolbar's visual
 *  treatment so per-element toolbars feel consistent across element types. */
export function ChatToolbar({ chatEl, screenPos, onToggleDim }: Props) {
  const isDimmed = !!chatEl.dimmed;
  return (
    <div
      data-chat-toolbar-for={chatEl.id}
      className="absolute z-30 flex items-center gap-1 p-1 rounded-xl -translate-x-1/2"
      style={{
        left: screenPos.left,
        top: screenPos.top - 44,
        background: "var(--th-surface-overlay)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        border: "0.5px solid var(--th-border-subtle)",
        boxShadow: "0 8px 32px var(--th-shadow-heavy)",
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        onClick={() => onToggleDim(chatEl.id)}
        className={`h-8 w-8 rounded-lg flex items-center justify-center hover:bg-[var(--th-surface-hover)] ${isDimmed ? "text-[var(--th-accent)]" : "text-[var(--th-text-muted)] hover:text-[var(--th-text)]"}`}
        title={isDimmed ? "Remove message backgrounds" : "Per-message backgrounds (improves readability over busy canvas)"}
      >
        <span className="material-symbols-outlined text-lg">
          {isDimmed ? "brightness_4" : "brightness_6"}
        </span>
      </button>
    </div>
  );
}
