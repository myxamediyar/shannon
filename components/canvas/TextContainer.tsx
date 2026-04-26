"use client";

import type { RefObject } from "react";
import type { Editor } from "@tiptap/react";
import type { TextEl } from "../../lib/canvas-types";
import RichTextEditor, { type TiptapTextAdapter, legacyMarkdownToHTML } from "../RichTextEditor";
import { textScale, snapTextLineY } from "../../lib/canvas-utils";
import type { CanvasChildProps } from "./types";

/**
 * TextContainer is an acknowledged **contract exception**.
 *
 * Beyond the baseline `CanvasChildProps<TextEl>`, text needs:
 *   - 3 extra state reads (selectionMoveLive, textMarqueeSelected, flashRed)
 *   - 4 extra event callbacks (onChange, onBlur, onFocus, onKeyDown)
 *   - editor registration for the shared editorMapRef
 *
 * Why the exception is unavoidable in Stage 3:
 *   - Cross-element text keyboard (Backspace merge, Tab jump, ⌥-Backspace, Cmd+Arrow)
 *     is a ~700-line module that stays in the shell until Stage 5
 *   - The container can't own these interactions because they read/write global
 *     text layout state across all text elements
 *
 * Stage 5 plan: once `lib/text-interactions.ts` extracts the cross-element keyboard,
 * several callbacks collapse — TextContainer's prop surface shrinks.
 */
export type TextContainerExtraProps = {
  selectionMoveLive: boolean;
  textMarqueeSelected: boolean;
  flashRed: boolean;
  onChange: (id: string, html: string, plainText: string) => void;
  onBlur: (id: string, plainText: string) => void;
  onFocus: (id: string) => void;
  onKeyDown: (e: KeyboardEvent, el: TextEl, adapter: TiptapTextAdapter) => boolean;
  /** Shared registry so cross-element logic (Stage 5) can reach Tiptap instances. */
  editorMapRef: RefObject<Map<string, Editor>>;
};

type Props = CanvasChildProps<TextEl> & TextContainerExtraProps;

export function TextContainer({
  el, activeTool, locked,
  selectionMoveLive, textMarqueeSelected, flashRed,
  onChange, onBlur, onFocus, onKeyDown, onMeasure, editorMapRef,
}: Props) {
  return (
    <div
      data-el
      data-el-id={el.id}
      className={`canvas-el-fade-in ${activeTool === "mover" && !locked ? "select-none" : ""} ${textMarqueeSelected ? "text-marquee-selected" : ""}`.trim()}
      style={{
        position: "absolute",
        left: el.x,
        top: selectionMoveLive ? el.y : snapTextLineY(el.y),
        pointerEvents: activeTool === "eraser" ? "none" : "auto",
      }}
      onMouseDown={(e) => {
        if (activeTool !== "mover" && activeTool !== "eraser") e.stopPropagation();
      }}
    >
      <RichTextEditor
        id={el.id}
        html={el.html ?? legacyMarkdownToHTML(el.text)}
        fontScale={textScale(el)}
        locked={locked || !!el.locked}
        isMoverTool={activeTool === "mover"}
        flashRed={flashRed}
        onChange={(html, plainText) => onChange(el.id, html, plainText)}
        onBlur={(_html, plainText) => onBlur(el.id, plainText)}
        onFocus={() => onFocus(el.id)}
        onKeyDown={(e, adapter) => onKeyDown(e, el, adapter)}
        onMeasure={(w, h) => onMeasure?.(el.id, w, h)}
        editorRef={{
          get current() { return editorMapRef.current?.get(el.id) ?? null; },
          set current(ed) {
            const map = editorMapRef.current;
            if (!map) return;
            if (ed) map.set(el.id, ed);
            else map.delete(el.id);
          },
        }}
      />
    </div>
  );
}
