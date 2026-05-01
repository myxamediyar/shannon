// Print one page region. Two paths:
//
//   * Browser (printViaIframe): spin up an offscreen iframe with its own
//     document, mount only the cloned region into it, call iframe.print().
//     Browsers print the iframe's document, not the host's.
//
//   * Tauri (printViaHelperWindow): hand the same self-contained HTML to the
//     Rust `open_print_window` command, which writes it to
//     ~/.shannon/.print-tmp.html and opens a small helper WebviewWindow that
//     loads it via the `shannon-print://` custom scheme. On page-load Rust
//     calls `Webview::print()` to fire the native macOS print panel
//     (window.print() can't drive this — WKWebView's JS print binding
//     throws "printOperationWithPrintInfo: unrecognized selector"). The
//     helper page listens for `afterprint` and invokes `close_print_helper`
//     to dismiss itself.

import { pageRegionDims, PAGE_PRINT_SCALE } from "./canvas-types";
import type { PageRegion } from "./canvas-types";
import { isTauri } from "./platform";

export interface PrintPageRegionDeps {
  /** The canvas-world element to clone. */
  world: HTMLElement;
  /** Active note's title, used to prefix the printed filename. */
  noteTitle?: string;
  /** Called before cloning so the caller can hide the selection outline. */
  hideSelection: () => void;
  /** Called when the print dialog closes (or fails) so the caller can restore selection. */
  restoreSelection: () => void;
}

export function printPageRegion(pr: PageRegion, deps: PrintPageRegionDeps) {
  if (isTauri) void printViaHelperWindow(pr, deps);
  else printViaIframe(pr, deps);
}

function clonePrintableWorld(world: HTMLElement, pr: PageRegion): HTMLElement {
  const clone = world.cloneNode(true) as HTMLElement;
  // Rasterize live <canvas> elements — cloneNode doesn't copy bitmap pixels
  const srcCanvases = world.querySelectorAll("canvas");
  const cloneCanvases = clone.querySelectorAll("canvas");
  srcCanvases.forEach((src, i) => {
    const dst = cloneCanvases[i] as HTMLCanvasElement | undefined;
    if (!dst) return;
    try {
      const img = document.createElement("img");
      img.src = (src as HTMLCanvasElement).toDataURL("image/png");
      img.style.cssText = dst.getAttribute("style") ?? "";
      img.width = (src as HTMLCanvasElement).width;
      img.height = (src as HTMLCanvasElement).height;
      dst.replaceWith(img);
    } catch {
      // Tainted canvas (cross-origin) — leave blank
    }
  });
  // Reset world transform so region's top-left lands at print-space origin
  clone.style.transform = `translate(${-pr.x}px, ${-pr.y}px)`;
  return clone;
}

function buildPrintTitle(pr: PageRegion, noteTitle?: string): string {
  const trimmedTitle = noteTitle?.trim();
  const hashLabel = pr.id.replace(/-/g, "").slice(0, 4);
  return trimmedTitle ? `${trimmedTitle} #${hashLabel}` : `#${hashLabel}`;
}

function printViaIframe(pr: PageRegion, deps: PrintPageRegionDeps) {
  const { world, noteTitle, hideSelection, restoreSelection } = deps;
  const { w, h } = pageRegionDims(pr.size, pr.rotation);

  hideSelection();

  // Defer to next frame so React re-renders without selection before we clone
  requestAnimationFrame(() => {
    const clone = clonePrintableWorld(world, pr);

    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
    document.body.appendChild(iframe);

    // Print dialog filename defaults to parent window's document.title in Chrome/Safari,
    // not the iframe's — swap it during print, restore on completion.
    const printTitle = buildPrintTitle(pr, noteTitle);
    const prevParentTitle = document.title;
    document.title = printTitle;

    const onDone = () => {
      document.title = prevParentTitle;
      restoreSelection();
      setTimeout(() => { iframe.remove(); }, 500);
    };

    iframe.onload = () => {
      const doc = iframe.contentDocument;
      const win = iframe.contentWindow;
      if (!doc || !win) { onDone(); return; }

      doc.title = printTitle;

      // Copy stylesheets so CSS variables, KaTeX, etc. resolve
      const head = doc.head;
      document.querySelectorAll('link[rel="stylesheet"], style').forEach((n) => {
        head.appendChild(n.cloneNode(true));
      });

      // Force the light theme cascade for the printed document — its var
      // values (light-gray code bg, near-black text, etc.) are already tuned
      // for white paper. Avoids dumping the runtime (potentially dark)
      // theme's variables into the iframe, which used to nuke styling.
      doc.documentElement.classList.remove("dark");
      doc.documentElement.classList.add("light");

      // next/font binds --font-lexend / --font-material-symbols on <html>
      // via a hashed class. We dropped the class above (replaced with .light
      // for theme), so we have to re-emit those vars explicitly — otherwise
      // var(--font-material-symbols) resolves to nothing and the checklist
      // check glyph (and any other Material Symbols icon) falls back to
      // literal text in the default font.
      const liveVars = getComputedStyle(document.documentElement);
      const fontVarDump = Array.from(liveVars)
        .filter((p) => p.startsWith("--font-"))
        .map((p) => `${p}:${liveVars.getPropertyValue(p)};`)
        .join("");

      const printW = w * PAGE_PRINT_SCALE;
      const printH = h * PAGE_PRINT_SCALE;

      const style = doc.createElement("style");
      style.textContent = `
        :root { ${fontVarDump} }
        /* Override just the page/canvas tint — light theme's --th-bg is
           a beige (#f5f5f4) which would tint the whole sheet & waste ink. */
        :root, :root.light { --th-bg: #fff; --th-canvas-bg: #fff; }
        /* Make the printer actually render backgrounds (code blocks,
           checklist surfaces, table headers, chart areas, mark highlights). */
        * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        @page { size: ${printW}px ${printH}px; margin: 0; }
        html,body{margin:0;padding:0;background:#fff;}
        .print-clip{position:relative;width:${printW}px;height:${printH}px;overflow:hidden;background:#fff;}
        .print-scale{transform:scale(${PAGE_PRINT_SCALE});transform-origin:0 0;width:${w}px;height:${h}px;position:relative;}
        /* Hide the page-region frame decoration — we want only the content inside */
        .page-region-frame{border:none !important;}
        .page-region-margin,.page-region-corner,.page-region-label{display:none !important;}
      `;
      head.appendChild(style);

      const wrap = doc.createElement("div");
      wrap.className = "print-clip";
      const scaler = doc.createElement("div");
      scaler.className = "print-scale";
      scaler.appendChild(clone);
      wrap.appendChild(scaler);
      doc.body.appendChild(wrap);

      // Give images a tick to decode, then print
      setTimeout(() => {
        win.focus();
        win.print();
        onDone();
      }, 150);
    };

    // Trigger the onload
    iframe.srcdoc = "<!DOCTYPE html><html><head></head><body></body></html>";
  });
}

// Walk all reachable stylesheets and dump them as one big CSS string, then
// rewrite every url(...) reference to an inlined data: URL by fetching the
// asset from the Tauri origin. The browser tab opened from file:// can't
// load tauri:// assets, so without inlining, @font-face URLs (next/font,
// Google Fonts via next/font/google, the local material-symbols woff2)
// would 404 and icon fonts would render as literal text — e.g. the
// checklist's "check" glyph would show as the word "check".
//
// Cross-origin stylesheets (whose cssRules access throws SecurityError)
// are skipped; usually those are ad-hoc CDN sheets and missing them
// doesn't break the page region.
async function dumpAllStylesheets(): Promise<string> {
  let cssText = "";
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        cssText += rule.cssText + "\n";
      }
    } catch {
      // CORS-blocked stylesheet — skip
    }
  }

  const urlRegex = /url\(\s*(?:'([^']+)'|"([^"]+)"|([^)\s]+))\s*\)/g;
  const urls = new Set<string>();
  for (const m of cssText.matchAll(urlRegex)) {
    const u = m[1] ?? m[2] ?? m[3];
    if (u && !u.startsWith("data:") && !u.startsWith("#")) urls.add(u);
  }

  const replacements = new Map<string, string>();
  await Promise.all(Array.from(urls).map(async (u) => {
    try {
      const resp = await fetch(u);
      if (!resp.ok) return;
      const blob = await resp.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      replacements.set(u, dataUrl);
    } catch {
      // Network/CORS error — leave the URL alone; it'll 404 in the tab.
    }
  }));

  return cssText.replace(urlRegex, (match, sg, dg, ug) => {
    const u = sg ?? dg ?? ug;
    const replacement = u ? replacements.get(u) : undefined;
    return replacement ? `url("${replacement}")` : match;
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function printViaHelperWindow(pr: PageRegion, deps: PrintPageRegionDeps) {
  const { world, noteTitle, hideSelection, restoreSelection } = deps;
  const { w, h } = pageRegionDims(pr.size, pr.rotation);
  const printW = w * PAGE_PRINT_SCALE;
  const printH = h * PAGE_PRINT_SCALE;

  hideSelection();

  // Defer to next frame so the selection-outline-removed React render
  // commits before we clone the world.
  await new Promise<void>((r) => requestAnimationFrame(() => r()));

  try {
    const clone = clonePrintableWorld(world, pr);
    const cssText = await dumpAllStylesheets();

    // next/font binds --font-lexend / --font-material-symbols on <html> via
    // a hashed class we don't carry into the print doc; without re-emitting
    // these explicitly, .material-symbols-outlined falls back to literal
    // text (the checklist's "check" glyph would render as the word "check").
    const liveVars = getComputedStyle(document.documentElement);
    const fontVarDump = Array.from(liveVars)
      .filter((p) => p.startsWith("--font-"))
      .map((p) => `${p}:${liveVars.getPropertyValue(p)};`)
      .join("");

    const printTitle = buildPrintTitle(pr, noteTitle);

    // class="light" forces the light-theme cascade for the print document
    // (its --th-* values are already tuned for white paper — light-gray code
    // bg, near-black text, preserved chart colors, etc.). Cleaner than
    // dumping the runtime theme's vars and overriding text colors to mono,
    // which used to nuke styling like checklist surfaces and code blocks.
    const html = `<!DOCTYPE html>
<html lang="en" class="light">
<head>
<meta charset="utf-8">
<title>${escapeHtml(printTitle)}</title>
<style>${cssText}</style>
<style>
:root { ${fontVarDump} }
/* Override just the page/canvas tint — light theme's --th-bg is a beige
   (#f5f5f4) which would tint the whole sheet & waste ink. */
:root, :root.light { --th-bg: #fff; --th-canvas-bg: #fff; }
/* Make the printer actually render backgrounds (code blocks, checklist
   surfaces, table headers, chart areas, mark highlights). */
* { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
@page { size: ${printW}px ${printH}px; margin: 0; }
html,body{margin:0;padding:0;background:#fff;}
.print-clip{position:relative;width:${printW}px;height:${printH}px;overflow:hidden;background:#fff;}
.print-scale{transform:scale(${PAGE_PRINT_SCALE});transform-origin:0 0;width:${w}px;height:${h}px;position:relative;}
.page-region-frame{border:none !important;}
.page-region-margin,.page-region-corner,.page-region-label{display:none !important;}
</style>
</head>
<body>
<div class="print-clip">
  <div class="print-scale">
${clone.outerHTML}
  </div>
</div>
<script>
  // Rust drives the actual print() call on page-load; we just clean up the
  // helper window after the panel closes. afterprint fires on both confirm
  // and cancel in WebKit. 60s safety net handles the (unlikely) case where
  // afterprint doesn't fire — beats leaving an orphaned window.
  window.addEventListener('afterprint', () => {
    try { window.__TAURI_INTERNALS__?.invoke('close_print_helper'); } catch {}
  });
  setTimeout(() => {
    try { window.__TAURI_INTERNALS__?.invoke('close_print_helper'); } catch {}
  }, 60000);
</script>
</body>
</html>`;

    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_print_window", { html });
  } catch (err) {
    console.error("printViaHelperWindow failed", err);
  } finally {
    restoreSelection();
  }
}
