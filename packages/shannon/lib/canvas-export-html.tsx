// HTML export. Clones the live canvas world DOM, rasterizes live <canvas>
// bitmaps to <img> (same pattern as canvas-print.ts), replaces each chat with
// a static full-history version that sidesteps ChatContainer's lazy render
// window, inlines same-origin stylesheets, and emits a single self-contained
// .html file. Browser-native zoom + overflow:auto provide all interactivity.

import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkMark } from "remark-mark-highlight";

import {
  CHAT_CONTAINER_WIDTH,
  CHAT_INDICATOR_MARGIN,
  TEXT_BASE_FONT_PX,
} from "./canvas-types";
import type { CanvasEl, ChatEl, NoteItem } from "./canvas-types";
import {
  chatElContentWidth,
  chatElViewportHeight,
  chatLineHeight,
} from "./canvas-utils";

// ── HTML escaping ────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Content bbox ─────────────────────────────────────────────────────────────

type Bbox = { x: number; y: number; w: number; h: number };

const EXPORT_MARGIN = 40;

/** Parse the `scale(s)` factor from the world's transform. Needed because
 *  every child rect we read is in viewport pixels post-transform. */
function readWorldScale(world: HTMLElement): number {
  const m = /scale\(\s*([\d.]+)\s*\)/.exec(world.style.transform || "");
  return m ? parseFloat(m[1]) : 1;
}

/** Measure the tight content bbox directly from the live DOM. Gives
 *  pixel-exact bounds regardless of what `note.elements` reports (which can
 *  diverge from rendered size for text/math/chat with stale measurements). */
function measureContentBbox(world: HTMLElement): Bbox {
  const scale = readWorldScale(world) || 1;
  const worldRect = world.getBoundingClientRect();
  const nodes = world.querySelectorAll<Element>(
    "[data-el-id], [data-chat-container], [data-page-region-id]",
  );

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of Array.from(nodes)) {
    const r = node.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const x = (r.left - worldRect.left) / scale;
    const y = (r.top - worldRect.top) / scale;
    const w = r.width / scale;
    const h = r.height / scale;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  }

  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 800, h: 600 };
  return {
    x: minX - EXPORT_MARGIN,
    y: minY - EXPORT_MARGIN,
    w: (maxX - minX) + EXPORT_MARGIN * 2,
    h: (maxY - minY) + EXPORT_MARGIN * 2,
  };
}

// ── Static chat renderer ─────────────────────────────────────────────────────

function StaticChatMessages({ chatEl }: { chatEl: ChatEl }) {
  const LINE_H = chatLineHeight();
  const FONT_SIZE = TEXT_BASE_FONT_PX;
  return (
    <div
      style={{
        paddingLeft: CHAT_INDICATOR_MARGIN,
        paddingTop: LINE_H,
        fontSize: `${FONT_SIZE}px`,
        lineHeight: `${LINE_H}px`,
        fontFamily: "Lexend Deca, sans-serif",
        color: "var(--th-text)",
      }}
    >
      {chatEl.messages.map((msg, idx) => (
        <div key={idx} style={{ position: "relative", userSelect: "text" }}>
          <span
            style={{
              position: "absolute",
              right: "100%",
              top: 0,
              marginRight: 6,
              lineHeight: `${LINE_H}px`,
              fontSize: `${FONT_SIZE}px`,
              color: msg.role === "user" ? "#f78cb3" : "#22d3ee",
              fontFamily: "Lexend Deca, sans-serif",
              whiteSpace: "nowrap",
            }}
          >
            &gt;
          </span>
          {msg.role === "assistant" ? (
            <div
              className="chat-markdown"
              style={{ wordBreak: "break-word", overflowWrap: "break-word" }}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkMark]}>
                {msg.content === "\u2026" ? "" : msg.content}
              </ReactMarkdown>
            </div>
          ) : (
            <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {msg.content}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function buildStaticChatHtml(chatEl: ChatEl): string {
  const LINE_H = chatLineHeight();
  const FONT_SIZE = TEXT_BASE_FONT_PX;
  const viewportH = chatElViewportHeight(chatEl);
  const contentW = chatElContentWidth(chatEl);
  const totalW = contentW + CHAT_INDICATOR_MARGIN;

  const messagesHtml = renderToStaticMarkup(<StaticChatMessages chatEl={chatEl} />);

  const headerLabel = chatEl.ephemeral ? "ephemeral" : `${chatEl.chatNumber}`;
  const anyTokens =
    chatEl.inputTokens || chatEl.outputTokens || chatEl.cacheReadTokens || chatEl.tokenCount || chatEl.contextWindow;
  const fmtTok = (v: number | null | undefined) =>
    v != null && v > 0 ? v.toLocaleString() : "—";
  const fmtCtx = (v: number | null | undefined) => {
    if (v == null) return "—";
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000) return `${Math.round(v / 1_000)}K`;
    return v.toString();
  };
  const ctxDisplay =
    chatEl.lastTurnInputTokens && chatEl.contextWindow
      ? `${fmtCtx(chatEl.lastTurnInputTokens)} : ${fmtCtx(chatEl.contextWindow)}`
      : chatEl.lastTurnInputTokens
        ? fmtCtx(chatEl.lastTurnInputTokens)
        : `— : ${fmtCtx(chatEl.contextWindow)}`;
  const tokenLine = anyTokens
    ? `${fmtTok(chatEl.inputTokens)} in / ${fmtTok(chatEl.cacheReadTokens)} cached / ${fmtTok(chatEl.outputTokens)} out / ${ctxDisplay} ctx`
    : "";

  const headerHtml = `<div style="position:absolute; top:${-LINE_H * 0.6}px; left:0; width:100%; padding-left:${CHAT_INDICATOR_MARGIN}px; font-size:${FONT_SIZE * 0.55}px; line-height:${LINE_H * 0.6}px; font-family:'Lexend Deca',sans-serif; color:var(--th-text); opacity:0.45; display:flex; gap:8px; pointer-events:none; user-select:none;"><span>#${escapeHtml(headerLabel)}</span>${tokenLine ? `<span>${escapeHtml(tokenLine)}</span>` : ""}</div>`;

  return `<div data-chat-container data-el-id="${escapeHtml(chatEl.id)}" style="position:absolute; left:${chatEl.x - CHAT_INDICATOR_MARGIN}px; top:${chatEl.y}px; width:${totalW}px; height:${viewportH}px; overflow:visible;">${headerHtml}<div style="width:100%; height:${viewportH}px; overflow-y:auto; overflow-x:hidden; scrollbar-width:thin;">${messagesHtml}</div></div>`;
}

// ── Stylesheet collection ────────────────────────────────────────────────────

function collectSameOriginCss(): string {
  const parts: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    if (!rules) continue;
    for (const rule of Array.from(rules)) {
      parts.push(rule.cssText);
    }
  }
  return parts.join("\n");
}

function collectExternalLinks(): string {
  const hrefs = new Set<string>();

  for (const link of Array.from(document.querySelectorAll<HTMLLinkElement>("link[rel='stylesheet']"))) {
    if (!link.href) continue;
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(link.href)) {
      hrefs.add(link.href);
    }
  }

  // Cross-origin stylesheets whose rules we couldn't read — copy the link
  // verbatim so the exported page still loads them over the network.
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      void sheet.cssRules;
      continue;
    } catch {
      const href = sheet.href;
      if (href) hrefs.add(href);
    }
  }

  return Array.from(hrefs)
    .map(h => `<link rel="stylesheet" href="${escapeHtml(h)}">`)
    .join("\n");
}

// ── Canvas rasterization ─────────────────────────────────────────────────────

/** Strip editor-only attributes the cloned DOM shouldn't carry into a static
 *  export: contenteditable (Tiptap), spellcheck, draggable. Without this, the
 *  exported page has live ProseMirror divs the reader can edit. */
function makeStatic(clone: HTMLElement) {
  const editables = clone.querySelectorAll<HTMLElement>("[contenteditable]");
  for (const node of Array.from(editables)) {
    node.removeAttribute("contenteditable");
    node.removeAttribute("spellcheck");
    node.removeAttribute("draggable");
    // ProseMirror leaves a tabindex=0 on its root so it's keyboard-focusable.
    // In a static export it just makes the read-only div tab-focusable for no
    // reason. Drop it.
    if (node.getAttribute("tabindex") === "0") node.removeAttribute("tabindex");
  }
}

function rasterizeCanvases(live: HTMLElement, clone: HTMLElement) {
  const srcList = live.querySelectorAll("canvas");
  const dstList = clone.querySelectorAll("canvas");
  srcList.forEach((src, i) => {
    const dst = dstList[i];
    if (!dst) return;
    try {
      const srcCv = src as HTMLCanvasElement;
      const img = document.createElement("img");
      img.src = srcCv.toDataURL("image/png");
      img.setAttribute("style", dst.getAttribute("style") ?? "");
      img.width = srcCv.width;
      img.height = srcCv.height;
      dst.replaceWith(img);
    } catch {
      // Tainted (cross-origin) canvas — leave the blank cloned canvas in place
    }
  });
}

// ── Chat replacement ─────────────────────────────────────────────────────────

function replaceChats(clone: HTMLElement, elements: CanvasEl[]) {
  for (const el of elements) {
    if (el.type !== "chat") continue;
    const dst = clone.querySelector<HTMLElement>(
      `[data-chat-container][data-el-id="${CSS.escape(el.id)}"]`,
    );
    if (!dst) continue;
    const temp = document.createElement("div");
    temp.innerHTML = buildStaticChatHtml(el);
    const replacement = temp.firstElementChild;
    if (replacement) dst.replaceWith(replacement);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface ExportHtmlOpts {
  /** Reserved for a future pass that re-renders draws into SVG for crisper zoom. */
  drawsAsSvg?: boolean;
}

export async function exportNoteAsHtml(
  world: HTMLElement,
  note: NoteItem,
  _opts: ExportHtmlOpts = {},
): Promise<Blob> {
  const clone = world.cloneNode(true) as HTMLElement;

  rasterizeCanvases(world, clone);
  replaceChats(clone, note.elements ?? []);
  makeStatic(clone);

  clone.style.transform = "none";
  clone.style.position = "absolute";
  clone.style.top = "0";
  clone.style.left = "0";

  const bbox = measureContentBbox(world);
  const css = collectSameOriginCss();
  const externalLinks = collectExternalLinks();
  const title = escapeHtml(note.title || "Untitled");

  const themeClass = typeof document !== "undefined"
    ? (document.documentElement.classList.contains("light") ? "light" : "dark")
    : "dark";

  // The next/font-generated CSS variables (--font-lexend, --font-material-
  // symbols) point to obfuscated family names ("__variable_HASH") that map
  // to /_next/static/media/*.woff2 — URLs that don't resolve in a standalone
  // HTML file. Crucially, when var(--font-foo) is *defined* but the font
  // fails to load, the browser stays with the broken family rather than
  // falling through to the next entry in font-family. Override both vars to
  // the actual Google-served family names so the CDN @font-face rules apply.
  const resetStyles = `
    :root {
      --font-lexend: 'Lexend Deca';
      --font-material-symbols: 'Material Symbols Outlined';
    }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: var(--font-lexend), sans-serif;
      background: var(--th-bg, #0e0e0e);
      color: var(--th-text, #e5e5e5);
      min-height: 100vh;
      min-width: fit-content;
    }
    textarea, input { display: none !important; }
    .shannon-export-root {
      position: relative;
      width: ${bbox.w}px;
      height: ${bbox.h}px;
      margin: 0 auto;
    }
    .shannon-export-world {
      position: absolute;
      top: 0;
      left: 0;
      transform: translate(${-bbox.x}px, ${-bbox.y}px);
      transform-origin: 0 0;
    }
  `;

  // Self-hosted next/font URLs and webpack-bundled CSS font URLs aren't
  // reachable from the exported standalone file, so re-source the same
  // fonts/styles from public CDNs:
  //  * Lexend Deca: text font, was already linked.
  //  * Material Symbols Outlined: icon font (e.g. the checklist check).
  //  * KaTeX: math equation styling + glyph fonts.
  // Inline styles in this file deliberately use literal family names to
  // match these @font-face declarations.
  const exportFontLink = `
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lexend+Deca:wght@100..900&display=swap">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
`;

  const html = `<!doctype html>
<html lang="en" class="${themeClass}">
<head>
<meta charset="utf-8">
<title>${title}</title>
${exportFontLink}
${externalLinks}
<style>${resetStyles}</style>
<style>${css}</style>
</head>
<body>
<div class="shannon-export-root">
<div class="shannon-export-world">
${clone.outerHTML}
</div>
</div>
</body>
</html>`;

  return new Blob([html], { type: "text/html" });
}
