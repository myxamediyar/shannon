// Print one page region via an offscreen iframe. The canvas world DOM is
// cloned, live <canvas> bitmaps are rasterized to <img>s (cloneNode doesn't
// copy pixel buffers), the iframe is positioned so only the region's bounds
// show through, and the browser print dialog is triggered.

import { pageRegionDims, PAGE_PRINT_SCALE } from "./canvas-types";
import type { PageRegion } from "./canvas-types";

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
  const { world, noteTitle, hideSelection, restoreSelection } = deps;
  const { w, h } = pageRegionDims(pr.size, pr.rotation);

  hideSelection();

  // Defer to next frame so React re-renders without selection before we clone
  requestAnimationFrame(() => {
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

    // Reset world transform so region can be positioned precisely in print space
    clone.style.transform = `translate(${-pr.x}px, ${-pr.y}px)`;

    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
    document.body.appendChild(iframe);

    // Print dialog filename defaults to parent window's document.title in Chrome/Safari,
    // not the iframe's — swap it during print, restore on completion.
    const trimmedTitle = noteTitle?.trim();
    const hashLabel = pr.id.replace(/-/g, "").slice(0, 4);
    const printTitle = trimmedTitle ? `${trimmedTitle} #${hashLabel}` : `#${hashLabel}`;
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

      // Preserve :root CSS variables explicitly (computed) in case theme is attribute-scoped
      const rootVars = getComputedStyle(document.documentElement);
      const varDump = Array.from(rootVars)
        .filter((p) => p.startsWith("--"))
        .map((p) => `${p}:${rootVars.getPropertyValue(p)};`).join("");

      const printW = w * PAGE_PRINT_SCALE;
      const printH = h * PAGE_PRINT_SCALE;

      const style = doc.createElement("style");
      style.textContent = `
        :root{${varDump}}
        /* Force print output to pure black-on-white regardless of theme */
        :root{
          --th-text:#000;--th-text-secondary:#000;--th-text-muted:#000;--th-text-faint:#000;
          --th-stroke:#000;--th-canvas-bg:#fff;--th-canvas-dot:#000;
        }
        @page { size: ${printW}px ${printH}px; margin: 0; }
        html,body{margin:0;padding:0;background:#fff;color:#000;}
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
