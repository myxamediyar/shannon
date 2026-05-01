// Parsers for third-party URLs the user pastes onto the canvas.

import type { EmbedEl } from "./canvas-types";

export type ParsedEmbed = {
  embedUrl: string;
  title: string;
  provider: EmbedEl["provider"];
  /** Suggested element size — provider-appropriate aspect (e.g. 16:9 for video). */
  w: number;
  h: number;
};

const GOOGLE_DOC_W = 600;
const GOOGLE_DOC_H = 400;
const YOUTUBE_W = 640;
const YOUTUBE_H = 360; // 16:9

/** Recognize a third-party URL we know how to embed. Returns provider, embed URL, default size, or null. */
export function parseEmbedUrl(url: string): ParsedEmbed | null {
  return parseGoogleEmbedUrl(url) ?? parseYoutubeEmbedUrl(url);
}

/** Google Docs / Sheets / Slides URL → embeddable URL + metadata, or null if not recognized. */
export function parseGoogleEmbedUrl(url: string): ParsedEmbed | null {
  try {
    const u = new URL(url);
    if (u.hostname !== "docs.google.com") return null;
    const parts = u.pathname.split("/");
    // Pattern: /document/d/{ID}/..., /spreadsheets/d/{ID}/..., /presentation/d/{ID}/...
    const dIdx = parts.indexOf("d");
    if (dIdx < 0 || dIdx + 1 >= parts.length) return null;
    const docId = parts[dIdx + 1];
    const docType = parts[1];
    if (docType === "document") {
      return { embedUrl: `https://docs.google.com/document/d/${docId}/preview`, title: "Google Doc", provider: "google-docs", w: GOOGLE_DOC_W, h: GOOGLE_DOC_H };
    } else if (docType === "spreadsheets") {
      return { embedUrl: `https://docs.google.com/spreadsheets/d/${docId}/preview`, title: "Google Sheet", provider: "google-sheets", w: GOOGLE_DOC_W, h: GOOGLE_DOC_H };
    } else if (docType === "presentation") {
      return { embedUrl: `https://docs.google.com/presentation/d/${docId}/embed`, title: "Google Slides", provider: "google-slides", w: GOOGLE_DOC_W, h: GOOGLE_DOC_H };
    }
  } catch {
    // not a valid URL
  }
  return null;
}

/** YouTube URL (watch / youtu.be / shorts / embed) → embeddable URL, or null.
 *  In Tauri the player will throw "Error 153 video player configuration error"
 *  because tauri://localhost can't produce a valid HTTP Referer (tracked in
 *  tauri-apps/tauri#14422). We embed it anyway — the failure is graceful and
 *  the embed works fine in the web/npm build. */
export function parseYoutubeEmbedUrl(url: string): ParsedEmbed | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\.|^m\./, "");
    let videoId: string | null = null;
    if (host === "youtu.be") {
      videoId = u.pathname.slice(1).split("/")[0] || null;
    } else if (host === "youtube.com") {
      if (u.pathname === "/watch") {
        videoId = u.searchParams.get("v");
      } else {
        const m = u.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/);
        if (m) videoId = m[1];
      }
    }
    if (!videoId || !/^[A-Za-z0-9_-]{6,}$/.test(videoId)) return null;
    return {
      // youtube-nocookie.com (privacy-enhanced embed) — its player accepts
      // tauri://localhost as an embed origin; the regular youtube.com player
      // rejects it with "Error 153 video player configuration error".
      embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`,
      title: "YouTube",
      provider: "youtube",
      w: YOUTUBE_W,
      h: YOUTUBE_H,
    };
  } catch {
    return null;
  }
}
