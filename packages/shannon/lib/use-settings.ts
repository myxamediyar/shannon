"use client";

import { useCallback, useSyncExternalStore } from "react";

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

// ── Module-level store (useSyncExternalStore) ───────────────────────────────
// Shared across every useSettings() caller in the tree. Writes update the
// snapshot synchronously, persist to localStorage, and fan out to subscribers
// — no window events.

function loadFromStorage(): CanvasSettings {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return DEFAULTS;
  }
}

let snapshot: CanvasSettings = DEFAULTS;
let hydrated = false;
const subs = new Set<() => void>();

function hydrateOnce(): void {
  if (hydrated) return;
  hydrated = true;
  snapshot = loadFromStorage();
}

function notify(): void {
  for (const l of subs) l();
}

function subscribe(listener: () => void): () => void {
  hydrateOnce();
  subs.add(listener);
  return () => { subs.delete(listener); };
}

function getSnapshot(): CanvasSettings {
  hydrateOnce();
  return snapshot;
}

function getServerSnapshot(): CanvasSettings {
  return DEFAULTS;
}

function persist(next: CanvasSettings): void {
  snapshot = next;
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch (err) {
      // Quota exceeded (e.g. custom background data-URL pushed us over the
      // limit) — keep the in-memory update so the UI stays responsive. Next
      // reload will lose the un-persisted change.
      // eslint-disable-next-line no-console
      console.warn("Settings persist failed:", err);
    }
  }
  notify();
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useSettings() {
  const settings = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const update = useCallback((patch: Partial<CanvasSettings>) => {
    persist({ ...snapshot, ...patch });
  }, []);

  const reset = useCallback(() => {
    if (typeof window !== "undefined") {
      try { localStorage.removeItem(SETTINGS_KEY); } catch { /* ignore */ }
    }
    snapshot = DEFAULTS;
    notify();
  }, []);

  return { settings, update, reset, DEFAULTS };
}
