"use client";

import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";

// Image extended with a resizable `width` attribute (rendered as inline style)
// so users can drag to resize selected images.
export const ResizableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("width") || el.style.width || null,
        renderHTML: (attrs: { width?: number | string | null }) => {
          if (!attrs.width) return {};
          const w = typeof attrs.width === "number" ? `${attrs.width}px` : String(attrs.width);
          return { style: `width: ${w}; height: auto;` };
        },
      },
    };
  },
});
import { useEffect, useRef, memo } from "react";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TEXT_BASE_FONT_PX } from "../lib/canvas-types";
import { COMMAND_TRIE, matchCommand } from "../lib/canvas-utils";

// ── Slash-command highlight (ProseMirror decoration) ──────────────────────

const commandHighlightKey = new PluginKey<DecorationSet>("commandHighlight");

function firstTextblockStart(doc: ProseMirrorNode): { pos: number; text: string } | null {
  let found: { pos: number; text: string } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.isTextblock) {
      found = { pos: pos + 1, text: node.textContent };
      return false;
    }
    return true;
  });
  return found;
}

/** Per-command sub-token patterns. Each regex must have two capture groups:
 *  group 1 = leading whitespace (and any preceding tokens), group 2 = the token to color. */
const SUB_RULES: Record<string, RegExp[]> = {
  "/chat": [/^(\s+)(fork|clear|compact|@\d+)(?=\s|$)/i],
  "/graph": [
    /^(\s+\d+\s+)(scale|delete|place)(?=\s|$)/i,
    /^(\s+)(\d+)(?=\s|$)/,
  ],
  "/sideq": [/^(\s+)(\d+)(?=\s|$)/],
  "/sidechat": [/^(\s+)(\d+)(?=\s|$)/],
};

function buildCommandDecorations(doc: ProseMirrorNode, flashRed: boolean): DecorationSet {
  const first = firstTextblockStart(doc);
  if (!first) return DecorationSet.empty;
  const m = matchCommand(COMMAND_TRIE, first.text);
  if (m.status !== "matched") return DecorationSet.empty;
  const cmdColor = flashRed ? "#ef4444" : "#60a5fa";
  const subColor = flashRed ? "#ef4444" : "#a78bfa";
  const decos: Decoration[] = [
    Decoration.inline(first.pos, first.pos + m.cmdLen, { style: `color: ${cmdColor}` }),
  ];
  const rules = SUB_RULES[m.command];
  if (rules) {
    const rest = first.text.slice(m.cmdLen);
    for (const regex of rules) {
      const sub = rest.match(regex);
      if (sub) {
        const subStart = first.pos + m.cmdLen + sub[1].length;
        decos.push(Decoration.inline(subStart, subStart + sub[2].length, { style: `color: ${subColor}` }));
        break; // only the first matching rule applies
      }
    }
  }
  return DecorationSet.create(doc, decos);
}

// ── Legacy markdown → HTML migration ──────────────────────────────────────────

/** Convert legacy markdown text (stored with \n) into HTML for Tiptap.
 *  Only used for migrating old notes that don't have `el.html`. */
export function legacyMarkdownToHTML(text: string): string {
  const lines = text.split("\n");
  return lines
    .map((line) => {
      if (!line) return "<p></p>";
      const hMatch = /^(#{1,6})\s+(.*)$/.exec(line);
      if (hMatch) {
        const level = hMatch[1].length;
        return `<h${level}>${escapeAndFormat(hMatch[2])}</h${level}>`;
      }
      if (/^[-*]\s/.test(line)) {
        return `<li>${escapeAndFormat(line.replace(/^[-*]\s/, ""))}</li>`;
      }
      if (/^[-*]\s*\[[ xX]\]\s/.test(line)) {
        return `<li>${escapeAndFormat(line.replace(/^[-*]\s*\[[ xX]\]\s/, ""))}</li>`;
      }
      const numMatch = /^(\d+)[.)]\s(.*)$/.exec(line);
      if (numMatch) {
        return `<li>${escapeAndFormat(numMatch[2])}</li>`;
      }
      if (/^>\s?/.test(line)) {
        return `<blockquote><p>${escapeAndFormat(line.replace(/^>\s?/, ""))}</p></blockquote>`;
      }
      return `<p>${escapeAndFormat(line)}</p>`;
    })
    .join("");
}

function escapeAndFormat(text: string): string {
  let s = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*(.+?)\*/g, "<em>$1</em>");
  s = s.replace(/~~(.+?)~~/g, "<s>$1</s>");
  s = s.replace(/`(.+?)`/g, "<code>$1</code>");
  return s;
}

// ── ProseMirror position ↔ character offset conversion ─────────────────────

/**
 * Convert a ProseMirror position to a plain-text character offset.
 * Plain text uses \n between block nodes (like getText({ blockSeparator: '\n' })).
 */
export function pmPosToCharOffset(doc: ProseMirrorNode, pos: number): number {
  let charOffset = 0;
  let currentPos = 0;
  let blockIndex = 0;

  doc.forEach((node, nodeOffset) => {
    if (currentPos >= pos) return;

    const nodeStart = nodeOffset + 1;
    const nodeEnd = nodeStart + node.nodeSize;

    if (blockIndex > 0 && currentPos < pos) {
      charOffset++;
    }

    if (pos <= nodeStart) {
      currentPos = nodeEnd;
      blockIndex++;
      return;
    }

    if (pos >= nodeEnd) {
      charOffset += node.textContent.length;
      currentPos = nodeEnd;
      blockIndex++;
      return;
    }

    charOffset += posWithinBlockToOffset(node, pos - nodeStart);
    currentPos = pos;
    blockIndex++;
  });

  return charOffset;
}

function posWithinBlockToOffset(block: ProseMirrorNode, relPos: number): number {
  let offset = 0;
  let walked = 0;

  if (block.type.name === "listItem" || block.type.name === "blockquote") {
    let innerOffset = 0;
    block.forEach((child, childOffset) => {
      const childStart = childOffset + 1;
      const childEnd = childStart + child.nodeSize;
      if (walked + childStart >= relPos) return;
      if (walked + childEnd <= relPos) {
        innerOffset += child.textContent.length;
        return;
      }
      innerOffset += posWithinBlockToOffset(child, relPos - walked - childOffset);
    });
    return innerOffset;
  }

  block.forEach((child) => {
    if (walked >= relPos) return;
    const childSize = child.nodeSize;
    if (walked + childSize <= relPos) {
      offset += child.text?.length ?? child.textContent.length;
      walked += childSize;
    } else {
      offset += relPos - walked;
      walked = relPos;
    }
  });

  return offset;
}

/**
 * Convert a plain-text character offset to a ProseMirror position.
 */
export function charOffsetToPmPos(doc: ProseMirrorNode, offset: number): number {
  let remaining = offset;
  let pmPos = 0;
  let blockIndex = 0;

  doc.forEach((node, nodeOffset) => {
    if (remaining < 0) return;

    if (blockIndex > 0) {
      if (remaining === 0) {
        remaining = -1;
        return;
      }
      remaining--;
    }

    const textLen = node.textContent.length;
    const nodeStart = nodeOffset + 1;

    if (remaining > textLen) {
      remaining -= textLen;
      pmPos = nodeStart + node.nodeSize;
      blockIndex++;
      return;
    }

    pmPos = nodeStart + offsetToRelPmPos(node, remaining);
    remaining = -1;
    blockIndex++;
  });

  return Math.max(1, Math.min(pmPos, doc.content.size - 1));
}

function offsetToRelPmPos(block: ProseMirrorNode, offset: number): number {
  if (block.type.name === "listItem" || block.type.name === "blockquote") {
    let remaining = offset;
    let relPos = 0;
    block.forEach((child, childOffset) => {
      if (remaining < 0) return;
      const textLen = child.textContent.length;
      if (remaining > textLen) {
        remaining -= textLen;
        relPos = childOffset + 1 + child.nodeSize;
        return;
      }
      relPos = childOffset + 1 + offsetToRelPmPos(child, remaining);
      remaining = -1;
    });
    return relPos;
  }

  let remaining = offset;
  let relPos = 0;
  block.forEach((child) => {
    if (remaining <= 0) return;
    const len = child.text?.length ?? child.textContent.length;
    if (remaining >= len) {
      remaining -= len;
      relPos += child.nodeSize;
    } else {
      relPos += remaining;
      remaining = 0;
    }
  });
  return relPos;
}

// ── TiptapTextAdapter — textarea-like API ──────────────────────────────────

export class TiptapTextAdapter {
  constructor(public editor: Editor) {}

  get value(): string {
    return this.editor.getText({ blockSeparator: "\n" });
  }

  get selectionStart(): number {
    return pmPosToCharOffset(
      this.editor.state.doc,
      this.editor.state.selection.from
    );
  }

  get selectionEnd(): number {
    return pmPosToCharOffset(
      this.editor.state.doc,
      this.editor.state.selection.to
    );
  }

  setSelectionRange(start: number, end: number): void {
    const from = charOffsetToPmPos(this.editor.state.doc, start);
    const to = charOffsetToPmPos(this.editor.state.doc, end);
    this.editor.commands.setTextSelection({ from, to });
  }

  blur(): void {
    this.editor.commands.blur();
  }

  focus(preventScroll = true): void {
    this.editor.commands.focus(null, { scrollIntoView: !preventScroll });
  }

  replaceAll(html: string): void {
    this.editor.commands.setContent(html, { emitUpdate: false });
  }
}

// ── RichTextEditor component ───────────────────────────────────────────────

export interface RichTextEditorProps {
  id: string;
  html: string;
  fontScale: number;
  locked?: boolean;
  isMoverTool?: boolean;
  flashRed?: boolean;
  onChange: (html: string, plainText: string) => void;
  onBlur: (html: string, plainText: string) => void;
  onFocus: () => void;
  onKeyDown: (e: KeyboardEvent, adapter: TiptapTextAdapter) => boolean;
  onMeasure: (w: number, h: number) => void;
  editorRef: React.MutableRefObject<Editor | null>;
}

const RichTextEditor = memo(function RichTextEditor({
  id,
  html,
  fontScale,
  locked,
  isMoverTool,
  flashRed,
  onChange,
  onBlur,
  onFocus,
  onKeyDown,
  onMeasure,
  editorRef,
}: RichTextEditorProps) {
  const onKeyDownRef = useRef(onKeyDown);
  onKeyDownRef.current = onKeyDown;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onBlurRef = useRef(onBlur);
  onBlurRef.current = onBlur;
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;
  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;
  const flashRedRef = useRef(!!flashRed);
  flashRedRef.current = !!flashRed;
  const suppressUpdateRef = useRef(false);

  const editable = !locked && !isMoverTool;

  const editor = useEditor({
    extensions: [
      Extension.create({
        name: "canvasKeyIntercept",
        priority: 1000,
        addProseMirrorPlugins() {
          const tiptapEditor = this.editor;
          return [
            new Plugin({
              key: new PluginKey("canvasKeyIntercept"),
              props: {
                handleKeyDown(_view, event) {
                  const adapter = new TiptapTextAdapter(tiptapEditor);
                  return onKeyDownRef.current(event, adapter);
                },
              },
            }),
            new Plugin<DecorationSet>({
              key: commandHighlightKey,
              state: {
                init: (_, { doc }) => buildCommandDecorations(doc, flashRedRef.current),
                apply: (tr, prev) => {
                  const meta = tr.getMeta(commandHighlightKey);
                  if (meta?.type === "refresh" || tr.docChanged) {
                    return buildCommandDecorations(tr.doc, flashRedRef.current);
                  }
                  return prev.map(tr.mapping, tr.doc);
                },
              },
              props: {
                decorations(state) {
                  return commandHighlightKey.getState(state);
                },
              },
            }),
          ];
        },
      }),
      StarterKit,
      ResizableImage.configure({ inline: true, allowBase64: true }),
    ],
    content: html,
    editable,
    immediatelyRender: false,
    onUpdate({ editor: ed }) {
      if (suppressUpdateRef.current) return;
      onChangeRef.current(
        ed.getHTML(),
        ed.getText({ blockSeparator: "\n" }),
      );
      const dom = ed.view.dom;
      if (dom) {
        onMeasureRef.current(dom.offsetWidth, dom.offsetHeight);
      }
    },
    onFocus() {
      onFocusRef.current();
    },
    onBlur({ editor: ed }) {
      onBlurRef.current(
        ed.getHTML(),
        ed.getText({ blockSeparator: "\n" }),
      );
    },
    editorProps: {
      attributes: {
        id: `el-${id}`,
        class: "rich-text-display",
        style: [
          `font-family: var(--font-lexend), sans-serif`,
          `font-size: ${TEXT_BASE_FONT_PX * fontScale}px`,
          `line-height: 1.5`,
          `color: var(--th-text)`,
          `outline: none`,
          `white-space: pre-wrap`,
          `word-break: break-word`,
          isMoverTool ? `cursor: grab` : `cursor: text`,
          // Block selection in mover tool so drags move the element instead.
          // When the note is locked the element can't be dragged, so prefer
          // letting the user select + copy text. Locked also flips Tiptap to
          // contenteditable="false", which inherits the viewport's `select-none`
          // (NotesCanvas) — explicitly re-enable text selection here.
          isMoverTool && !locked ? `user-select: none` : (locked ? `user-select: text` : ""),
        ]
          .filter(Boolean)
          .join("; "),
      },
    },
  });

  useEffect(() => {
    editorRef.current = editor ?? null;
    return () => {
      if (editorRef.current === editor) editorRef.current = null;
    };
  }, [editor, editorRef]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editable);
  }, [editor, editable]);

  // editorProps.attributes are baked in at editor creation, so toggling the
  // locked / mover state at runtime needs to write through to the DOM here.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom as HTMLElement;
    dom.style.cursor = isMoverTool ? "grab" : "text";
    const sel = isMoverTool && !locked ? "none" : locked ? "text" : "";
    dom.style.userSelect = sel;
    dom.style.webkitUserSelect = sel;
  }, [editor, isMoverTool, locked]);

  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(editor.state.tr.setMeta(commandHighlightKey, { type: "refresh" }));
  }, [editor, flashRed]);

  // Sync content when html prop changes externally
  useEffect(() => {
    if (!editor) return;
    const currentHtml = editor.getHTML();
    if (currentHtml === html) return;
    suppressUpdateRef.current = true;
    editor.commands.setContent(html, { emitUpdate: false });
    suppressUpdateRef.current = false;
    const dom = editor.view.dom;
    if (dom) {
      onMeasureRef.current(dom.offsetWidth, dom.offsetHeight);
    }
  }, [editor, html]);

  useEffect(() => {
    if (!editor) return;
    requestAnimationFrame(() => {
      const dom = editor.view.dom;
      if (dom) {
        onMeasureRef.current(dom.offsetWidth, dom.offsetHeight);
      }
    });
  }, [editor, fontScale]);

  // Observe editor DOM size changes (e.g., images loading async) and remeasure.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    if (!dom || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      onMeasureRef.current(dom.offsetWidth, dom.offsetHeight);
    });
    ro.observe(dom);
    return () => ro.disconnect();
  }, [editor]);

  return <EditorContent editor={editor} className="tiptap-display-wrap" />;
});

export default RichTextEditor;
