// Server-only tools: everything here runs entirely inside the Node process —
// no browser participation, no round-trip to the client. Network calls to
// third-party APIs (Perplexity, Google Docs) live here, and so do the
// sidebar-notes queries that operate on data the client shipped with the
// chat request.

import { runWebSearch } from "@/lib/websearch";
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
      return webSearch(input);
    case "read_embed":
      return readEmbed(input);
    case "find_note":
      return findNote(input, ctx);
    case "list_notes":
      return listNotes(input, ctx);
    default:
      return { text: `Unknown server tool: ${name}` };
  }
}

async function webSearch(input: Record<string, unknown>): Promise<ToolOutcome> {
  try {
    const { answer, citations } = await runWebSearch(input.query as string);
    return { text: answer, citations };
  } catch (e) {
    return { text: `Web search error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function readEmbed(input: Record<string, unknown>): Promise<ToolOutcome> {
  const { embed_url, title } = input as { embed_url: string; title: string };
  const exportUrl = embedUrlToExportUrl(embed_url);
  if (!exportUrl) return { text: `Could not determine export URL for "${title}".` };
  try {
    const res = await fetch(exportUrl, { redirect: "follow" });
    if (!res.ok) {
      return {
        text: `Failed to fetch document: ${res.status} ${res.statusText}. Make sure the document is shared as "Anyone with the link".`,
      };
    }
    const text = await res.text();
    const trimmed = text.slice(0, 50000);
    return {
      text: `Content of "${title}":\n\n${trimmed}${text.length > 50000 ? "\n\n[...truncated]" : ""}`,
    };
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
