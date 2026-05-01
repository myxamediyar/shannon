// Tools that historically ran server-only: network calls to third-party
// APIs (Perplexity for web_search, Google Docs for read_embed) and pure
// data lookups against the sidebar-notes the request shipped with.
//
// After Phase 2b, web_search and read_embed dispatch through ctx callbacks
// the client provides — they no longer reach for the legacy server-side
// runWebSearch (which couldn't be bundled into client code anyway because
// it imports node:fs through lib/providers/config). find_note and
// list_notes are pure data operations and stay here.

import type { ToolContext, ToolOutcome } from "./types";

export const SERVER_TOOL_NAMES = new Set([
  "web_search",
  "read_embed",
  "find_note",
  "list_notes",
]);

export async function executeServerTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  switch (name) {
    case "web_search":
      return webSearch(input, ctx);
    case "read_embed":
      return readEmbed(input, ctx);
    case "find_note":
      return findNote(input, ctx);
    case "list_notes":
      return listNotes(input, ctx);
    default:
      return { text: `Unknown server tool: ${name}` };
  }
}

async function webSearch(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  if (!ctx.webSearch) {
    return {
      text: "Web search is not available in this client. Phase 2c will wire up the client-side runWebSearch.",
    };
  }
  try {
    const { answer, citations } = await ctx.webSearch(input.query as string);
    return { text: answer, citations };
  } catch (e) {
    return { text: `Web search error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function readEmbed(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const { embed_url, title } = input as { embed_url: string; title: string };
  if (!ctx.readEmbed) {
    return {
      text: "Reading embeds is not available in this client. Phase 2c will wire up direct Google Docs export fetches via platformFetch.",
    };
  }
  try {
    const text = await ctx.readEmbed(embed_url, title);
    return { text };
  } catch (e) {
    return { text: `Error fetching document: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function findNote(input: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const { name: q } = input as { name: string };
  const qq = (q ?? "").toLowerCase().trim();
  const fmt = (n: { id: string; title: string }) => `  - id=${n.id} title="${n.title}"`;
  if (ctx.sidebarNotes.length === 0) {
    return { text: "The user has no other notes in their sidebar." };
  }
  const matches = qq ? ctx.sidebarNotes.filter((n) => n.title.toLowerCase().includes(qq)) : [];
  if (matches.length > 0) {
    return {
      text: `Matches for "${q}":\n${matches.map(fmt).join("\n")}\n\nCall read_note with one of these ids.`,
    };
  }
  return {
    text: `No notes matched "${q}". Total notes in sidebar: ${ctx.sidebarNotes.length}. Call list_notes (offset=0, up to 50 per page) to browse and find the closest title.`,
  };
}

function listNotes(input: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const { offset } = input as { offset?: number };
  const start = Math.max(0, Math.floor(offset ?? 0));
  const PAGE = 5;
  const total = ctx.sidebarNotes.length;
  const page = ctx.sidebarNotes.slice(start, start + PAGE);
  const fmt = (n: { id: string; title: string }) => `  - id=${n.id} title="${n.title}"`;
  if (total === 0) return { text: "The user has no other notes in their sidebar." };
  if (page.length === 0) return { text: `Offset ${start} is past the end. Total notes: ${total}.` };
  const end = start + page.length;
  const more =
    end < total
      ? `More notes available — call list_notes with offset=${end} to continue.`
      : `End of list.`;
  return { text: `Notes ${start}–${end - 1} of ${total}:\n${page.map(fmt).join("\n")}\n\n${more}` };
}

function embedUrlToExportUrl(embedUrl: string): string | null {
  try {
    const u = new URL(embedUrl);
    if (u.hostname !== "docs.google.com") return null;
    const parts = u.pathname.split("/");
    const dIdx = parts.indexOf("d");
    if (dIdx < 0 || dIdx + 1 >= parts.length) return null;
    const docId = parts[dIdx + 1];
    const docType = parts[1];
    if (docType === "document") {
      return `https://docs.google.com/document/d/${docId}/export?format=txt`;
    } else if (docType === "spreadsheets") {
      return `https://docs.google.com/spreadsheets/d/${docId}/export?format=csv`;
    } else if (docType === "presentation") {
      return `https://docs.google.com/presentation/d/${docId}/export?format=txt`;
    }
  } catch {
    /* invalid URL */
  }
  return null;
}
