// Shannon note export/import. Round-trip format for moving a note between
// devices or backing it up outside localStorage. Blob-backed image/pdf payloads
// are inlined as base64 data URLs so the file is self-contained; noteRef
// elements are dropped on import since their targets dangle across exports.

import type {
  CanvasEl,
  ChatEl,
  ChecklistEl,
  ChecklistItem,
  ImageEl,
  NoteItem,
  PageRegion,
  PdfEl,
  TableCell,
  TableEl,
  TextEl,
} from "./canvas-types";
import {
  blobToDataUrl,
  collectReferencedBlobIds,
  dataUrlToBlob,
  getBlob,
  putBlob,
} from "./canvas-blob-store";

const SHANNON_VERSION = 1;

type ShannonPayload = {
  shannon: number;
  exportedAt: number;
  note: {
    title: string;
    pageRegions?: PageRegion[];
    elements: CanvasEl[];
  };
  blobs: Record<string, string>;
};

function stripRuntimeFields(el: CanvasEl): CanvasEl {
  switch (el.type) {
    case "chat": {
      const c = el as ChatEl;
      const {
        pendingSubmit: _ps,
        pendingSubmitIsQuick: _psq,
        isStreaming: _str,
        toolStatus: _ts,
        measuredH: _mh,
        estimatedOutputTokens: _eot,
        ...rest
      } = c;
      void _ps; void _psq; void _str; void _ts; void _mh; void _eot;
      return { ...rest, inputText: "" } as ChatEl;
    }
    case "text": {
      const t = el as TextEl;
      const { measuredW: _w, measuredH: _h, ...rest } = t;
      void _w; void _h;
      return rest as TextEl;
    }
    case "table": {
      const tbl = el as TableEl;
      const cells: TableCell[][] = tbl.cells.map(row => row.map(c => ({ html: c.html })));
      return { ...tbl, cells };
    }
    case "checklist": {
      const cl = el as ChecklistEl;
      const items: ChecklistItem[] = cl.items.map(it => ({ html: it.html, checked: it.checked }));
      const { itemHeights: _ih, ...rest } = cl;
      void _ih;
      return { ...rest, items } as ChecklistEl;
    }
    case "image": {
      const im = el as ImageEl;
      const { src: _src, ...rest } = im;
      void _src;
      return rest as ImageEl;
    }
    case "pdf": {
      const p = el as PdfEl;
      const { src: _src, ...rest } = p;
      void _src;
      return rest as PdfEl;
    }
    default:
      return el;
  }
}

export async function exportNoteAsShannon(note: NoteItem): Promise<Blob> {
  const stripped = (note.elements ?? []).map(stripRuntimeFields);

  const ids = collectReferencedBlobIds([{ ...note, elements: stripped }]);
  const blobs: Record<string, string> = {};
  for (const id of ids) {
    try {
      const b = await getBlob(id);
      if (!b) continue;
      blobs[id] = await blobToDataUrl(b);
    } catch {
      // Blob missing or IDB unavailable — skip; reimport will render the
      // element without its src but won't fail the whole export.
    }
  }

  const payload: ShannonPayload = {
    shannon: SHANNON_VERSION,
    exportedAt: Date.now(),
    note: {
      title: note.title,
      pageRegions: note.pageRegions,
      elements: stripped,
    },
    blobs,
  };

  return new Blob([JSON.stringify(payload)], { type: "application/json" });
}

/** Parse a .shannon file and return a fresh NoteItem with new ids, re-interned
 *  blobs, and hydrated image/pdf srcs. NoteRef elements are dropped silently
 *  (their targets reference ids in the exporter's localStorage). */
export async function importShannonNote(file: File | Blob): Promise<NoteItem> {
  const text = await file.text();
  const payload = JSON.parse(text) as ShannonPayload;
  if (payload.shannon !== SHANNON_VERSION) {
    throw new Error(`Unsupported Shannon format version: ${payload.shannon}`);
  }

  const blobIdMap = new Map<string, string>();
  for (const [oldId, dataUrl] of Object.entries(payload.blobs ?? {})) {
    const blob = dataUrlToBlob(dataUrl);
    if (!blob) continue;
    const newId = crypto.randomUUID();
    try {
      await putBlob(newId, blob);
      blobIdMap.set(oldId, newId);
    } catch {
      // IDB write failed — skip this blob
    }
  }

  const rehydrated: CanvasEl[] = [];
  for (const srcEl of payload.note.elements ?? []) {
    if (srcEl.type === "noteRef") continue;
    const el: CanvasEl = { ...srcEl, id: crypto.randomUUID() };
    if ((el.type === "image" || el.type === "pdf") && el.blobId) {
      const newId = blobIdMap.get(el.blobId);
      if (newId) {
        el.blobId = newId;
        try {
          const b = await getBlob(newId);
          if (b) (el as ImageEl | PdfEl).src = await blobToDataUrl(b);
        } catch {
          // leave src unset — element will still render the frame
        }
      } else {
        (el as ImageEl | PdfEl).blobId = undefined;
      }
    }
    rehydrated.push(el);
  }

  const pageRegions = (payload.note.pageRegions ?? []).map(pr => ({
    ...pr,
    id: crypto.randomUUID(),
  }));

  return {
    id: crypto.randomUUID(),
    title: (payload.note.title ?? "Untitled") + " (imported)",
    elements: rehydrated,
    pageRegions: pageRegions.length > 0 ? pageRegions : undefined,
    updatedAt: Date.now(),
  };
}
