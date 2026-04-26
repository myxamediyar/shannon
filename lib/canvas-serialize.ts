// LLM-context preparation for canvas state. Pure functions with no React
// dependencies. Browser-only (uses <canvas>) but callable from any client
// code: chat stream handlers, AI tool callbacks, etc.

import type { ArrowEl, CanvasEl, ChatEl, DrawEl, ShapeEl } from "./canvas-types";

/** Cap the largest side of any image we send to the model. */
export const MAX_IMAGE_DIM = 4096;

/** Two DrawEls whose bboxes fall within this many px on either axis are rasterized together. */
export const DRAW_GROUP_PROXIMITY = 160;

export interface ImagePart { mediaType: string; data: string }

/** Downscale a data-URL image to fit within MAX_IMAGE_DIM. Returns base64 parts or null. */
export function downscaleDataUrl(src: string | undefined | null): ImagePart | null {
  if (!src) return null;
  const match = src.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const img = new Image();
  img.src = src;
  // Image is already loaded from a data URL (synchronous for data URIs)
  if (img.width === 0 || img.height === 0) return { mediaType: match[1], data: match[2] };
  if (img.width <= MAX_IMAGE_DIM && img.height <= MAX_IMAGE_DIM) return { mediaType: match[1], data: match[2] };
  const scale = Math.min(MAX_IMAGE_DIM / img.width, MAX_IMAGE_DIM / img.height);
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { mediaType: match[1], data: match[2] };
  ctx.drawImage(img, 0, 0, w, h);
  const out = canvas.toDataURL("image/png").match(/^data:([^;]+);base64,(.+)$/);
  return out ? { mediaType: out[1], data: out[2] } : { mediaType: match[1], data: match[2] };
}

export interface DrawCoords {
  coords: { x: number; y: number }[];
  minX: number; minY: number; maxX: number; maxY: number;
}

/** Parse a DrawEl's points into coordinate arrays and compute its bounding box. */
export function parseDrawCoords(el: DrawEl): DrawCoords | null {
  const parts = el.pts.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const coords = parts.map(p => { const [x, y] = p.split(",").map(Number); return { x, y }; });
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of coords) {
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
    minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x); maxY = Math.max(maxY, c.y);
  }
  if (!Number.isFinite(minX)) return null;
  return { coords, minX, minY, maxX, maxY };
}

/** Rasterize one or more DrawEls into a single base64 PNG. */
export function rasterizeDrawGroup(draws: DrawEl[]): ImagePart | null {
  const parsed = draws.map(parseDrawCoords).filter(Boolean) as DrawCoords[];
  if (parsed.length === 0) return null;
  let gMinX = Infinity, gMinY = Infinity, gMaxX = -Infinity, gMaxY = -Infinity;
  for (const p of parsed) {
    gMinX = Math.min(gMinX, p.minX); gMinY = Math.min(gMinY, p.minY);
    gMaxX = Math.max(gMaxX, p.maxX); gMaxY = Math.max(gMaxY, p.maxY);
  }
  const pad = 4;
  let w = Math.ceil(gMaxX - gMinX) + pad * 2;
  let h = Math.ceil(gMaxY - gMinY) + pad * 2;
  let scale = 1;
  if (w > MAX_IMAGE_DIM || h > MAX_IMAGE_DIM) {
    scale = Math.min(MAX_IMAGE_DIM / w, MAX_IMAGE_DIM / h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 2 * scale;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const p of parsed) {
    ctx.beginPath();
    for (let i = 0; i < p.coords.length; i++) {
      const x = (p.coords[i].x - gMinX + pad) * scale;
      const y = (p.coords[i].y - gMinY + pad) * scale;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const dataUrl = canvas.toDataURL("image/png");
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return { mediaType: m[1], data: m[2] };
}

/** Group nearby DrawEls by proximity and rasterize each group into a single image. */
export function rasterizeDrawEls(draws: DrawEl[]): { images: ImagePart[]; descriptions: string[] } {
  const items = draws.map(el => ({ el, bbox: parseDrawCoords(el) })).filter(it => it.bbox != null) as { el: DrawEl; bbox: DrawCoords }[];
  if (items.length === 0) return { images: [], descriptions: [] };

  // Union-find grouping by bounding box proximity
  const parent = items.map((_, i) => i);
  function find(i: number): number { return parent[i] === i ? i : (parent[i] = find(parent[i])); }
  function union(a: number, b: number) { parent[find(a)] = find(b); }

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i].bbox, b = items[j].bbox;
      const gapX = Math.max(0, Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX));
      const gapY = Math.max(0, Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY));
      if (gapX <= DRAW_GROUP_PROXIMITY && gapY <= DRAW_GROUP_PROXIMITY) {
        union(i, j);
      }
    }
  }

  // Collect groups and compute per-group bounding boxes
  const groupMap = new Map<number, { els: DrawEl[]; bboxes: DrawCoords[] }>();
  for (let i = 0; i < items.length; i++) {
    const root = find(i);
    if (!groupMap.has(root)) groupMap.set(root, { els: [], bboxes: [] });
    const g = groupMap.get(root)!;
    g.els.push(items[i].el);
    g.bboxes.push(items[i].bbox);
  }

  const images: ImagePart[] = [];
  const descriptions: string[] = [];
  for (const { els, bboxes } of groupMap.values()) {
    const img = rasterizeDrawGroup(els);
    if (img) {
      images.push(img);
      let gMinX = Infinity, gMinY = Infinity, gMaxX = -Infinity, gMaxY = -Infinity;
      for (const b of bboxes) {
        gMinX = Math.min(gMinX, b.minX); gMinY = Math.min(gMinY, b.minY);
        gMaxX = Math.max(gMaxX, b.maxX); gMaxY = Math.max(gMaxY, b.maxY);
      }
      const w = Math.round(gMaxX - gMinX);
      const h = Math.round(gMaxY - gMinY);
      descriptions.push(`[drawing @ (${Math.round(gMinX)},${Math.round(gMinY)}) ${w}x${h} — see attached image]`);
    }
  }
  return { images, descriptions };
}

export interface Bbox { minX: number; minY: number; maxX: number; maxY: number }

/** Get axis-aligned bounding box for a shape or arrow element. */
export function shapeArrowBbox(el: ShapeEl | ArrowEl): Bbox {
  if (el.type === "shape") return { minX: el.x, minY: el.y, maxX: el.x + el.w, maxY: el.y + el.h };
  return { minX: Math.min(el.x1, el.x2), minY: Math.min(el.y1, el.y2), maxX: Math.max(el.x1, el.x2), maxY: Math.max(el.y1, el.y2) };
}

/** Test if two bounding boxes overlap or touch. */
export function bboxesCollide(a: Bbox, b: Bbox): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** Group shapes and arrows by bounding-box collision (union-find), rasterize each group of 2+ elements. */
export function rasterizeShapeGroups(els: (ShapeEl | ArrowEl)[]): { images: ImagePart[]; descriptions: string[]; groupedIds: Set<string> } {
  if (els.length === 0) return { images: [], descriptions: [], groupedIds: new Set() };

  const items = els.map(el => ({ el, bbox: shapeArrowBbox(el) }));
  const parent = items.map((_, i) => i);
  function find(i: number): number { return parent[i] === i ? i : (parent[i] = find(parent[i])); }
  function union(a: number, b: number) { parent[find(a)] = find(b); }

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (bboxesCollide(items[i].bbox, items[j].bbox)) union(i, j);
    }
  }

  // Collect groups
  const groupMap = new Map<number, number[]>();
  for (let i = 0; i < items.length; i++) {
    const root = find(i);
    if (!groupMap.has(root)) groupMap.set(root, []);
    groupMap.get(root)!.push(i);
  }

  const images: ImagePart[] = [];
  const descriptions: string[] = [];
  const groupedIds = new Set<string>();

  for (const indices of groupMap.values()) {
    if (indices.length < 2) continue; // only rasterize groups of 2+
    // Mark all elements in this group
    for (const i of indices) groupedIds.add(items[i].el.id);

    // Compute group bounding box
    let gMinX = Infinity, gMinY = Infinity, gMaxX = -Infinity, gMaxY = -Infinity;
    for (const i of indices) {
      const b = items[i].bbox;
      gMinX = Math.min(gMinX, b.minX); gMinY = Math.min(gMinY, b.minY);
      gMaxX = Math.max(gMaxX, b.maxX); gMaxY = Math.max(gMaxY, b.maxY);
    }

    const pad = 8;
    const canvasW = (gMaxX - gMinX) + pad * 2;
    const canvasH = (gMaxY - gMinY) + pad * 2;
    let scale = 1;
    if (canvasW > MAX_IMAGE_DIM || canvasH > MAX_IMAGE_DIM) {
      scale = Math.min(MAX_IMAGE_DIM / canvasW, MAX_IMAGE_DIM / canvasH);
    }
    const w = Math.round(canvasW * scale);
    const h = Math.round(canvasH * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;

    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 2 * scale;
    ctx.lineCap = "round";

    for (const i of indices) {
      const el = items[i].el;
      if (el.type === "shape") {
        const sx = (el.x - gMinX + pad) * scale;
        const sy = (el.y - gMinY + pad) * scale;
        const sw = el.w * scale;
        const sh = el.h * scale;
        if (el.shape === "rect") {
          ctx.strokeRect(sx, sy, sw, sh);
        } else if (el.shape === "circle") {
          ctx.beginPath();
          ctx.ellipse(sx + sw / 2, sy + sh / 2, sw / 2, sh / 2, 0, 0, Math.PI * 2);
          ctx.stroke();
        } else if (el.shape === "triangle") {
          ctx.beginPath();
          ctx.moveTo(sx + sw / 2, sy);
          ctx.lineTo(sx + sw, sy + sh);
          ctx.lineTo(sx, sy + sh);
          ctx.closePath();
          ctx.stroke();
        }
      } else {
        const ax1 = (el.x1 - gMinX + pad) * scale;
        const ay1 = (el.y1 - gMinY + pad) * scale;
        const ax2 = (el.x2 - gMinX + pad) * scale;
        const ay2 = (el.y2 - gMinY + pad) * scale;
        ctx.beginPath();
        ctx.moveTo(ax1, ay1);
        ctx.lineTo(ax2, ay2);
        ctx.stroke();
        // Arrowhead
        const angle = Math.atan2(ay2 - ay1, ax2 - ax1);
        const headLen = 12 * scale;
        ctx.beginPath();
        ctx.moveTo(ax2, ay2);
        ctx.lineTo(ax2 - headLen * Math.cos(angle - Math.PI / 6), ay2 - headLen * Math.sin(angle - Math.PI / 6));
        ctx.moveTo(ax2, ay2);
        ctx.lineTo(ax2 - headLen * Math.cos(angle + Math.PI / 6), ay2 - headLen * Math.sin(angle + Math.PI / 6));
        ctx.stroke();
      }
    }

    const dataUrl = canvas.toDataURL("image/png");
    const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (m) {
      images.push({ mediaType: m[1], data: m[2] });
      const rw = Math.round(gMaxX - gMinX);
      const rh = Math.round(gMaxY - gMinY);
      descriptions.push(`[shape group @ (${Math.round(gMinX)},${-Math.round(gMinY)}) ${rw}x${rh} — ${indices.length} elements — see attached image]`);
    }
  }

  return { images, descriptions, groupedIds };
}

/** Serialize visible elements (excluding the requesting chat) into text + collected images. */
export function serializeElements(els: CanvasEl[], selfChat?: ChatEl): { text: string; images: ImagePart[] } {
  const images: ImagePart[] = [];

  // Include a self-position line so the AI knows where its chat sits relative to other elements
  const selfLabel = selfChat?.ephemeral ? "self (ephemeral chat)" : "self (this chat)";
  const selfLine = selfChat ? `[${selfLabel} @ (${selfChat.x},${selfChat.y})]` : null;

  if (els.length === 0) return { text: selfLine ? `${selfLine}\nNo other elements.` : "No elements.", images: [] };

  // Collect and group draw elements, rasterize each group as one image
  const drawEls = els.filter((el): el is DrawEl => el.type === "draw");
  const drawResult = drawEls.length > 0 ? rasterizeDrawEls(drawEls) : { images: [], descriptions: [] };
  images.push(...drawResult.images);

  const textParts: string[] = selfLine ? [selfLine, ...drawResult.descriptions] : drawResult.descriptions;
  // Coordinates use canvas-native orientation: smaller y = up, larger y = down.
  for (const el of els) {
    switch (el.type) {
      case "text":   textParts.push(`[text @ (${el.x},${el.y})]: "${el.text}"`); break;
      case "math":   textParts.push(`[math @ (${el.x},${el.y})]: "${el.latex}"`); break;
      case "shape": {
        const x1 = el.x, x2 = el.x + el.w;
        const yTop = el.y, yBot = el.y + el.h;
        const cx = Math.round(el.x + el.w / 2);
        const cy = Math.round(el.y + el.h / 2);
        textParts.push(`[shape @ (${x1},${yTop}) ${el.shape} ${el.w}x${el.h} | TL(${x1},${yTop}) TR(${x2},${yTop}) BR(${x2},${yBot}) BL(${x1},${yBot}) | center(${cx},${cy})]`);
        break;
      }
      case "image": {
        const imgData = downscaleDataUrl(el.src);
        if (imgData) images.push(imgData);
        textParts.push(`[image @ (${el.x},${el.y}) ${el.w}x${el.h}]`); break;
      }
      case "draw":   break; // handled above via rasterizeDrawEls
      case "arrow":  textParts.push(`[arrow from (${el.x1},${el.y1}) to (${el.x2},${el.y2})]`); break;
      case "chart":  textParts.push(`[chart @ (${el.x},${el.y})]: ${el.chartType} — labels: ${el.labels.join(", ")}${el.description ? ` — ${el.description}` : ""}${el.formula ? ` (${el.formula})` : ""}`); break;
      case "chat": {
        const label = el.ephemeral ? "ephemeral chat" : `chat #${el.chatNumber}`;
        textParts.push(`[${label} @ (${el.x},${el.y})]: ${el.messages.length} messages`);
        break;
      }
      case "noteRef": textParts.push(`[note link @ (${el.x},${el.y})]: target=${el.targetNoteId}`); break;
      case "graph":  textParts.push(`[graph ${el.graphNum} @ (${el.x},${el.y})]${el.expressions?.length ? `: ${el.expressions.join(", ")}` : " empty"}`); break;
      case "pdf":    textParts.push(`[pdf @ (${el.x},${el.y})]: ${el.filename} (${el.numPages} pages)`); break;
      case "embed":  textParts.push(`[embed @ (${el.x},${el.y})]: ${el.title} (${el.provider}) url=${el.embedUrl}`); break;
      case "table": {
        const stripTags = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").trim();
        const rowsCount = el.cells.length;
        const colsCount = el.cells[0]?.length ?? 0;
        const header = el.cells[0]?.map((c) => stripTags(c.html)).join(" | ") ?? "";
        textParts.push(`[table @ (${el.x},${el.y}) ${el.w}x${el.h}]: ${rowsCount}×${colsCount}${rowsCount > 0 ? ` — header: ${header}` : ""}`);
        break;
      }
    }
  }
  const text = textParts.join("\n");
  return { text, images };
}
