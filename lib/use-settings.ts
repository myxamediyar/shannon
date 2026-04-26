"use client";

import { useCallback, useEffect, useState } from "react";

// ── Types ───────────────────────────────────────────────────────────────────

export type CanvasSettings = {
  bgDots: boolean;
  lightTheme: boolean;
  bgImage: string; // URL path or "none"
  bgGrayscale: boolean;
  bgBlur: boolean;
  drawDragToDraw: boolean;
  expandedToolbar: boolean;
  /** Background-image opacity on a 1–100 UI scale. The canvas maps this to a
   *  real opacity between 0.20 and 0.70 so the image always reads as a subtle
   *  backdrop, never fully transparent and never overpowering. */
  bgOpacity: number;
};

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULTS: CanvasSettings = {
  bgDots: false,
  lightTheme: false,
  bgImage: "",
  bgGrayscale: false,
  bgBlur: false,
  drawDragToDraw: false,
  expandedToolbar: true,
  bgOpacity: 50,
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Map the 1–100 UI slider value into a real CSS opacity, anchored so that
 *  UI 30 → 0.08 (historic default) and UI 100 → 0.20 (max). Linear; UI 1 ≈ 3%. */
export function uiToRealOpacity(ui: number): number {
  const clamped = Math.min(100, Math.max(1, ui));
  return 0.08 + (clamped - 30) * (0.8 / 70);
}

// ── Storage key ─────────────────────────────────────────────────────────────

const SETTINGS_KEY = "shannon_settings";

// ── Hook ────────────────────────────────────────────────────────────────────

function load(): CanvasSettings {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return DEFAULTS;
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<CanvasSettings>(DEFAULTS);

  // hydrate from localStorage on mount
  useEffect(() => { setSettings(load()); }, []);

  const update = useCallback((patch: Partial<CanvasSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch (err) {
        // Quota exceeded (e.g. custom background data-URL pushed us over the limit) —
        // keep the in-memory update so the UI stays responsive. Next reload will
        // lose the un-persisted change.
        console.warn("Settings persist failed:", err);
      }
      queueMicrotask(() => {
        window.dispatchEvent(new CustomEvent("shannon:settings", { detail: next }));
      });
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    try { localStorage.removeItem(SETTINGS_KEY); } catch { /* ignore */ }
    setSettings(DEFAULTS);
    queueMicrotask(() => {
      window.dispatchEvent(new CustomEvent("shannon:settings", { detail: DEFAULTS }));
    });
  }, []);

  // sync across components (same tab) + across tabs
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<CanvasSettings | undefined>).detail;
      // Same-tab dispatch ships the new settings in `detail` so we don't have
      // to round-trip through localStorage (which may not have the write if
      // the persist step threw a quota error).
      if (detail) setSettings(detail);
      else setSettings(load()); // native `storage` event from another tab
    };
    window.addEventListener("shannon:settings", handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener("shannon:settings", handler);
      window.removeEventListener("storage", handler);
    };
  }, []);

  return { settings, update, reset, DEFAULTS };
}
