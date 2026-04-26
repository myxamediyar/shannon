"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import type { ChecklistEl, ChecklistItem, ToolId } from "../lib/canvas-types";
import { TEXT_LINE_HEIGHT } from "../lib/canvas-types";
import RichTextEditor, { type TiptapTextAdapter } from "./RichTextEditor";

// ── Constants ───────────────────────────────────────────────────────────────

const LABEL_FONT_SCALE = 2;
/** One line of default text at our font scale — used as the min label content height. */
const LABEL_MIN_H = TEXT_LINE_HEIGHT * LABEL_FONT_SCALE;
const LABEL_PAD_X = 6;
const LABEL_PAD_Y = 3;
const LABEL_BORDER = 1;
/** Total height the label box adds on top of its text content (padding + border). */
const LABEL_CHROME_Y = LABEL_PAD_Y * 2 + LABEL_BORDER * 2;
const ITEM_PAD_X = 4;
const ITEM_PAD_Y = 3;
const CHECKBOX_SIZE = 20;
const CHECKBOX_GAP = 8;
/** Row height when the label is at its minimum — keeps breathing room constant
 *  across all text sizes because itemHeights always add ITEM_PAD_Y * 2 on top
 *  of the measured label outer height. */
const MIN_ROW_H = LABEL_MIN_H + LABEL_CHROME_Y + ITEM_PAD_Y * 2;
const MIN_W = 240;
const LABEL_OFFSET = CHECKBOX_SIZE + CHECKBOX_GAP + ITEM_PAD_X + LABEL_PAD_X * 2;

/** Tiptap emits `<p></p>` / `<p><br></p>` for empty doc — treat those as blank. */
function isItemBlank(html: string | undefined | null): boolean {
  if (!html) return true;
  const stripped = html.replace(/\s+/g, "");
  return (
    stripped === "" ||
    stripped === "<p></p>" ||
    stripped === "<p><br></p>" ||
    stripped === "<p><br/></p>"
  );
}

// ── Props ───────────────────────────────────────────────────────────────────

export interface ChecklistContainerProps {
  checklistEl: ChecklistEl;
  canvasScale: number;
  activeTool: ToolId | null;
  locked: boolean;
  textMarqueeSelected?: boolean;
  onResize: (id: string, changes: Partial<ChecklistEl>) => void;
  onItemChange: (id: string, index: number, html: string) => void;
  onItemBlur: (id: string, index: number, html: string) => void;
  onItemFocus: (id: string, index: number) => void;
  onItemMeasure: (id: string, index: number, w: number, h: number) => void;
  onItemKeyDown: (e: KeyboardEvent, adapter: TiptapTextAdapter, checklistId: string, index: number) => boolean;
  onItemContextMenu: (id: string, index: number, clientX: number, clientY: number) => void;
  onItemToggle: (id: string, index: number) => void;
  onItemInsert: (id: string, atIndex: number) => void;
  registerItemEditor: (itemKey: string, editor: Editor | null) => void;
  despawning?: boolean;
  onDespawned?: (checklistId: string) => void;
}

// ── Component ───────────────────────────────────────────────────────────────

function ChecklistContainer({
  checklistEl,
  canvasScale: _canvasScale,
  activeTool,
  locked,
  textMarqueeSelected,
  onResize,
  onItemChange,
  onItemBlur,
  onItemFocus,
  onItemMeasure,
  onItemKeyDown,
  onItemContextMenu,
  onItemToggle,
  onItemInsert,
  registerItemEditor,
  despawning,
  onDespawned,
}: ChecklistContainerProps) {
  const [shellMounted, setShellMounted] = useState(false);
  const [mountedIndices, setMountedIndices] = useState<ReadonlySet<number>>(() => new Set());
  /** When non-null, the row at this index should focus as soon as its Tiptap mounts. */
  const [focusOnMountIdx, setFocusOnMountIdx] = useState<number | null>(null);

  const items = checklistEl.items;
  const count = items.length;

  // Non-empty items mount progressively; empty ones only mount on explicit click.
  const nonEmptyIndices = useMemo<number[]>(() => {
    const arr: number[] = [];
    for (let i = 0; i < count; i++) if (!isItemBlank(items[i]?.html)) arr.push(i);
    return arr;
  }, [items, count]);

  const activateItem = useCallback((idx: number) => {
    setMountedIndices((prev) => {
      if (prev.has(idx)) return prev;
      const next = new Set(prev);
      next.add(idx);
      return next;
    });
  }, []);

  const clearFocusOnMount = useCallback(() => setFocusOnMountIdx(null), []);

  /** Enter handler: insert a new empty item below and focus it once its Tiptap mounts. */
  const handleItemEnter = useCallback((fromIndex: number) => {
    const newIdx = fromIndex + 1;
    onItemInsert(checklistEl.id, newIdx);
    // Insert commits via a placement op (async re-render). Activate + flag focus
    // after the next frame so the items array includes the new row.
    requestAnimationFrame(() => {
      setMountedIndices((prev) => {
        if (prev.has(newIdx)) return prev;
        const next = new Set(prev);
        next.add(newIdx);
        return next;
      });
      setFocusOnMountIdx(newIdx);
    });
  }, [checklistEl.id, onItemInsert]);

  // Phase 1: paint skeleton once, then swap to real shell.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShellMounted(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Phase 2: progressively mount non-empty items via rIC (fallback to rAF).
  useEffect(() => {
    if (!shellMounted || despawning) return;
    const nextIdx = nonEmptyIndices.find((i) => !mountedIndices.has(i));
    if (nextIdx === undefined) return;

    type IdleCb = (cb: IdleRequestCallback, opts?: IdleRequestOptions) => number;
    const ric = (window as unknown as { requestIdleCallback?: IdleCb }).requestIdleCallback;
    const cic = (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;

    const run = () => setMountedIndices((prev) => {
      if (prev.has(nextIdx)) return prev;
      const next = new Set(prev);
      next.add(nextIdx);
      return next;
    });

    if (ric) {
      const handle = ric(run, { timeout: 80 });
      return () => { if (cic) cic(handle); };
    }
    const raf = requestAnimationFrame(run);
    return () => cancelAnimationFrame(raf);
  }, [shellMounted, despawning, nonEmptyIndices, mountedIndices]);

  // Phase 3: despawn — shed one mounted item per idle tick, then notify parent.
  useEffect(() => {
    if (!despawning) return;
    if (mountedIndices.size === 0) {
      onDespawned?.(checklistEl.id);
      return;
    }

    type IdleCb = (cb: IdleRequestCallback, opts?: IdleRequestOptions) => number;
    const ric = (window as unknown as { requestIdleCallback?: IdleCb }).requestIdleCallback;
    const cic = (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;

    const run = () => setMountedIndices((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      const first = next.values().next().value as number | undefined;
      if (first !== undefined) next.delete(first);
      return next;
    });

    if (ric) {
      const handle = ric(run, { timeout: 160 });
      return () => { if (cic) cic(handle); };
    }
    const raf = requestAnimationFrame(run);
    return () => cancelAnimationFrame(raf);
  }, [despawning, mountedIndices, onDespawned, checklistEl.id]);

  // Layout: per-item height from measured text, clamped to MIN_ROW_H. The
  // measurement is of the ProseMirror DOM (content only), so we also account
  // for the label's own padding + border and the row's vertical padding.
  const itemHeights = useMemo<number[]>(() => {
    return Array.from({ length: count }, (_, i) => {
      const pinned = checklistEl.itemHeights?.[i] ?? 0;
      const measured = items[i]?.measuredH ?? 0;
      const contentPart = Math.max(LABEL_MIN_H, measured);
      return Math.max(MIN_ROW_H, pinned, contentPart + LABEL_CHROME_Y + ITEM_PAD_Y * 2);
    });
  }, [items, checklistEl.itemHeights, count]);

  const contentW = useMemo(() => {
    let maxMeasured = 0;
    for (let i = 0; i < count; i++) {
      const mw = items[i]?.measuredW ?? 0;
      if (mw > maxMeasured) maxMeasured = mw;
    }
    return Math.max(MIN_W, LABEL_OFFSET + maxMeasured + ITEM_PAD_X);
  }, [items, count]);

  const totalH = useMemo(() => itemHeights.reduce((s, h) => s + h, 0), [itemHeights]);

  const itemOffsets = useMemo(() => {
    const out: number[] = [];
    let y = 0;
    for (let i = 0; i < count; i++) {
      out.push(y);
      y += itemHeights[i];
    }
    return out;
  }, [itemHeights, count]);

  // Sync computed w/h back into the element when content grows/shrinks.
  const lastSyncRef = useRef<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (lastSyncRef.current?.w === contentW && lastSyncRef.current?.h === totalH) return;
    if (checklistEl.w === contentW && checklistEl.h === totalH) {
      lastSyncRef.current = { w: contentW, h: totalH };
      return;
    }
    lastSyncRef.current = { w: contentW, h: totalH };
    const id = requestAnimationFrame(() => {
      onResize(checklistEl.id, { w: contentW, h: totalH });
    });
    return () => cancelAnimationFrame(id);
  }, [contentW, totalH, checklistEl.id, checklistEl.w, checklistEl.h, onResize]);

  // Skeleton phase: a subtle pulse, no grid feel.
  if (!shellMounted) {
    return (
      <div
        data-el
        data-el-id={checklistEl.id}
        data-checklist-container
        data-checklist-skeleton
        style={{
          position: "absolute",
          left: checklistEl.x,
          top: checklistEl.y,
          width: contentW,
          height: totalH,
          animation: "table-skeleton-pulse 1.1s ease-in-out infinite",
          outline: textMarqueeSelected ? "2px solid var(--th-accent, #60a5fa)" : undefined,
          outlineOffset: textMarqueeSelected ? 2 : undefined,
        }}
      />
    );
  }

  return (
    <div
      data-el
      data-el-id={checklistEl.id}
      data-checklist-container
      style={{
        position: "absolute",
        left: checklistEl.x,
        top: checklistEl.y,
        width: contentW,
        height: totalH,
        overflow: "visible",
        outline: textMarqueeSelected ? "2px solid var(--th-accent, #60a5fa)" : undefined,
        outlineOffset: textMarqueeSelected ? 2 : undefined,
      }}
    >
      {items.map((item, i) => (
        <ChecklistItemRow
          key={i}
          checklistId={checklistEl.id}
          index={i}
          item={item}
          top={itemOffsets[i]}
          width={contentW}
          height={itemHeights[i]}
          focusOnMount={focusOnMountIdx === i}
          onFocusConsumed={clearFocusOnMount}
          onEnter={handleItemEnter}
          locked={locked}
          isMoverTool={activeTool === "mover"}
          tiptapMounted={mountedIndices.has(i)}
          activateItem={activateItem}
          onItemChange={onItemChange}
          onItemBlur={onItemBlur}
          onItemFocus={onItemFocus}
          onItemMeasure={onItemMeasure}
          onItemKeyDown={onItemKeyDown}
          onItemContextMenu={onItemContextMenu}
          onItemToggle={onItemToggle}
          registerItemEditor={registerItemEditor}
        />
      ))}
    </div>
  );
}

export default memo(ChecklistContainer);

// ── Row component ──────────────────────────────────────────────────────────

interface ChecklistItemRowProps {
  checklistId: string;
  index: number;
  item: ChecklistItem;
  top: number;
  width: number;
  height: number;
  locked: boolean;
  isMoverTool: boolean;
  tiptapMounted: boolean;
  focusOnMount: boolean;
  onFocusConsumed: () => void;
  onEnter: (fromIndex: number) => void;
  activateItem: (idx: number) => void;
  onItemChange: (id: string, index: number, html: string) => void;
  onItemBlur: (id: string, index: number, html: string) => void;
  onItemFocus: (id: string, index: number) => void;
  onItemMeasure: (id: string, index: number, w: number, h: number) => void;
  onItemKeyDown: (e: KeyboardEvent, adapter: TiptapTextAdapter, checklistId: string, index: number) => boolean;
  onItemContextMenu: (id: string, index: number, clientX: number, clientY: number) => void;
  onItemToggle: (id: string, index: number) => void;
  registerItemEditor: (itemKey: string, editor: Editor | null) => void;
}

const ChecklistItemRow = memo(function ChecklistItemRow({
  checklistId,
  index,
  item,
  top,
  width,
  height,
  locked,
  isMoverTool,
  tiptapMounted,
  focusOnMount,
  onFocusConsumed,
  onEnter,
  activateItem,
  onItemChange,
  onItemBlur,
  onItemFocus,
  onItemMeasure,
  onItemKeyDown,
  onItemContextMenu,
  onItemToggle,
  registerItemEditor,
}: ChecklistItemRowProps) {
  const itemKey = `${checklistId}:${index}`;

  const editorStoreRef = useRef<Editor | null>(null);
  const registerItemEditorRef = useRef(registerItemEditor);
  registerItemEditorRef.current = registerItemEditor;
  const editorRefProxy = useMemo<React.MutableRefObject<Editor | null>>(() => ({
    get current(): Editor | null { return editorStoreRef.current; },
    set current(ed: Editor | null) {
      editorStoreRef.current = ed;
      registerItemEditorRef.current(itemKey, ed ?? null);
    },
  }), [itemKey]);

  useEffect(() => {
    return () => { registerItemEditorRef.current(itemKey, null); };
  }, [itemKey]);

  const pendingFocusRef = useRef(false);
  useEffect(() => {
    if (!tiptapMounted) return;
    const clickRequested = pendingFocusRef.current;
    if (!clickRequested && !focusOnMount) return;
    pendingFocusRef.current = false;
    const raf = requestAnimationFrame(() => {
      const ed = editorStoreRef.current;
      if (ed && !ed.isFocused) ed.commands.focus("end", { scrollIntoView: false });
      if (focusOnMount) onFocusConsumed();
    });
    return () => cancelAnimationFrame(raf);
  }, [tiptapMounted, focusOnMount, onFocusConsumed]);

  const editable = !locked && !isMoverTool;

  return (
    <div
      data-checklist-item
      data-item-index={index}
      onMouseDown={(e) => {
        if (!editable) return;
        if (e.button !== 0) return;
        e.stopPropagation();
        if (!tiptapMounted) {
          e.preventDefault();
          pendingFocusRef.current = true;
          activateItem(index);
          return;
        }
        const ed = editorStoreRef.current;
        if (ed && !ed.isFocused) {
          e.preventDefault();
          ed.commands.focus("end", { scrollIntoView: false });
        }
      }}
      onContextMenu={(e) => {
        if (locked) return;
        e.preventDefault();
        e.stopPropagation();
        onItemContextMenu(checklistId, index, e.clientX, e.clientY);
      }}
      style={{
        position: "absolute",
        left: 0,
        top,
        width,
        height,
        padding: `${ITEM_PAD_Y}px ${ITEM_PAD_X}px`,
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        gap: CHECKBOX_GAP,
        cursor: editable ? "text" : "default",
      }}
    >
      {/* Checkbox */}
      <button
        data-checklist-checkbox
        onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
        onClick={(e) => {
          e.stopPropagation();
          if (locked) return;
          onItemToggle(checklistId, index);
        }}
        tabIndex={-1}
        style={{
          flex: "0 0 auto",
          width: CHECKBOX_SIZE,
          height: CHECKBOX_SIZE,
          border: `1.5px solid var(--th-text-faint, rgba(255,255,255,0.4))`,
          borderRadius: 4,
          background: item.checked ? "var(--th-accent, #60a5fa)" : "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          cursor: locked ? "default" : "pointer",
          transition: "background 0.1s, border-color 0.1s",
        }}
      >
        {item.checked && (
          <span
            className="material-symbols-outlined"
            style={{
              fontSize: 18,
              color: "var(--th-surface, #0b0b10)",
              fontVariationSettings: "'wght' 700",
            }}
          >
            check
          </span>
        )}
      </button>

      {/* Label — subtle bordered box so the text reads as an editable field */}
      <div
        style={{
          flex: "1 1 auto",
          minWidth: 0,
          minHeight: LABEL_MIN_H + LABEL_CHROME_Y,
          boxSizing: "border-box",
          padding: `${LABEL_PAD_Y}px ${LABEL_PAD_X}px`,
          border: `${LABEL_BORDER}px solid var(--th-border-20, rgba(255,255,255,0.08))`,
          borderRadius: 4,
          background: "var(--th-surface-hover, rgba(255,255,255,0.02))",
          opacity: item.checked ? 0.55 : 1,
          textDecoration: item.checked ? "line-through" : "none",
          display: "flex",
          alignItems: "center",
        }}
      >
        {tiptapMounted ? (
          <RichTextEditor
            id={itemKey}
            html={item.html}
            fontScale={2}
            locked={locked}
            isMoverTool={isMoverTool}
            onChange={(html) => onItemChange(checklistId, index, html)}
            onBlur={(html) => onItemBlur(checklistId, index, html)}
            onFocus={() => onItemFocus(checklistId, index)}
            onKeyDown={(e, adapter) => {
              // Enter is owned by the container (needs activateItem + focus request).
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onEnter(index);
                adapter.blur();
                return true;
              }
              return onItemKeyDown(e, adapter, checklistId, index);
            }}
            onMeasure={(w, h) => onItemMeasure(checklistId, index, w, h)}
            editorRef={editorRefProxy}
          />
        ) : !isItemBlank(item.html) ? (
          <div className="table-cell-skeleton-bar" />
        ) : null}
      </div>
    </div>
  );
});
