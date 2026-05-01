// Client-side Google Docs/Sheets/Slides export fetcher. Used by the
// read_embed tool — the model passes the embed URL, we derive the export
// URL, fetch it via platformFetch, and return the text. Mirrors the
// previous lib/chat/tools/server.ts logic but bundleable into client code.

import { platformFetch } from "@/lib/platform/http";

const MAX_TEXT_LENGTH = 50_000;

export async function readEmbedClient(
  embedUrl: string,
  title: string,
): Promise<string> {
  const exportUrl = embedUrlToExportUrl(embedUrl);
  if (!exportUrl) {
    return `Could not determine export URL for "${title}".`;
  }
  const res = await platformFetch(exportUrl, { redirect: "follow" });
  if (!res.ok) {
    return `Failed to fetch document: ${res.status} ${res.statusText}. Make sure the document is shared as "Anyone with the link".`;
  }
  const text = await res.text();
  const trimmed = text.slice(0, MAX_TEXT_LENGTH);
  return `Content of "${title}":\n\n${trimmed}${text.length > MAX_TEXT_LENGTH ? "\n\n[...truncated]" : ""}`;
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
