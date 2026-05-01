// File-drop helpers: read a Blob, decode to an image/PDF, size it for the
// canvas, and hand the resulting element to the caller's `appendEl`.
//
// Heavy payloads go to IndexedDB (via putBlob) and are referenced by
// `blobId` on the element. `src` is kept in memory as a data URL so
// rendering, rasterization, and LLM serialization work unchanged; it's
// stripped at persist time.

import { dataUrlToBlob, putBlob } from "./canvas-blob-store";
import { MAX_IMAGE_DIM } from "./canvas-serialize";
import type { ImageEl, PdfEl } from "./canvas-types";

export interface PlaceBlobDeps {
  /** Latest cursor client-coords. Called each time so async onload callbacks see fresh values. */
  getCursorClientPos: () => { clientX: number; clientY: number };
  /** Convert client-coords to canvas-coords using current viewport/offset/scale. */
  toCanvasPoint: (pos: { clientX: number; clientY: number }) => { x: number; y: number };
  /** Append the resulting element to the canvas. */
  appendEl: (el: ImageEl | PdfEl) => void;
}

export interface PlaceImageDeps extends PlaceBlobDeps {
  /** Viewport element — used for display-size heuristic (pasted images cap at vp.width / 3). */
  viewport: HTMLDivElement | null;
}

/** Read an image blob, downscale, and place it on the canvas.
 *  If `atCanvas` is given, the image's top-left lands there; otherwise it centers on the cursor. */
export function placeImageBlob(
  blob: Blob,
  atCanvas: { x: number; y: number } | undefined,
  deps: PlaceImageDeps,
) {
  const reader = new FileReader();
  reader.onload = (ev) => {
    const src = ev.target?.result as string;
    const img = new window.Image();
    img.onload = () => {
      const vp = deps.viewport;
      if (!vp) return;
      const displayMaxW = Math.round(vp.clientWidth / 3);
      const ratio = img.height / img.width;
      const bigger = Math.max(img.width, img.height);
      const displayMax = bigger === img.width ? displayMaxW : Math.round(displayMaxW / ratio);
      const w = Math.min(displayMax, img.width);
      const h = Math.round(w * ratio);

      // Keep enough pixels for sharp HiDPI rendering, capped at MAX_IMAGE_DIM on the larger side.
      const dpr = window.devicePixelRatio || 1;
      const idealW = Math.max(w * dpr, 640);
      const largerSide = Math.max(img.width, img.height);
      const scale_ = Math.min(1, idealW / img.width, MAX_IMAGE_DIM / largerSide);
      const pw = Math.round(img.width * scale_);
      const ph = Math.round(img.height * scale_);
      const c = document.createElement("canvas");
      c.width = pw; c.height = ph;
      c.getContext("2d")!.drawImage(img, 0, 0, pw, ph);
      // JPEG has no alpha — any other format may, so re-encode as PNG to keep transparency.
      const isJpeg = /^data:image\/jpe?g[;,]/i.test(src);
      const compressed = isJpeg ? c.toDataURL("image/jpeg", 0.82) : c.toDataURL("image/png");

      let ix: number, iy: number;
      if (atCanvas) {
        ix = atCanvas.x;
        iy = atCanvas.y;
      } else {
        const cp = deps.toCanvasPoint(deps.getCursorClientPos());
        ix = cp.x - w / 2;
        iy = cp.y - h / 2;
      }
      // Persist the compressed bytes to IDB before appending; on reload we'll
      // hydrate `src` from the blob referenced by blobId. If the IDB write
      // fails we still append the element with its inline src so the user
      // doesn't lose the image — it just won't survive a reload.
      const compressedBlob = dataUrlToBlob(compressed);
      const blobId = compressedBlob ? crypto.randomUUID() : undefined;
      const finalize = () => {
        const newEl: ImageEl = { id: crypto.randomUUID(), type: "image", x: ix, y: iy, src: compressed, w, h, blobId };
        deps.appendEl(newEl);
      };
      if (compressedBlob && blobId) {
        putBlob(blobId, compressedBlob).then(finalize, finalize);
      } else {
        finalize();
      }
    };
    img.src = src;
  };
  reader.readAsDataURL(blob);
}

/** Read a PDF blob, resolve its page count via pdfjs-dist, and place as a pdf element. */
export function placePdfBlob(blob: Blob, filename: string, deps: PlaceBlobDeps) {
  const reader = new FileReader();
  reader.onload = async (ev) => {
    const src = ev.target?.result as string;
    // Decode to Uint8Array so pdfjs can parse it — and so we can probe page count.
    const raw = atob(src.split(",")[1]);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);

    let numPages = 1;
    try {
      const pdfjsLib = await import("pdfjs-dist");
      if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).toString();
      }
      const doc = await pdfjsLib.getDocument({ data: arr }).promise;
      numPages = doc.numPages;
    } catch {
      // fallback to 1
    }

    if (numPages > 50) {
      alert(`"${filename}" has ${numPages} pages. The AI can only read up to 50 pages per request — you'll need to ask about specific page ranges.`);
    }

    const cp = deps.toCanvasPoint(deps.getCursorClientPos());
    const w = 500;
    const h = 650;
    // Store the raw PDF bytes in IDB — a 50-page PDF easily exceeds localStorage alone.
    const pdfBlob = dataUrlToBlob(src);
    const blobId = pdfBlob ? crypto.randomUUID() : undefined;
    const finalize = () => {
      const newEl: PdfEl = {
        id: crypto.randomUUID(), type: "pdf",
        x: cp.x - w / 2, y: cp.y - h / 2,
        w, h, src, filename, numPages, blobId,
      };
      deps.appendEl(newEl);
    };
    if (pdfBlob && blobId) {
      putBlob(blobId, pdfBlob).then(finalize, finalize);
    } else {
      finalize();
    }
  };
  reader.readAsDataURL(blob);
}
