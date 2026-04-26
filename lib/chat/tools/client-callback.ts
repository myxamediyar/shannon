// Client-callback tools: the server asks the browser to perform work it can't
// do itself (DOM rendering, IndexedDB blob reads, reading other chats' local
// state) and awaits the result. Mechanism: register a Promise in the
// tool-callback registry, emit an SSE event with the callbackId, let the
// browser do its thing, then the browser POSTs the result to
// /api/chat/tool-callback which resolves the Promise.

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
  const callbackId = crypto.randomUUID();
  ctx.emit({ type: "rasterize_shapes", callbackId });
  const payload = await awaitCallback(callbackId, RASTERIZE_TIMEOUT_MS);
  if (!payload) return { text: "Rasterization timed out — the frontend did not respond." };
  try {
    const parsed = JSON.parse(payload) as { groups: { image: string; description: string }[] };
    if (parsed.groups.length === 0) {
      return {
        text:
          "No shape groups found — there are no overlapping or touching shapes/arrows on the canvas.",
      };
    }
    const images: ToolImage[] = [];
    const texts: string[] = [];
    for (const g of parsed.groups) {
      texts.push(g.description);
      if (g.image) images.push({ mediaType: "image/png", data: g.image, caption: g.description });
    }
    return { text: texts.join("\n"), images };
  } catch {
    return { text: "Failed to parse rasterization result from the frontend." };
  }
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
    // Tell the model exactly what was cut so it knows to call again for the rest
    // — the silent clamp used to make it think the PDF ended at page clampedEnd.
    textParts.push(
      `Note: requested pages ${start_page}-${end_page} exceed the ${MAX_PAGES_PER_CALL}-page-per-call limit. ` +
      `Returning pages ${start_page}-${clampedEnd}. ` +
      `Call read_pdf_pages again with start_page=${clampedEnd + 1}, end_page=${end_page} to read the remaining pages.`,
    );
  }
  for (let page = start_page; page <= clampedEnd; page++) {
    const callbackId = crypto.randomUUID();
    ctx.emit({ type: "read_pdf_page", callbackId, filename, page });
    const payload = await awaitCallback(callbackId, PDF_RENDER_TIMEOUT_MS);
    if (!payload) {
      textParts.push(`Page ${page}: Render timed out.`);
      continue;
    }
    try {
      const parsed = JSON.parse(payload) as { image?: string; error?: string };
      if (parsed.error) {
        textParts.push(`Page ${page}: ${parsed.error}`);
      } else if (parsed.image) {
        textParts.push(`Page ${page} of "${filename}"`);
        images.push({ mediaType: "image/png", data: parsed.image, caption: `Page ${page}` });
      }
    } catch {
      textParts.push(`Page ${page}: Failed to parse render result.`);
    }
  }
  return {
    text: textParts.length === 0 ? "No pages could be rendered." : textParts.join("\n"),
    images: images.length > 0 ? images : undefined,
  };
}

async function readNote(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const { note_id } = input as { note_id: string };
  const callbackId = crypto.randomUUID();
  ctx.emit({ type: "read_note", callbackId, noteId: note_id });
  const payload = await awaitCallback(callbackId, NOTE_READ_TIMEOUT_MS);
  return { text: payload || "Note could not be read (timed out or not found)." };
}

async function readCurrentNote(ctx: ToolContext): Promise<ToolOutcome> {
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
