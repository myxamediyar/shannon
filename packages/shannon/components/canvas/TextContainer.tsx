"use client";

import { useCallback, useRef, type RefObject } from "react";
import type { Editor } from "@tiptap/react";
import type { TextEl } from "../../lib/canvas-types";
import RichTextEditor, { type TiptapTextAdapter, legacyMarkdownToHTML } from "../RichTextEditor";
import { textScale, snapTextLineY, textElWrapWidth } from "../../lib/canvas-utils";
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
  /** Right-edge handle drag committed: persist new wrap width. */
  onResize: (id: string, w: number) => void;
  /** Shared registry so cross-element logic (Stage 5) can reach Tiptap instances. */
  editorMapRef: RefObject<Map<string, Editor>>;
};

type Props = CanvasChildProps<TextEl> & TextContainerExtraProps;

const HANDLE_SIZE = 8; // canvas-space px
const MIN_WRAP_W = 120; // minimum drag-resize width

export function TextContainer({
  el, activeTool, locked, canvasScale, selected,
  selectionMoveLive, textMarqueeSelected, flashRed,
  onChange, onBlur, onFocus, onKeyDown, onMeasure, onResize, editorMapRef,
}: Props) {
  const wrapWidth = textElWrapWidth(el);
  const containerRef = useRef<HTMLDivElement>(null);
  const editorWrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    startScreenX: number;
    startW: number;
    lastW?: number;
  } | null>(null);
  const isResizable = !locked && !el.locked;

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!isResizable) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      startScreenX: e.clientX,
      startW: wrapWidth,
    };
  }, [isResizable, wrapWidth]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    const dx = (e.clientX - drag.startScreenX) / canvasScale;
    const newW = Math.max(MIN_WRAP_W, drag.startW + dx);
    drag.lastW = newW;
    // DOM-only: avoid a re-render per pointermove. Editor DOM lives one level
    // down inside EditorContent's wrapper; query for the .rich-text-display
    // child so the max-width takes effect immediately.
    const wrap = editorWrapRef.current;
    if (wrap) {
      const editorDom = wrap.querySelector<HTMLElement>(".rich-text-display");
      if (editorDom) editorDom.style.maxWidth = `${newW}px`;
    }
  }, [canvasScale]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    if (drag.lastW != null) onResize(el.id, drag.lastW);
    dragRef.current = null;
  }, [el.id, onResize]);

  // Only surface the wrap-width handle when the element is selected via the
  // mover tool — keeps text-tool interactions (typing, navigating) free of
  // an extra handle on hover, and matches the mover's "manipulate" semantics.
  const showHandle = isResizable && activeTool === "mover" && (selected || dragRef.current != null);

  return (
    <div
      ref={containerRef}
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
      <div ref={editorWrapRef} style={{ position: "relative" }}>
        <RichTextEditor
          id={el.id}
          html={el.html ?? legacyMarkdownToHTML(el.text)}
          fontScale={textScale(el)}
          locked={locked || !!el.locked}
          isMoverTool={activeTool === "mover"}
          flashRed={flashRed}
          wrapWidth={wrapWidth}
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

      {/* Right-edge wrap-width resize handle. Positioned on the right edge of
          the rendered text box (measuredW after wrapping); hovers over empty
          space when text is shorter than wrapWidth. Conditionally rendered
          (not just opacity-toggled) so it can't capture pointer events when
          hidden. */}
      {showHandle && (
        <div
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          style={{
            position: "absolute",
            top: 0,
            // Aligned to the rendered right edge — wrap width is enforced by
            // max-width, so measuredW and wrapWidth match for content that
            // actually fills the line.
            right: -HANDLE_SIZE,
            width: HANDLE_SIZE * 2,
            height: "100%",
            cursor: "ew-resize",
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              width: 5,
              height: 32,
              borderRadius: 3,
              background: "var(--th-text)",
              opacity: 0.55,
            }}
          />
        </div>
      )}
    </div>
  );
}
