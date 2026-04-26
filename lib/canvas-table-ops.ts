// Pure placement-op builders for table elements. Cell edits, measure
// reporting, tab/enter navigation, and row/column insert/remove.

import type { Editor } from "@tiptap/react";
import { horizontalTextPush, verticalEnterPush } from "./canvas-utils";
import type { CanvasEl, PlacementOp, PlacementResponse, TableCell, TableEl } from "./canvas-types";
import type { TiptapTextAdapter } from "../components/RichTextEditor";

export interface TableOpsDeps {
  readAllElements: () => CanvasEl[];
  execPlace: (
    op: PlacementOp,
    opts?: PlacementResponse & { immediate?: boolean; skipHistory?: boolean; changedId?: string },
  ) => void;
  /** Look up the Tiptap editor for cell (tableId, r, c). Used for keyboard navigation. */
  getCellEditor: (tableId: string, r: number, c: number) => Editor | undefined;
}

export function cellChange(
  deps: TableOpsDeps,
  tableId: string,
  r: number,
  c: number,
  html: string,
) {
  deps.execPlace(
    {
      kind: "transform",
      fn: (elements) => elements.map((el) => {
        if (el.id !== tableId || el.type !== "table") return el;
        const cells = el.cells.map((row) => row.slice());
        if (!cells[r] || !cells[r][c]) return el;
        const existing = cells[r][c];
        cells[r][c] = { ...existing, html };
        return { ...el, cells };
      }),
    },
    { immediate: false, changedId: tableId },
  );
}

export function cellMeasure(
  deps: TableOpsDeps,
  tableId: string,
  r: number,
  c: number,
  w: number,
  h: number,
) {
  const table = deps.readAllElements().find((e): e is TableEl => e.id === tableId && e.type === "table");
  if (!table) return;
  const existing = table.cells[r]?.[c];
  if (!existing) return;
  if (Math.abs((existing.measuredW ?? 0) - w) <= 1 && Math.abs((existing.measuredH ?? 0) - h) <= 1) return;

  // Did this cell's growth push the column/row max up?
  let colMax = 0, rowMax = 0;
  for (let rr = 0; rr < table.cells.length; rr++) {
    const mw = table.cells[rr]?.[c]?.measuredW ?? 0;
    if (rr !== r && mw > colMax) colMax = mw;
  }
  for (let cc = 0; cc < (table.cells[r]?.length ?? 0); cc++) {
    const mh = table.cells[r]?.[cc]?.measuredH ?? 0;
    if (cc !== c && mh > rowMax) rowMax = mh;
  }
  const grewColMax = w > colMax;
  const grewRowMax = h > rowMax;
  const resolve = grewRowMax ? verticalEnterPush() : grewColMax ? horizontalTextPush(1) : undefined;

  deps.execPlace(
    {
      kind: "mutate",
      id: tableId,
      changes: {
        cells: table.cells.map((row, rr) => row.map((cell, cc) => {
          if (rr !== r || cc !== c) return cell;
          return { ...cell, measuredW: w, measuredH: h };
        })),
      },
      resolve,
    },
    { skipHistory: true },
  );
}

export function cellKeyDown(
  deps: TableOpsDeps,
  e: KeyboardEvent,
  adapter: TiptapTextAdapter,
  tableId: string,
  r: number,
  c: number,
): boolean {
  if (e.key === "Escape") {
    adapter.blur();
    e.preventDefault();
    return true;
  }

  const table = deps.readAllElements().find((el): el is TableEl => el.id === tableId && el.type === "table");
  if (!table) return false;
  const rows = table.cells.length;
  const cols = table.cells[0]?.length ?? 0;

  const focusCell = (rr: number, cc: number): boolean => {
    if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) return false;
    const next = deps.getCellEditor(tableId, rr, cc);
    if (!next) return false;
    adapter.blur();
    requestAnimationFrame(() => {
      next.commands.focus("end", { scrollIntoView: false });
    });
    return true;
  };

  if (e.key === "Tab") {
    e.preventDefault();
    if (e.shiftKey) {
      if (c > 0) return focusCell(r, c - 1);
      return focusCell(r - 1, cols - 1);
    } else {
      if (c < cols - 1) return focusCell(r, c + 1);
      return focusCell(r + 1, 0);
    }
  }

  if (e.key === "Enter" && !e.shiftKey) {
    // Move to same column, next row. If at the bottom, let Tiptap handle (insert newline).
    if (r < rows - 1) {
      e.preventDefault();
      return focusCell(r + 1, c);
    }
  }

  return false;
}

export function insertRow(deps: TableOpsDeps, tableId: string, atIndex: number) {
  deps.execPlace(
    {
      kind: "transform",
      fn: (elements) => elements.map((el) => {
        if (el.id !== tableId || el.type !== "table") return el;
        const cols = el.cells[0]?.length ?? 0;
        const newRow: TableCell[] = Array.from({ length: cols }, () => ({ html: "" }));
        const cells = el.cells.slice();
        const idx = Math.max(0, Math.min(atIndex, cells.length));
        cells.splice(idx, 0, newRow);
        const rowHeights = el.rowHeights ? (() => {
          const rh = el.rowHeights.slice();
          rh.splice(idx, 0, 0);
          return rh;
        })() : undefined;
        return { ...el, cells, rowHeights };
      }),
      resolve: verticalEnterPush(),
    },
    { immediate: true, changedId: tableId },
  );
}

export function insertCol(deps: TableOpsDeps, tableId: string, atIndex: number) {
  deps.execPlace(
    {
      kind: "transform",
      fn: (elements) => elements.map((el) => {
        if (el.id !== tableId || el.type !== "table") return el;
        const cells = el.cells.map((row) => {
          const next = row.slice();
          const idx = Math.max(0, Math.min(atIndex, next.length));
          next.splice(idx, 0, { html: "" });
          return next;
        });
        const colWidths = el.colWidths ? (() => {
          const cw = el.colWidths.slice();
          const idx = Math.max(0, Math.min(atIndex, cw.length));
          cw.splice(idx, 0, 0);
          return cw;
        })() : undefined;
        return { ...el, cells, colWidths };
      }),
      resolve: horizontalTextPush(1),
    },
    { immediate: true, changedId: tableId },
  );
}

export function removeRow(deps: TableOpsDeps, tableId: string, atIndex: number) {
  deps.execPlace(
    {
      kind: "transform",
      fn: (elements) => elements.map((el) => {
        if (el.id !== tableId || el.type !== "table") return el;
        if (el.cells.length <= 1) return el;
        const cells = el.cells.slice();
        cells.splice(atIndex, 1);
        const rowHeights = el.rowHeights ? (() => {
          const rh = el.rowHeights.slice();
          if (atIndex < rh.length) rh.splice(atIndex, 1);
          return rh;
        })() : undefined;
        return { ...el, cells, rowHeights };
      }),
    },
    { immediate: true, changedId: tableId },
  );
}

export function removeCol(deps: TableOpsDeps, tableId: string, atIndex: number) {
  deps.execPlace(
    {
      kind: "transform",
      fn: (elements) => elements.map((el) => {
        if (el.id !== tableId || el.type !== "table") return el;
        const cols = el.cells[0]?.length ?? 0;
        if (cols <= 1) return el;
        const cells = el.cells.map((row) => {
          const next = row.slice();
          if (atIndex < next.length) next.splice(atIndex, 1);
          return next;
        });
        const colWidths = el.colWidths ? (() => {
          const cw = el.colWidths.slice();
          if (atIndex < cw.length) cw.splice(atIndex, 1);
          return cw;
        })() : undefined;
        return { ...el, cells, colWidths };
      }),
    },
    { immediate: true, changedId: tableId },
  );
}
