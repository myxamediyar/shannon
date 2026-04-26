"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import type { TableEl, TableCell, ToolId } from "../lib/canvas-types";
import RichTextEditor, { type TiptapTextAdapter } from "./RichTextEditor";


// ── Constants ───────────────────────────────────────────────────────────────

const HANDLE_SIZE = 8;
const MIN_W = 90;
const MIN_H = 46;
const MIN_COL_W = 44;
const MIN_ROW_H = 44;
const CELL_PAD = 2;
const BORDER_PX = 1;

type Edge = "right" | "left" | "top" | "bottom" | "br" | "bl" | "tr" | "tl";
const EDGE_HAS_RIGHT  = new Set<Edge>(["right", "br", "tr"]);
const EDGE_HAS_LEFT   = new Set<Edge>(["left", "bl", "tl"]);
const EDGE_HAS_BOTTOM = new Set<Edge>(["bottom", "br", "bl"]);
const EDGE_HAS_TOP    = new Set<Edge>(["top", "tr", "tl"]);

/** Tiptap emits `<p></p>` / `<p><br></p>` for an empty document, which is a
 *  truthy string — so a cell that was touched and then cleared reads as
 *  "has content" to a naive check. Treat these as blank. Image-only or
 *  otherwise-structural cells don't match these patterns and stay non-blank. */
function isCellBlank(html: string | undefined | null): boolean {
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

export interface TableContainerProps {
  tableEl: TableEl;
  canvasScale: number;
  activeTool: ToolId | null;
  locked: boolean;
  textMarqueeSelected?: boolean;
  onResize: (id: string, changes: Partial<TableEl>) => void;
  onCellChange: (id: string, r: number, c: number, html: string) => void;
  onCellBlur: (id: string, r: number, c: number, html: string) => void;
  onCellFocus: (id: string, r: number, c: number) => void;
  onCellMeasure: (id: string, r: number, c: number, w: number, h: number) => void;
  onCellKeyDown: (e: KeyboardEvent, adapter: TiptapTextAdapter, tableId: string, r: number, c: number) => boolean;
  onCellContextMenu: (id: string, r: number, c: number, clientX: number, clientY: number) => void;
  registerCellEditor: (cellKey: string, editor: Editor | null) => void;
  // True when the table has left the viewport but is still mounted so it can
  // tear down its Tiptap editors asynchronously. onDespawned is called once
  // all cells have been shed, signalling the parent it's safe to unmount.
  despawning?: boolean;
  onDespawned?: (tableId: string) => void;
}

// ── Component ───────────────────────────────────────────────────────────────

function TableContainer({
  tableEl,
  canvasScale,
  activeTool,
  locked,
  textMarqueeSelected,
  onResize,
  onCellChange,
  onCellBlur,
  onCellFocus,
  onCellMeasure,
  onCellKeyDown,
  onCellContextMenu,
  registerCellEditor,
  despawning,
  onDespawned,
}: TableContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  // Phase 1 flag: skeleton blob → grid shell. One rAF hop so the blob paints.
  const [shellMounted, setShellMounted] = useState(false);
  // Which flat cell indices currently have a Tiptap editor mounted. Non-empty
  // cells get added here progressively via rIC on spawn. Empty cells are *only*
  // added on explicit user click — they stay as the pulsing placeholder until
  // edited, so viewport entry never pays Tiptap mount cost for empty cells.
  const [mountedIndices, setMountedIndices] = useState<ReadonlySet<number>>(() => new Set());

  const resizeDragRef = useRef<{
    edge: Edge;
    startScreenX: number;
    startScreenY: number;
    startW: number;
    startH: number;
    startX: number;
    startY: number;
    startColWidths: number[];
    startRowHeights: number[];
    last?: { w: number; h: number; x: number; y: number; colWidths: number[]; rowHeights: number[] };
  } | null>(null);

  const dividerDragRef = useRef<{
    kind: "col" | "row";
    index: number;
    startClient: number;
    startSize: number;
    startColWidths: number[];
    startRowHeights: number[];
    startColOffsets: number[];
    startRowOffsets: number[];
    startTotalW: number;
    startTotalH: number;
    min: number;
    last?: { colWidths?: number[]; rowHeights?: number[]; w: number; h: number };
  } | null>(null);

  // Set true while any resize (frame or divider) is in progress so cell
  // ResizeObserver fires don't fight our direct DOM writes or commit stale
  // measurements through the history stack.
  const isLiveResizingRef = useRef(false);

  const rows = tableEl.cells.length;
  const cols = tableEl.cells[0]?.length ?? 0;

  // Flat indices of non-empty cells in natural (row-major) order. These are
  // what we auto-mount during the passive hydration phase. Empty cells are
  // excluded — they mount only if user clicks them.
  const nonEmptyIndices = useMemo<number[]>(() => {
    const arr: number[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!isCellBlank(tableEl.cells[r]?.[c]?.html)) arr.push(r * cols + c);
      }
    }
    return arr;
  }, [tableEl.cells, rows, cols]);

  // Immediate-mount path for click-activation on empty cells. Returns true if
  // we actually added anything (i.e. the cell wasn't already mounted).
  const activateCell = useCallback((flatIdx: number) => {
    setMountedIndices((prev) => {
      if (prev.has(flatIdx)) return prev;
      const next = new Set(prev);
      next.add(flatIdx);
      return next;
    });
  }, []);

  // Phase 1: let the skeleton paint once, then swap in the grid shell.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShellMounted(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Phase 2: mount one non-empty cell per idle callback.
  //
  // requestIdleCallback schedules the work only when the browser has spare
  // time (no scroll, no other input). If the user is scrolling through the
  // canvas, hydration pauses automatically. Falls back to rAF on Safari.
  useEffect(() => {
    if (!shellMounted) return;
    if (despawning) return;          // don't re-grow during a despawn
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

  // Phase 3: despawn — shed one mounted cell per idle callback, mirroring
  // mount. Once the set is empty we call onDespawned so the parent can drop us.
  useEffect(() => {
    if (!despawning) return;
    if (mountedIndices.size === 0) {
      onDespawned?.(tableEl.id);
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
  }, [despawning, mountedIndices, onDespawned, tableEl.id]);

  // ── Layout: per-column width ───────────────────────────────────────────────
  // If the user has pinned a width (by resizing), respect it — the editor is
  // constrained to 100% of the cell, so text wraps down rather than forcing
  // the column wider. Before any pin, fall back to measured content width.
  const colWidths = useMemo<number[]>(() => {
    return Array.from({ length: cols }, (_, c) => {
      const pinned = tableEl.colWidths?.[c] ?? 0;
      if (pinned > 0) return Math.max(MIN_COL_W, pinned);
      let maxMeasured = 0;
      for (let r = 0; r < rows; r++) {
        const mw = tableEl.cells[r]?.[c]?.measuredW ?? 0;
        if (mw > maxMeasured) maxMeasured = mw;
      }
      return Math.max(MIN_COL_W, maxMeasured + CELL_PAD * 2);
    });
  }, [tableEl.cells, tableEl.colWidths, rows, cols]);

  const rowHeights = useMemo<number[]>(() => {
    return Array.from({ length: rows }, (_, r) => {
      let maxMeasured = 0;
      for (let c = 0; c < cols; c++) {
        const mh = tableEl.cells[r]?.[c]?.measuredH ?? 0;
        if (mh > maxMeasured) maxMeasured = mh;
      }
      const pinned = tableEl.rowHeights?.[r] ?? 0;
      return Math.max(MIN_ROW_H, pinned, maxMeasured + CELL_PAD * 2);
    });
  }, [tableEl.cells, tableEl.rowHeights, rows, cols]);

  const totalW = useMemo(() => colWidths.reduce((s, w) => s + w, 0) + (cols + 1) * BORDER_PX, [colWidths, cols]);
  const totalH = useMemo(() => rowHeights.reduce((s, h) => s + h, 0) + (rows + 1) * BORDER_PX, [rowHeights, rows]);

  // ── Cell column-start offsets (for absolute positioning) ──────────────────
  const colOffsets = useMemo(() => {
    const out: number[] = [];
    let x = BORDER_PX;
    for (let c = 0; c < cols; c++) {
      out.push(x);
      x += colWidths[c] + BORDER_PX;
    }
    return out;
  }, [colWidths, cols]);

  const rowOffsets = useMemo(() => {
    const out: number[] = [];
    let y = BORDER_PX;
    for (let r = 0; r < rows; r++) {
      out.push(y);
      y += rowHeights[r] + BORDER_PX;
    }
    return out;
  }, [rowHeights, rows]);

  // ── Sync computed w/h back into the element when content grows/shrinks. ─────
  const lastSyncRef = useRef<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (resizeDragRef.current) return; // skip during user-drag
    if (lastSyncRef.current?.w === totalW && lastSyncRef.current?.h === totalH) return;
    if (tableEl.w === totalW && tableEl.h === totalH) {
      lastSyncRef.current = { w: totalW, h: totalH };
      return;
    }
    lastSyncRef.current = { w: totalW, h: totalH };
    const id = requestAnimationFrame(() => {
      onResize(tableEl.id, { w: totalW, h: totalH });
    });
    return () => cancelAnimationFrame(id);
  }, [totalW, totalH, tableEl.id, tableEl.w, tableEl.h, onResize]);

  // ── Live layout helper (drag preview, no React churn) ─────────────────────

  /** During a drag we write cell/divider/container geometry straight to the
   *  DOM so we don't re-render every Tiptap editor on every pointer move. The
   *  final values are committed through onResize once at pointerup. */
  const applyLiveGrid = useCallback((widths: number[], heights: number[], x: number, y: number, w: number, h: number) => {
    const node = containerRef.current;
    if (!node) return;
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.style.width = `${w}px`;
    node.style.height = `${h}px`;

    const colOffs: number[] = [];
    {
      let off = BORDER_PX;
      for (let c = 0; c < widths.length; c++) {
        colOffs.push(off);
        off += widths[c] + BORDER_PX;
      }
    }
    const rowOffs: number[] = [];
    {
      let off = BORDER_PX;
      for (let r = 0; r < heights.length; r++) {
        rowOffs.push(off);
        off += heights[r] + BORDER_PX;
      }
    }

    const cellNodes = node.querySelectorAll<HTMLElement>("[data-table-cell]");
    cellNodes.forEach((cellNode) => {
      const r = parseInt(cellNode.dataset.cellRow ?? "-1", 10);
      const c = parseInt(cellNode.dataset.cellCol ?? "-1", 10);
      if (r < 0 || c < 0 || r >= heights.length || c >= widths.length) return;
      cellNode.style.left = `${colOffs[c]}px`;
      cellNode.style.top = `${rowOffs[r]}px`;
      cellNode.style.width = `${widths[c]}px`;
      cellNode.style.height = `${heights[r]}px`;
    });

    const colDivs = node.querySelectorAll<HTMLElement>("[data-col-div]");
    colDivs.forEach((divNode) => {
      const c = parseInt(divNode.dataset.colDiv ?? "-1", 10);
      if (c < 0 || c >= widths.length - 1) return;
      divNode.style.left = `${colOffs[c] + widths[c] - 3}px`;
      divNode.style.height = `${h}px`;
    });

    const rowDivs = node.querySelectorAll<HTMLElement>("[data-row-div]");
    rowDivs.forEach((divNode) => {
      const r = parseInt(divNode.dataset.rowDiv ?? "-1", 10);
      if (r < 0 || r >= heights.length - 1) return;
      divNode.style.top = `${rowOffs[r] + heights[r] - 3}px`;
      divNode.style.width = `${w}px`;
    });
  }, []);

  // ── Frame resize (corner/edge handles) ─────────────────────────────────────

  const handleResizePointerDown = useCallback((e: React.PointerEvent, edge: Edge) => {
    if (locked) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    // Use live totalW/totalH (derived from colWidths/rowHeights) as the drag
    // baseline. On a freshly spawned table, tableEl.w/h may still reflect the
    // spawn-time placeholder dims, unreconciled with the real grid until the
    // lastSyncRef effect commits — using those would scale the drag delta
    // against the wrong base and the frame would stretch off-screen.
    resizeDragRef.current = {
      edge,
      startScreenX: e.clientX,
      startScreenY: e.clientY,
      startW: totalW,
      startH: totalH,
      startX: tableEl.x,
      startY: tableEl.y,
      startColWidths: [...colWidths],
      startRowHeights: [...rowHeights],
    };
    isLiveResizingRef.current = true;
  }, [locked, totalW, totalH, tableEl.x, tableEl.y, colWidths, rowHeights]);

  const handleResizePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = resizeDragRef.current;
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();

    const dx = (e.clientX - drag.startScreenX) / canvasScale;
    const dy = (e.clientY - drag.startScreenY) / canvasScale;
    const { edge } = drag;

    let newW = drag.startW;
    let newH = drag.startH;
    let newX = drag.startX;
    let newY = drag.startY;

    if (EDGE_HAS_RIGHT.has(edge))  newW = Math.max(MIN_W, drag.startW + dx);
    if (EDGE_HAS_LEFT.has(edge))   { newW = Math.max(MIN_W, drag.startW - dx); newX = drag.startX + (drag.startW - newW); }
    if (EDGE_HAS_BOTTOM.has(edge)) newH = Math.max(MIN_H, drag.startH + dy);
    if (EDGE_HAS_TOP.has(edge))    { newH = Math.max(MIN_H, drag.startH - dy); newY = drag.startY + (drag.startH - newH); }

    // Scale colWidths / rowHeights proportionally to the new frame (excluding borders).
    const contentW0 = drag.startW - (cols + 1) * BORDER_PX;
    const contentH0 = drag.startH - (rows + 1) * BORDER_PX;
    const contentW1 = newW - (cols + 1) * BORDER_PX;
    const contentH1 = newH - (rows + 1) * BORDER_PX;
    const scaleX = contentW0 > 0 ? contentW1 / contentW0 : 1;
    const scaleY = contentH0 > 0 ? contentH1 / contentH0 : 1;
    const nextCol = drag.startColWidths.map((w) => Math.max(MIN_COL_W, w * scaleX));
    const nextRow = drag.startRowHeights.map((h) => Math.max(MIN_ROW_H, h * scaleY));

    applyLiveGrid(nextCol, nextRow, newX, newY, newW, newH);
    drag.last = { w: newW, h: newH, x: newX, y: newY, colWidths: nextCol, rowHeights: nextRow };
  }, [canvasScale, cols, rows, applyLiveGrid]);

  const handleResizePointerUp = useCallback((e: React.PointerEvent) => {
    const drag = resizeDragRef.current;
    if (!drag) return;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    isLiveResizingRef.current = false;
    if (drag.last) {
      onResize(tableEl.id, drag.last);
    }
    resizeDragRef.current = null;
  }, [tableEl.id, onResize]);

  const showHandles = !locked && (isHovered || resizeDragRef.current != null);

  // ── Divider drags (per-column / per-row) ───────────────────────────────────

  const computeColMin = useCallback((_c: number): number => {
    // Text wraps to cell width, so columns can shrink to the hard MIN_COL_W
    // regardless of content. Rows will grow to fit the wrapped text.
    return MIN_COL_W;
  }, []);

  const computeRowMin = useCallback((_r: number): number => {
    // Rows keep their measuredH floor via the `rowHeights` memo even when the
    // user drags a row-divider smaller. Start the drag at MIN_ROW_H so the
    // user can attempt any target; the memo clamps to content height.
    return MIN_ROW_H;
  }, []);

  const handleDividerDown = useCallback((e: React.PointerEvent, kind: "col" | "row", index: number) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dividerDragRef.current = {
      kind,
      index,
      startClient: kind === "col" ? e.clientX : e.clientY,
      startSize: kind === "col" ? colWidths[index] : rowHeights[index],
      startColWidths: [...colWidths],
      startRowHeights: [...rowHeights],
      startColOffsets: [...colOffsets],
      startRowOffsets: [...rowOffsets],
      startTotalW: totalW,
      startTotalH: totalH,
      min: kind === "col" ? computeColMin(index) : computeRowMin(index),
    };
    isLiveResizingRef.current = true;
  }, [colWidths, rowHeights, colOffsets, rowOffsets, totalW, totalH, computeColMin, computeRowMin]);

  const handleDividerMove = useCallback((e: React.PointerEvent) => {
    const drag = dividerDragRef.current;
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    const delta = ((drag.kind === "col" ? e.clientX : e.clientY) - drag.startClient) / canvasScale;
    const next = Math.max(drag.min, drag.startSize + delta);
    if (drag.kind === "col") {
      const nextColWidths = [...drag.startColWidths];
      nextColWidths[drag.index] = next;
      const newW = drag.startTotalW + (next - drag.startSize);
      applyLiveGrid(nextColWidths, drag.startRowHeights, tableEl.x, tableEl.y, newW, drag.startTotalH);
      drag.last = { colWidths: nextColWidths, w: newW, h: drag.startTotalH };
    } else {
      const nextRowHeights = [...drag.startRowHeights];
      nextRowHeights[drag.index] = next;
      const newH = drag.startTotalH + (next - drag.startSize);
      applyLiveGrid(drag.startColWidths, nextRowHeights, tableEl.x, tableEl.y, drag.startTotalW, newH);
      drag.last = { rowHeights: nextRowHeights, w: drag.startTotalW, h: newH };
    }
  }, [canvasScale, tableEl.x, tableEl.y, applyLiveGrid]);

  const handleDividerUp = useCallback((e: React.PointerEvent) => {
    const drag = dividerDragRef.current;
    if (!drag) return;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    isLiveResizingRef.current = false;
    if (drag.last) {
      const changes: Partial<TableEl> = drag.kind === "col"
        ? { colWidths: drag.last.colWidths, w: drag.last.w }
        : { rowHeights: drag.last.rowHeights, h: drag.last.h };
      onResize(tableEl.id, changes);
    }
    dividerDragRef.current = null;
  }, [tableEl.id, onResize]);

  const dividerPointerProps = {
    onPointerMove: handleDividerMove,
    onPointerUp: handleDividerUp,
  };

  const resizePointerProps = {
    onPointerMove: handleResizePointerMove,
    onPointerUp: handleResizePointerUp,
  };

  // While any resize drag is live we write cell geometry directly to the DOM.
  // The editor ResizeObserver would otherwise fire onMeasure for every frame,
  // committing stale widths back through the store and racing our writes.
  const onCellMeasureGated = useCallback<TableContainerProps["onCellMeasure"]>((id, r, c, w, h) => {
    if (isLiveResizingRef.current) return;
    onCellMeasure(id, r, c, w, h);
  }, [onCellMeasure]);

  // ── Edge / corner handle helpers ───────────────────────────────────────────

  const edgeHandle = (edge: Edge, style: React.CSSProperties, cursor: string, pip: React.CSSProperties) => (
    <div
      data-table-handle
      onPointerDown={(e) => handleResizePointerDown(e, edge)}
      {...resizePointerProps}
      style={{
        position: "absolute",
        cursor,
        opacity: showHandles ? 1 : 0,
        transition: "opacity 0.15s",
        pointerEvents: "auto",
        ...style,
      }}
    >
      <div style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        borderRadius: 3,
        background: "var(--th-text)",
        opacity: 0.55,
        ...pip,
      }} />
    </div>
  );

  const cornerHandle = (edge: Edge, style: React.CSSProperties, cursor: string) => (
    <div
      data-table-handle
      onPointerDown={(e) => handleResizePointerDown(e, edge)}
      {...resizePointerProps}
      style={{
        position: "absolute",
        width: HANDLE_SIZE * 2,
        height: HANDLE_SIZE * 2,
        cursor,
        opacity: showHandles ? 1 : 0,
        transition: "opacity 0.15s",
        pointerEvents: "auto",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        ...style,
      }}
    >
      <div style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--th-text)", opacity: 0.55 }} />
    </div>
  );

  if (!shellMounted) {
    return (
      <div
        data-el
        data-el-id={tableEl.id}
        data-table-container
        data-table-skeleton
        style={{
          position: "absolute",
          left: tableEl.x,
          top: tableEl.y,
          width: totalW,
          height: totalH,
          borderRadius: 6,
          background: "var(--th-surface-hover)",
          border: `${BORDER_PX}px solid var(--th-table-divider)`,
          animation: "table-skeleton-pulse 1.1s ease-in-out infinite",
          outline: textMarqueeSelected ? "2px solid var(--th-accent, #60a5fa)" : undefined,
          outlineOffset: textMarqueeSelected ? 2 : undefined,
        }}
      />
    );
  }

  return (
    <div
      ref={containerRef}
      data-el
      data-el-id={tableEl.id}
      data-table-container
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => { if (!resizeDragRef.current) setIsHovered(false); }}
      style={{
        position: "absolute",
        left: tableEl.x,
        top: tableEl.y,
        width: totalW,
        height: totalH,
        overflow: "visible",
        outline: textMarqueeSelected ? "2px solid var(--th-accent, #60a5fa)" : undefined,
        outlineOffset: textMarqueeSelected ? 2 : undefined,
      }}
    >
      {/* Table body: border box containing absolutely-positioned cells. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 6,
          border: `${BORDER_PX}px solid var(--th-table-divider)`,
          background: "var(--th-surface-hover)",
          overflow: "hidden",
        }}
      >
        {tableEl.cells.map((row, r) => (
          row.map((cell, c) => (
            <TableCellBox
              key={`${r}:${c}`}
              tableId={tableEl.id}
              row={r}
              col={c}
              isHeader={r === 0}
              cell={cell}
              left={colOffsets[c]}
              top={rowOffsets[r]}
              width={colWidths[c]}
              height={rowHeights[r]}
              isLastCol={c === cols - 1}
              isLastRow={r === rows - 1}
              locked={locked}
              isMoverTool={activeTool === "mover"}
              wrap={(tableEl.colWidths?.[c] ?? 0) > 0}
              tiptapMounted={mountedIndices.has(r * cols + c)}
              flatIdx={r * cols + c}
              activateCell={activateCell}
              onCellChange={onCellChange}
              onCellBlur={onCellBlur}
              onCellFocus={onCellFocus}
              onCellMeasure={onCellMeasureGated}
              onCellKeyDown={onCellKeyDown}
              onCellContextMenu={onCellContextMenu}
              registerCellEditor={registerCellEditor}
            />
          ))
        ))}

        {/* Column dividers (between columns) — drag to resize column C left of handle */}
        {!locked && Array.from({ length: cols - 1 }, (_, c) => (
          <div
            key={`col-div-${c}`}
            data-table-handle
            data-col-div={c}
            onPointerDown={(e) => handleDividerDown(e, "col", c)}
            {...dividerPointerProps}
            style={{
              position: "absolute",
              left: colOffsets[c] + colWidths[c] - 3,
              top: 0,
              width: 7,
              height: totalH,
              cursor: "col-resize",
              zIndex: 1,
            }}
          />
        ))}

        {/* Row dividers */}
        {!locked && Array.from({ length: rows - 1 }, (_, r) => (
          <div
            key={`row-div-${r}`}
            data-table-handle
            data-row-div={r}
            onPointerDown={(e) => handleDividerDown(e, "row", r)}
            {...dividerPointerProps}
            style={{
              position: "absolute",
              top: rowOffsets[r] + rowHeights[r] - 3,
              left: 0,
              height: 7,
              width: totalW,
              cursor: "row-resize",
              zIndex: 1,
            }}
          />
        ))}
      </div>

      {/* ── Edge handles ───────────────────────────────────────────────── */}
      {edgeHandle("right",  { top: 0, right: -HANDLE_SIZE / 2, width: HANDLE_SIZE, height: "100%" }, "ew-resize", { width: 5, height: 32 })}
      {edgeHandle("left",   { top: 0, left: -HANDLE_SIZE / 2, width: HANDLE_SIZE, height: "100%" }, "ew-resize", { width: 5, height: 32 })}
      {edgeHandle("bottom", { bottom: -HANDLE_SIZE / 2, left: 0, width: "100%", height: HANDLE_SIZE }, "ns-resize", { width: 32, height: 5 })}
      {edgeHandle("top",    { top: -HANDLE_SIZE / 2, left: 0, width: "100%", height: HANDLE_SIZE }, "ns-resize", { width: 32, height: 5 })}

      {/* ── Corner handles ─────────────────────────────────────────────── */}
      {cornerHandle("br", { bottom: -HANDLE_SIZE / 2, right: -HANDLE_SIZE / 2 }, "nwse-resize")}
      {cornerHandle("tl", { top: -HANDLE_SIZE / 2, left: -HANDLE_SIZE / 2 }, "nwse-resize")}
      {cornerHandle("tr", { top: -HANDLE_SIZE / 2, right: -HANDLE_SIZE / 2 }, "nesw-resize")}
      {cornerHandle("bl", { bottom: -HANDLE_SIZE / 2, left: -HANDLE_SIZE / 2 }, "nesw-resize")}

    </div>
  );
}

export default memo(TableContainer);

// ── Cell component ──────────────────────────────────────────────────────────

interface TableCellBoxProps {
  tableId: string;
  row: number;
  col: number;
  isHeader: boolean;
  cell: TableCell;
  left: number;
  top: number;
  width: number;
  height: number;
  isLastCol: boolean;
  isLastRow: boolean;
  locked: boolean;
  isMoverTool: boolean;
  wrap: boolean;
  tiptapMounted: boolean;
  flatIdx: number;
  activateCell: (flatIdx: number) => void;
  onCellChange: (id: string, r: number, c: number, html: string) => void;
  onCellBlur: (id: string, r: number, c: number, html: string) => void;
  onCellFocus: (id: string, r: number, c: number) => void;
  onCellMeasure: (id: string, r: number, c: number, w: number, h: number) => void;
  onCellKeyDown: (e: KeyboardEvent, adapter: TiptapTextAdapter, tableId: string, r: number, c: number) => boolean;
  onCellContextMenu: (id: string, r: number, c: number, clientX: number, clientY: number) => void;
  registerCellEditor: (cellKey: string, editor: Editor | null) => void;
}

const TableCellBox = memo(function TableCellBox({
  tableId,
  row,
  col,
  isHeader,
  cell,
  left,
  top,
  width,
  height,
  isLastCol,
  isLastRow,
  locked,
  isMoverTool,
  wrap,
  tiptapMounted,
  flatIdx,
  activateCell,
  onCellChange,
  onCellBlur,
  onCellFocus,
  onCellMeasure,
  onCellKeyDown,
  onCellContextMenu,
  registerCellEditor,
}: TableCellBoxProps) {
  const cellKey = `${tableId}:${row}:${col}`;

  const editorStoreRef = useRef<Editor | null>(null);
  // Latest-ref for registerCellEditor so the proxy's useMemo stays stable
  // even if the parent passes a new function identity each render.
  const registerCellEditorRef = useRef(registerCellEditor);
  registerCellEditorRef.current = registerCellEditor;
  const editorRefProxy = useMemo<React.MutableRefObject<Editor | null>>(() => ({
    get current(): Editor | null { return editorStoreRef.current; },
    set current(ed: Editor | null) {
      editorStoreRef.current = ed;
      registerCellEditorRef.current(cellKey, ed ?? null);
    },
  }), [cellKey]);

  useEffect(() => {
    return () => {
      registerCellEditorRef.current(cellKey, null);
    };
  }, [cellKey]);

  // When a click triggers Tiptap to mount, we want to focus the freshly-mounted
  // editor. But passive (priority-queue) mounts shouldn't steal focus. Flag
  // the click in this ref; the mount effect below consumes it.
  const pendingFocusRef = useRef(false);
  useEffect(() => {
    if (!tiptapMounted) return;
    if (!pendingFocusRef.current) return;
    pendingFocusRef.current = false;
    const raf = requestAnimationFrame(() => {
      const ed = editorStoreRef.current;
      if (ed && !ed.isFocused) ed.commands.focus("end", { scrollIntoView: false });
    });
    return () => cancelAnimationFrame(raf);
  }, [tiptapMounted]);

  // Editable when the cell's Tiptap editor is editable (not locked, not in mover mode).
  const editable = !locked && !isMoverTool;

  return (
    <div
      data-table-cell
      data-cell-row={row}
      data-cell-col={col}
      data-wrap={wrap ? "1" : "0"}
      onMouseDown={(e) => {
        if (!editable) return;
        // Let middle/right-click (pan / context menu) bubble to the canvas.
        if (e.button !== 0) return;
        e.stopPropagation();
        if (!tiptapMounted) {
          // Empty cell click: mount Tiptap now, flag for focus-after-mount.
          e.preventDefault();
          pendingFocusRef.current = true;
          activateCell(flatIdx);
          return;
        }
        // Already mounted — empty cells render as `<p></p>` which our global
        // CSS hides, so explicit focus is needed when the click misses text.
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
        onCellContextMenu(tableId, row, col, e.clientX, e.clientY);
      }}
      style={{
        position: "absolute",
        left,
        top,
        width,
        height,
        padding: CELL_PAD,
        boxSizing: "border-box",
        borderRight: !isLastCol ? `${BORDER_PX}px solid var(--th-table-divider)` : "none",
        borderBottom: !isLastRow ? `${BORDER_PX}px solid var(--th-table-divider)` : "none",
        background: isHeader ? "var(--th-surface)" : "transparent",
        fontWeight: isHeader ? 600 : 400,
        overflow: "hidden",
        cursor: editable ? "text" : "default",
      }}
    >
      {tiptapMounted ? (
        <RichTextEditor
          id={cellKey}
          html={cell.html}
          fontScale={2}
          locked={locked}
          isMoverTool={isMoverTool}
          onChange={(html) => onCellChange(tableId, row, col, html)}
          onBlur={(html) => onCellBlur(tableId, row, col, html)}
          onFocus={() => onCellFocus(tableId, row, col)}
          onKeyDown={(e, adapter) => onCellKeyDown(e, adapter, tableId, row, col)}
          onMeasure={(w, h) => onCellMeasure(tableId, row, col, w, h)}
          editorRef={editorRefProxy}
        />
      ) : !isCellBlank(cell.html) ? (
        // Cell has content but Tiptap hasn't mounted yet — show the pulsing
        // bar as a loading hint. Empty cells render nothing.
        <div className="table-cell-skeleton-bar" />
      ) : null}
    </div>
  );
});
