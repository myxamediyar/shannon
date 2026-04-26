"use client";

import { useRef, useState } from "react";
import { useSettings, uiToRealOpacity } from "../../lib/use-settings";
import {
  IDB_PREFIX,
  addBackground,
  deleteBackground,
  renameBackground,
  useCustomBackgrounds,
  useResolvedBgImage,
} from "../../lib/custom-backgrounds";

const PRESET_BACKGROUNDS = [
  { label: "None", value: "none" },
  { label: "Arc Nature", value: "/arc-nature.webp" },
  { label: "Pink Cave", value: "/pink-cave.webp" },
  { label: "Space 1", value: "/space1.webp" },
  { label: "Space 2", value: "/space2.webp" },
  { label: "Forest", value: "/forest.webp" },
  { label: "Plant", value: "/plant.webp" },
];

/** Downscale a user-supplied image to at most MAX_DIM on the longest side and
 *  re-encode as JPEG. The blob is stored in IndexedDB, which has plenty of room,
 *  but compressing keeps decode/memory cost reasonable since the canvas renders
 *  these at ~8% opacity where artifacts are invisible. */
const MAX_DIM = 1920;
async function fileToCompressedBlob(file: File): Promise<Blob> {
  const src: string = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const blob: Blob = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d")!.drawImage(img, 0, 0, w, h);
      c.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Encode failed"))),
        "image/jpeg",
        0.75,
      );
    };
    img.onerror = () => reject(new Error("Failed to decode image"));
    img.src = src;
  });
  return blob;
}

const stripExt = (name: string) => name.replace(/\.[^.]+$/, "") || "Untitled";

export default function SettingsPage() {
  const { settings, update, reset } = useSettings();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { list: customs } = useCustomBackgrounds();
  const previewUrl = useResolvedBgImage(settings.bgImage);

  // Inline rename state — which custom id is being edited, and the draft label.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");

  const handleCustomUpload = async (file: File) => {
    try {
      const blob = await fileToCompressedBlob(file);
      const id = await addBackground(stripExt(file.name), blob);
      update({ bgImage: `${IDB_PREFIX}${id}` });
    } catch (err) {
      console.warn("Custom background upload failed:", err);
    }
  };

  const handleDelete = async (id: string) => {
    const isSelected = settings.bgImage === `${IDB_PREFIX}${id}`;
    await deleteBackground(id);
    if (isSelected) update({ bgImage: "none" });
  };

  const startRename = (id: string, current: string) => {
    setEditingId(id);
    setDraftLabel(current);
  };

  const commitRename = async () => {
    if (!editingId) return;
    const next = draftLabel.trim();
    const id = editingId;
    setEditingId(null);
    if (!next) return;
    try {
      await renameBackground(id, next);
    } catch (err) {
      console.warn("Rename failed:", err);
    }
  };

  return (
    <div className="max-w-xl mx-auto py-16 px-6 font-lexend">
      <h1 className="font-extrabold text-3xl text-[var(--th-text)] tracking-tighter mb-1">Settings</h1>
      <p className="text-sm text-[var(--th-text-muted)] mb-10">Customize your canvas experience.</p>

      {/* ── Tools ────────────────────────────────────────── */}
      <section>
        <h2 className="text-[0.625rem] font-bold uppercase tracking-[0.18em] text-[var(--th-text-faint)] mb-4">
          Tools
        </h2>

        <div className="space-y-4">
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-sm text-[var(--th-text)]">Draw: drag to draw</span>
            <button
              role="switch"
              aria-checked={settings.drawDragToDraw}
              onClick={() => update({ drawDragToDraw: !settings.drawDragToDraw })}
              className={`relative w-10 h-6 rounded-full transition-colors ${settings.drawDragToDraw ? "bg-[#6c63ff]" : "bg-[var(--th-divider)]"}`}
            >
              <span className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${settings.drawDragToDraw ? "translate-x-4" : ""}`} />
            </button>
          </label>

          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-sm text-[var(--th-text)]">Expanded toolbar</span>
            <button
              role="switch"
              aria-checked={settings.expandedToolbar}
              onClick={() => update({ expandedToolbar: !settings.expandedToolbar })}
              className={`relative w-10 h-6 rounded-full transition-colors ${settings.expandedToolbar ? "bg-[#6c63ff]" : "bg-[var(--th-divider)]"}`}
            >
              <span className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${settings.expandedToolbar ? "translate-x-4" : ""}`} />
            </button>
          </label>
        </div>
      </section>

      {/* ── Canvas Background ─────────────────────────────── */}
      <section className="mt-12">
        <h2 className="text-[0.625rem] font-bold uppercase tracking-[0.18em] text-[var(--th-text-faint)] mb-4">
          Canvas Background
        </h2>

        <div className="space-y-4">
          {/* Light theme toggle */}
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-sm text-[var(--th-text)]">Light theme</span>
            <button
              role="switch"
              aria-checked={settings.lightTheme}
              onClick={() => update({ lightTheme: !settings.lightTheme })}
              className={`relative w-10 h-6 rounded-full transition-colors ${settings.lightTheme ? "bg-[#6c63ff]" : "bg-[var(--th-divider)]"}`}
            >
              <span className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${settings.lightTheme ? "translate-x-4" : ""}`} />
            </button>
          </label>

          {/* Grayscale toggle */}
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-sm text-[var(--th-text)]">Grayscale background</span>
            <button
              role="switch"
              aria-checked={settings.bgGrayscale}
              onClick={() => update({ bgGrayscale: !settings.bgGrayscale })}
              className={`relative w-10 h-6 rounded-full transition-colors ${settings.bgGrayscale ? "bg-[#6c63ff]" : "bg-[var(--th-divider)]"}`}
            >
              <span className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${settings.bgGrayscale ? "translate-x-4" : ""}`} />
            </button>
          </label>

          {/* Blur toggle */}
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-sm text-[var(--th-text)]">Blur background</span>
            <button
              role="switch"
              aria-checked={settings.bgBlur}
              onClick={() => update({ bgBlur: !settings.bgBlur })}
              className={`relative w-10 h-6 rounded-full transition-colors ${settings.bgBlur ? "bg-[#6c63ff]" : "bg-[var(--th-divider)]"}`}
            >
              <span className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${settings.bgBlur ? "translate-x-4" : ""}`} />
            </button>
          </label>

          {/* Dots toggle */}
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-sm text-[var(--th-text)]">Show dots</span>
            <button
              role="switch"
              aria-checked={settings.bgDots}
              onClick={() => update({ bgDots: !settings.bgDots })}
              className={`relative w-10 h-6 rounded-full transition-colors ${settings.bgDots ? "bg-[#6c63ff]" : "bg-[var(--th-divider)]"}`}
            >
              <span className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${settings.bgDots ? "translate-x-4" : ""}`} />
            </button>
          </label>

          {/* Background image selector */}
          <div>
            <span className="text-sm text-[var(--th-text)]">Background image</span>
            <p className="text-xs text-[var(--th-text-faint)] mt-1">
              Double-click a custom to rename.
            </p>
            <div className="flex flex-wrap gap-2 mt-2">
              {PRESET_BACKGROUNDS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => update({ bgImage: opt.value })}
                  className={`px-3 py-1 rounded-md text-xs font-bold transition-colors ${
                    settings.bgImage === opt.value
                      ? "bg-[#6c63ff] text-white"
                      : "bg-[var(--th-divider)] text-[var(--th-text-muted)] hover:text-[var(--th-text)]"
                  }`}
                >
                  {opt.label}
                </button>
              ))}

              {customs.map((c) => {
                const value = `${IDB_PREFIX}${c.id}`;
                const isSelected = settings.bgImage === value;
                const isEditing = editingId === c.id;
                return (
                  <div key={c.id} className="group relative inline-flex">
                    {isEditing ? (
                      <input
                        autoFocus
                        value={draftLabel}
                        onChange={(e) => setDraftLabel(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename();
                          else if (e.key === "Escape") setEditingId(null);
                        }}
                        className="px-3 py-1 rounded-md text-xs font-bold bg-[var(--th-divider)] text-[var(--th-text)] outline-none ring-1 ring-[#6c63ff] min-w-[5rem]"
                        style={{ width: `${Math.max(5, draftLabel.length + 1)}ch` }}
                      />
                    ) : (
                      <>
                        <button
                          onClick={() => update({ bgImage: value })}
                          onDoubleClick={() => startRename(c.id, c.label)}
                          title={c.label}
                          className={`pl-3 pr-6 py-1 rounded-md text-xs font-bold transition-colors max-w-[10rem] truncate ${
                            isSelected
                              ? "bg-[#6c63ff] text-white"
                              : "bg-[var(--th-divider)] text-[var(--th-text-muted)] hover:text-[var(--th-text)]"
                          }`}
                        >
                          {c.label}
                        </button>
                        <button
                          onClick={() => handleDelete(c.id)}
                          aria-label={`Delete ${c.label}`}
                          className={`absolute top-0 right-0 h-full w-5 flex items-center justify-center text-sm leading-none rounded-r-md opacity-50 hover:opacity-100 transition-opacity ${
                            isSelected ? "text-white" : "text-[var(--th-text-faint)] hover:text-[var(--th-text)]"
                          }`}
                        >
                          ×
                        </button>
                      </>
                    )}
                  </div>
                );
              })}

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleCustomUpload(file);
                  e.target.value = "";
                }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-3 py-1 rounded-md text-xs font-bold bg-[var(--th-divider)] text-[var(--th-text-muted)] hover:text-[var(--th-text)] transition-colors"
                title="Upload your own image"
              >
                + Upload
              </button>
            </div>
          </div>

          {/* Opacity slider — UI range 1–100, maps to real opacity 0.20–0.70 */}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-[var(--th-text)]">Background opacity</span>
              <span className="text-xs font-bold text-[var(--th-text-muted)] tabular-nums">
                {settings.bgOpacity}
              </span>
            </div>
            <input
              type="range"
              min={1}
              max={100}
              value={settings.bgOpacity}
              onChange={(e) => update({ bgOpacity: Number(e.target.value) })}
              className="w-full mt-2 accent-[#6c63ff]"
            />
          </div>
        </div>

        {/* Preview */}
        <div
          className="relative mt-6 rounded-lg border border-[var(--th-border-10)] h-28 overflow-hidden"
          style={{
            backgroundColor: "var(--th-canvas-bg)",
            ...(settings.bgDots ? {
              backgroundImage: "radial-gradient(circle, var(--th-canvas-dot) 1px, transparent 1px)",
              backgroundSize: "24px 24px",
            } : {}),
          }}
        >
          {previewUrl && previewUrl !== "none" && (
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                backgroundImage: `url(${previewUrl})`,
                backgroundSize: "cover",
                backgroundPosition: "center",
                opacity: uiToRealOpacity(settings.bgOpacity),
                filter: [settings.bgGrayscale && "grayscale(1)", settings.bgBlur && "blur(4px)"].filter(Boolean).join(" ") || "none",
              }}
            />
          )}
        </div>

        {/* Reset */}
        <button
          onClick={reset}
          className="mt-6 px-4 py-1.5 rounded-md text-xs font-bold text-[var(--th-text-muted)] border border-[var(--th-border-10)] hover:border-[var(--th-border-20)] hover:text-[var(--th-text)] transition-colors"
        >
          Reset to defaults
        </button>
      </section>
    </div>
  );
}
