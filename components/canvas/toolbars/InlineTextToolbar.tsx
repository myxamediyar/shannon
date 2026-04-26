"use client";

import type { RefObject } from "react";
import type { Editor } from "@tiptap/react";

type Props = {
  pos: { left: number; top: number };
  focusedTextId: string;
  editorMapRef: RefObject<Map<string, Editor>>;
};

export function InlineTextToolbar({ pos, focusedTextId, editorMapRef }: Props) {
  const applyInline = (fn: (editor: Editor) => void) => {
    const editor = editorMapRef.current?.get(focusedTextId);
    if (editor) fn(editor);
  };
  const btn = "flex items-center justify-center w-7 h-7 rounded hover:bg-[var(--th-hover)] text-[var(--th-text-secondary)] transition-colors";
  return (
    <div
      className="fixed z-[22] flex items-center gap-1 rounded-lg border border-[var(--th-border-30)] bg-[var(--th-surface-raised)] p-1 shadow-2xl"
      style={{
        left: pos.left,
        top: pos.top - 10,
        transform: "translate(-50%, -100%)",
      }}
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button className={btn} title="Bold (⌘B)" onMouseDown={(e) => { e.preventDefault(); applyInline(ed => ed.commands.toggleBold()); }}>
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>format_bold</span>
      </button>
      <button className={btn} title="Italic (⌘I)" onMouseDown={(e) => { e.preventDefault(); applyInline(ed => ed.commands.toggleItalic()); }}>
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>format_italic</span>
      </button>
      <button className={btn} title="Strikethrough" onMouseDown={(e) => { e.preventDefault(); applyInline(ed => ed.commands.toggleStrike()); }}>
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>strikethrough_s</span>
      </button>
      <button className={btn} title="Code" onMouseDown={(e) => { e.preventDefault(); applyInline(ed => ed.commands.toggleCode()); }}>
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>code</span>
      </button>
      <div className="w-px h-5 bg-[var(--th-border-30)]" />
      <button className={btn} title="Heading 1" onMouseDown={(e) => { e.preventDefault(); applyInline(ed => ed.commands.toggleHeading({ level: 1 })); }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>H1</span>
      </button>
      <button className={btn} title="Heading 2" onMouseDown={(e) => { e.preventDefault(); applyInline(ed => ed.commands.toggleHeading({ level: 2 })); }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>H2</span>
      </button>
      <button className={btn} title="Heading 3" onMouseDown={(e) => { e.preventDefault(); applyInline(ed => ed.commands.toggleHeading({ level: 3 })); }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>H3</span>
      </button>
    </div>
  );
}
