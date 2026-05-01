// Tools that need browser-side work (DOM rendering, IndexedDB, localStorage,
// canvas state). The consumer (NotesCanvas) supplies the implementations
// via ctx — they run synchronously inside the same client-side process.

import type { ToolContext, ToolOutcome, ToolImage } from "./types";

export const CLIENT_CALLBACK_TOOL_NAMES = new Set([
  "rasterize_shapes",
  "read_pdf_pages",
  "read_note",
  "read_current_note",
  "read_chat",
]);

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

async function rasterizeShapes(ctx: ToolContext): Promise<ToolOutcome> {
  if (!ctx.rasterizeShapes) {
    return { text: "rasterize_shapes is not available — consumer did not provide ctx.rasterizeShapes." };
  }
  try {
    const { groups } = await ctx.rasterizeShapes();
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
  } catch (e) {
    return { text: `Rasterization failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function readPdfPages(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  if (!ctx.readPdfPage) {
    return { text: "read_pdf_pages is not available — consumer did not provide ctx.readPdfPage." };
  }
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
    let result: { image?: string; error?: string };
    try {
      result = await ctx.readPdfPage(filename, page);
    } catch (e) {
      result = { error: `Failed to render page: ${e instanceof Error ? e.message : String(e)}` };
    }
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

async function readNote(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  if (!ctx.readNote) {
    return { text: "read_note is not available — consumer did not provide ctx.readNote." };
  }
  const { note_id } = input as { note_id: string };
  try {
    return { text: await ctx.readNote(note_id) };
  } catch (e) {
    return { text: `Error reading note: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function readCurrentNote(ctx: ToolContext): Promise<ToolOutcome> {
  if (!ctx.readCurrentNote) {
    return { text: "read_current_note is not available — consumer did not provide ctx.readCurrentNote." };
  }
  try {
    return { text: await ctx.readCurrentNote() };
  } catch (e) {
    return { text: `Error reading current note: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function readChat(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  if (!ctx.readChat) {
    return { text: "read_chat is not available — consumer did not provide ctx.readChat." };
  }
  const { chat_number, offset, count } = input as {
    chat_number: number;
    offset?: number;
    count?: number;
  };
  const reqOffset = Math.max(0, Math.floor(offset ?? 0));
  const reqCount = Math.max(1, Math.min(10, Math.floor(count ?? 10)));
  try {
    return { text: await ctx.readChat(chat_number, reqOffset, reqCount) };
  } catch (e) {
    return { text: `Error reading chat: ${e instanceof Error ? e.message : String(e)}` };
  }
}
