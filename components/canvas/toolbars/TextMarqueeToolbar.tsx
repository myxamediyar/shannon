"use client";

import type { RefObject } from "react";
import type { Editor } from "@tiptap/react";

type Props = {
  pos: { left: number; top: number };
  editorIds: string[];
  editorMapRef: RefObject<Map<string, Editor>>;
};

export function TextMarqueeToolbar({ pos, editorIds, editorMapRef }: Props) {
  const applyToAll = (fn: (editor: Editor) => void) => {
    for (const elId of editorIds) {
      const editor = editorMapRef.current?.get(elId);
      if (!editor) continue;
      const docSize = editor.state.doc.content.size;
      editor.chain().setTextSelection({ from: 1, to: Math.max(1, docSize - 1) }).run();
      fn(editor);
      editor.chain().setTextSelection(1).run();
    }
  };
  const toggleHeadingAll = (level: 1 | 2 | 3) => {
    for (const elId of editorIds) {
      const editor = editorMapRef.current?.get(elId);
      if (!editor) continue;
      const { state } = editor;
      const { doc, schema, tr } = state;
      const headingType = schema.nodes.heading;
      const paragraphType = schema.nodes.paragraph;
      const blocks: { node: typeof doc.firstChild; pos: number }[] = [];
      doc.forEach((node, pos) => {
        if (node.textContent.length > 0) blocks.push({ node, pos });
      });
      if (blocks.length === 0) continue;
      const allMatch = blocks.every(b => b.node!.type === headingType && b.node!.attrs.level === level);
      for (const b of blocks) {
        const targetType = allMatch ? paragraphType : headingType;
        const attrs = allMatch ? null : { level };
        tr.setBlockType(b.pos, b.pos + b.node!.nodeSize, targetType, attrs);
      }
      editor.view.dispatch(tr);
    }
  };
  const btn = "flex items-center justify-center w-7 h-7 rounded hover:bg-[var(--th-hover)] text-[var(--th-text-secondary)] transition-colors";
  return (
    <div
      className="absolute z-[21] flex items-center gap-1 rounded-lg border border-[var(--th-border-30)] bg-[var(--th-surface-raised)] p-1 shadow-2xl"
      style={{
        left: pos.left,
        top: pos.top - 10,
        transform: "translate(-50%, -100%)",
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button className={btn} title="Bold (⌘B)" onClick={() => applyToAll(ed => ed.commands.toggleBold())}>
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>format_bold</span>
      </button>
      <button className={btn} title="Italic (⌘I)" onClick={() => applyToAll(ed => ed.commands.toggleItalic())}>
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>format_italic</span>
      </button>
      <button className={btn} title="Strikethrough (⌘S)" onClick={() => applyToAll(ed => ed.commands.toggleStrike())}>
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>strikethrough_s</span>
      </button>
      <button className={btn} title="Code" onClick={() => applyToAll(ed => ed.commands.toggleCode())}>
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>code</span>
      </button>
      <div className="w-px h-5 bg-[var(--th-border-30)]" />
      <button className={btn} title="Heading 1" onClick={() => toggleHeadingAll(1)}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>H1</span>
      </button>
      <button className={btn} title="Heading 2" onClick={() => toggleHeadingAll(2)}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>H2</span>
      </button>
      <button className={btn} title="Heading 3" onClick={() => toggleHeadingAll(3)}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>H3</span>
      </button>
    </div>
  );
}
