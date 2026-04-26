// Pure placement-op builders for checklist elements. 1D analog of canvas-table-ops.ts —
// item edits, measure reporting, enter-to-insert / backspace-to-remove, checkbox toggle,
// and insert/remove at index.

import type { Editor } from "@tiptap/react";
import { verticalEnterPush } from "./canvas-utils";
import type { CanvasEl, ChecklistEl, ChecklistItem, PlacementOp, PlacementResponse } from "./canvas-types";
import type { TiptapTextAdapter } from "../components/RichTextEditor";

export interface ChecklistOpsDeps {
  readAllElements: () => CanvasEl[];
  execPlace: (
    op: PlacementOp,
    opts?: PlacementResponse & { immediate?: boolean; skipHistory?: boolean; changedId?: string },
  ) => void;
  /** Look up the Tiptap editor for item (checklistId, index). Used for keyboard nav after insert/remove. */
  getItemEditor: (checklistId: string, index: number) => Editor | undefined;
}

/** Tiptap emits `<p></p>` / `<p><br></p>` for an empty doc — treat those as blank. */
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

export function itemChange(
  deps: ChecklistOpsDeps,
  checklistId: string,
  index: number,
  html: string,
) {
  deps.execPlace(
    {
      kind: "transform",
      fn: (elements) => elements.map((el) => {
        if (el.id !== checklistId || el.type !== "checklist") return el;
        if (!el.items[index]) return el;
        const items = el.items.slice();
        items[index] = { ...items[index], html };
        return { ...el, items };
      }),
    },
    { immediate: false, changedId: checklistId },
  );
}

export function itemToggle(deps: ChecklistOpsDeps, checklistId: string, index: number) {
  deps.execPlace(
    {
      kind: "transform",
      fn: (elements) => elements.map((el) => {
        if (el.id !== checklistId || el.type !== "checklist") return el;
        if (!el.items[index]) return el;
        const items = el.items.slice();
        items[index] = { ...items[index], checked: !items[index].checked };
        return { ...el, items };
      }),
    },
    { immediate: true, changedId: checklistId },
  );
}

export function itemMeasure(
  deps: ChecklistOpsDeps,
  checklistId: string,
  index: number,
  w: number,
  h: number,
) {
  const cl = deps.readAllElements().find((e): e is ChecklistEl => e.id === checklistId && e.type === "checklist");
  if (!cl) return;
  const existing = cl.items[index];
  if (!existing) return;
  if (Math.abs((existing.measuredW ?? 0) - w) <= 1 && Math.abs((existing.measuredH ?? 0) - h) <= 1) return;

  // Did this item's growth push the row max up?
  let rowMax = 0;
  for (let i = 0; i < cl.items.length; i++) {
    if (i === index) continue;
    const mh = cl.items[i]?.measuredH ?? 0;
    if (mh > rowMax) rowMax = mh;
  }
  const grewRowMax = h > rowMax;
  const resolve = grewRowMax ? verticalEnterPush() : undefined;

  deps.execPlace(
    {
      kind: "mutate",
      id: checklistId,
      changes: {
        items: cl.items.map((it, i) => {
          if (i !== index) return it;
          return { ...it, measuredW: w, measuredH: h };
        }),
      },
      resolve,
    },
    { skipHistory: true },
  );
}

export function itemKeyDown(
  deps: ChecklistOpsDeps,
  e: KeyboardEvent,
  adapter: TiptapTextAdapter,
  checklistId: string,
  index: number,
): boolean {
  if (e.key === "Escape") {
    adapter.blur();
    e.preventDefault();
    return true;
  }

  const cl = deps.readAllElements().find((el): el is ChecklistEl => el.id === checklistId && el.type === "checklist");
  if (!cl) return false;

  const focusItem = (i: number): boolean => {
    if (i < 0 || i >= cl.items.length) return false;
    const next = deps.getItemEditor(checklistId, i);
    if (!next) return false;
    adapter.blur();
    requestAnimationFrame(() => {
      next.commands.focus("end", { scrollIntoView: false });
    });
    return true;
  };

  // Enter is intentionally handled in ChecklistContainer — the new row needs
  // to be force-mounted (empty items skip lazy-mount) before we can focus it,
  // and activateItem lives there.

  if (e.key === "Backspace") {
    const html = adapter.editor.getHTML();
    if (isItemBlank(html) && cl.items.length > 1) {
      e.preventDefault();
      removeItem(deps, checklistId, index);
      // Focus the previous item (or stay at 0 if we removed the top).
      const target = Math.max(0, index - 1);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => focusItem(target));
      });
      return true;
    }
  }

  return false;
}

export function insertItem(deps: ChecklistOpsDeps, checklistId: string, atIndex: number) {
  deps.execPlace(
    {
      kind: "transform",
      fn: (elements) => elements.map((el) => {
        if (el.id !== checklistId || el.type !== "checklist") return el;
        const items = el.items.slice();
        const idx = Math.max(0, Math.min(atIndex, items.length));
        const newItem: ChecklistItem = { html: "", checked: false };
        items.splice(idx, 0, newItem);
        const itemHeights = el.itemHeights ? (() => {
          const ih = el.itemHeights.slice();
          ih.splice(idx, 0, 0);
          return ih;
        })() : undefined;
        return { ...el, items, itemHeights };
      }),
      resolve: verticalEnterPush(),
    },
    { immediate: true, changedId: checklistId },
  );
}

export function removeItem(deps: ChecklistOpsDeps, checklistId: string, atIndex: number) {
  deps.execPlace(
    {
      kind: "transform",
      fn: (elements) => elements.map((el) => {
        if (el.id !== checklistId || el.type !== "checklist") return el;
        if (el.items.length <= 1) return el;
        const items = el.items.slice();
        items.splice(atIndex, 1);
        const itemHeights = el.itemHeights ? (() => {
          const ih = el.itemHeights.slice();
          if (atIndex < ih.length) ih.splice(atIndex, 1);
          return ih;
        })() : undefined;
        return { ...el, items, itemHeights };
      }),
    },
    { immediate: true, changedId: checklistId },
  );
}

/** Strip transient measured dims from every item — used on the persistence path. */
export function stripChecklistItemMeasures(items: ChecklistItem[]): ChecklistItem[] {
  return items.map((it) => {
    if (it.measuredW === undefined && it.measuredH === undefined) return it;
    const { html, checked } = it;
    return { html, checked };
  });
}
