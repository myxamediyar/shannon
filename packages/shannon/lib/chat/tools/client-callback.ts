// Tools that need browser-side work (DOM rendering, IndexedDB, localStorage,
// canvas state). Two execution modes:
//
//   1. Direct (preferred): when ctx supplies the callback functions
//      (rasterizeShapes, readPdfPage, etc.), we call them synchronously in
//      the same client-side process. This is the new path used by the SPA's
//      streamChat generator.
//
//   2. SSE-callback dance (legacy fallback): when ctx doesn't supply the
//      callbacks (i.e. we're running inside the legacy server-side
//      /api/chat route), emit an SSE event with a callbackId and await the
//      browser's POST to /api/chat/tool-callback. Will be removed in
//      Phase 2c when the legacy route is deleted.
//
// The dual-path keeps the legacy server route working while the migration
// is in progress.

import { registerCallback } from "@/lib/tool-callbacks";
import type { ToolContext, ToolOutcome, ToolImage } from "./types";

export const CLIENT_CALLBACK_TOOL_NAMES = new Set([
  "rasterize_shapes",
  "read_pdf_pages",
  "read_note",
  "read_current_note",
  "read_chat",
]);

const RASTERIZE_TIMEOUT_MS = 10_000;
const PDF_RENDER_TIMEOUT_MS = 15_000;
const NOTE_READ_TIMEOUT_MS = 10_000;

export async function executeClientCallbackTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  switch (name) {
    case "rasterize_shapes":
      return rasterizeShapes(ctx);
    case "read_pdf_pages":
      return readPdfPages(input, ctx);
    case "read_note":
      return readNote(input, ctx);
    case "read_current_note":
      return readCurrentNote(ctx);
    case "read_chat":
      return readChat(input, ctx);
    default:
      return { text: `Unknown client-callback tool: ${name}` };
  }
}

async function awaitCallback(callbackId: string, timeoutMs: number): Promise<string> {
  return Promise.race([
    registerCallback(callbackId),
    new Promise<string>((resolve) => setTimeout(() => resolve(""), timeoutMs)),
  ]);
}

async function rasterizeShapes(ctx: ToolContext): Promise<ToolOutcome> {
  if (ctx.rasterizeShapes) {
    try {
      const { groups } = await ctx.rasterizeShapes();
      return formatRasterizeOutcome(groups);
    } catch (e) {
      return { text: `Rasterization failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  // Legacy SSE-callback path
  const callbackId = crypto.randomUUID();
  ctx.emit({ type: "rasterize_shapes", callbackId });
  const payload = await awaitCallback(callbackId, RASTERIZE_TIMEOUT_MS);
  if (!payload) return { text: "Rasterization timed out — the frontend did not respond." };
  try {
    const parsed = JSON.parse(payload) as { groups: { image: string; description: string }[] };
    return formatRasterizeOutcome(parsed.groups);
  } catch {
    return { text: "Failed to parse rasterization result from the frontend." };
  }
}

function formatRasterizeOutcome(
  groups: { image: string; description: string }[],
): ToolOutcome {
  if (groups.length === 0) {
    return {
      text:
        "No shape groups found — there are no overlapping or touching shapes/arrows on the canvas.",
    };
  }
  const images: ToolImage[] = [];
  const texts: string[] = [];
  for (const g of groups) {
    texts.push(g.description);
    if (g.image) images.push({ mediaType: "image/png", data: g.image, caption: g.description });
  }
  return { text: texts.join("\n"), images };
}

async function readPdfPages(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const { filename, start_page, end_page } = input as {
    filename: string;
    start_page: number;
    end_page: number;
  };
  const MAX_PAGES_PER_CALL = 50;
  const clampedEnd = Math.min(end_page, start_page + MAX_PAGES_PER_CALL - 1);
  const wasClipped = clampedEnd < end_page;
  const images: ToolImage[] = [];
  const textParts: string[] = [];
  if (wasClipped) {
    textParts.push(
      `Note: requested pages ${start_page}-${end_page} exceed the ${MAX_PAGES_PER_CALL}-page-per-call limit. ` +
      `Returning pages ${start_page}-${clampedEnd}. ` +
      `Call read_pdf_pages again with start_page=${clampedEnd + 1}, end_page=${end_page} to read the remaining pages.`,
    );
  }
  for (let page = start_page; page <= clampedEnd; page++) {
    const result = await renderPdfPage(filename, page, ctx);
    if (result.error) {
      textParts.push(`Page ${page}: ${result.error}`);
    } else if (result.image) {
      textParts.push(`Page ${page} of "${filename}"`);
      images.push({ mediaType: "image/png", data: result.image, caption: `Page ${page}` });
    } else {
      textParts.push(`Page ${page}: Render returned no result.`);
    }
  }
  return {
    text: textParts.length === 0 ? "No pages could be rendered." : textParts.join("\n"),
    images: images.length > 0 ? images : undefined,
  };
}

async function renderPdfPage(
  filename: string,
  page: number,
  ctx: ToolContext,
): Promise<{ image?: string; error?: string }> {
  if (ctx.readPdfPage) {
    try {
      return await ctx.readPdfPage(filename, page);
    } catch (e) {
      return { error: `Failed to render page: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  const callbackId = crypto.randomUUID();
  ctx.emit({ type: "read_pdf_page", callbackId, filename, page });
  const payload = await awaitCallback(callbackId, PDF_RENDER_TIMEOUT_MS);
  if (!payload) return { error: "Render timed out." };
  try {
    return JSON.parse(payload) as { image?: string; error?: string };
  } catch {
    return { error: "Failed to parse render result." };
  }
}

async function readNote(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const { note_id } = input as { note_id: string };
  if (ctx.readNote) {
    try {
      return { text: await ctx.readNote(note_id) };
    } catch (e) {
      return { text: `Error reading note: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  const callbackId = crypto.randomUUID();
  ctx.emit({ type: "read_note", callbackId, noteId: note_id });
  const payload = await awaitCallback(callbackId, NOTE_READ_TIMEOUT_MS);
  return { text: payload || "Note could not be read (timed out or not found)." };
}

async function readCurrentNote(ctx: ToolContext): Promise<ToolOutcome> {
  if (ctx.readCurrentNote) {
    try {
      return { text: await ctx.readCurrentNote() };
    } catch (e) {
      return { text: `Error reading current note: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  const callbackId = crypto.randomUUID();
  ctx.emit({ type: "read_current_note", callbackId });
  const payload = await awaitCallback(callbackId, NOTE_READ_TIMEOUT_MS);
  return { text: payload || "Current note could not be read (timed out)." };
}

async function readChat(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const { chat_number, offset, count } = input as {
    chat_number: number;
    offset?: number;
    count?: number;
  };
  const reqOffset = Math.max(0, Math.floor(offset ?? 0));
  const reqCount = Math.max(1, Math.min(10, Math.floor(count ?? 10)));
  if (ctx.readChat) {
    try {
      return { text: await ctx.readChat(chat_number, reqOffset, reqCount) };
    } catch (e) {
      return { text: `Error reading chat: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  const callbackId = crypto.randomUUID();
  ctx.emit({
    type: "read_chat",
    callbackId,
    chatNumber: chat_number,
    offset: reqOffset,
    count: reqCount,
  });
  const payload = await awaitCallback(callbackId, NOTE_READ_TIMEOUT_MS);
  return { text: payload || "Chat could not be read (timed out or not found)." };
}
