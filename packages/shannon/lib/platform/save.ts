// Save-with-dialog adapter. In Tauri, surfaces the native save sheet and
// writes the chosen path via a custom Rust command (so we don't have to
// expand fs:scope to the entire disk just to honor the user's choice). In
// the browser/npm build, falls back to the synthetic <a download> trick.

import { isTauri } from "./index";

export type SaveFilter = { name: string; extensions: string[] };

export type SaveTextOptions = {
  /** Text payload to write. */
  content: string;
  /** Default filename shown in the save dialog (or the download attribute). */
  suggestedName: string;
  /** Mime type used by the browser-side download blob. */
  mime?: string;
  /** Format filters shown in the native save sheet (Tauri only). */
  filters?: SaveFilter[];
};

/** Save text content to a user-chosen location. Returns the chosen path
 *  (Tauri) or the suggested name (web), or `null` if the user cancelled. */
export async function saveTextWithDialog(opts: SaveTextOptions): Promise<string | null> {
  const { content, suggestedName, mime = "text/plain", filters } = opts;

  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { invoke } = await import("@tauri-apps/api/core");
    const path = await save({ defaultPath: suggestedName, filters });
    if (!path) return null;
    await invoke("save_file_to_path", { path, content });
    return path;
  }

  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return suggestedName;
}

export async function saveBlobWithDialog(
  blob: Blob,
  suggestedName: string,
  filters?: SaveFilter[],
): Promise<string | null> {
  const text = await blob.text();
  return saveTextWithDialog({
    content: text,
    suggestedName,
    mime: blob.type || "application/octet-stream",
    filters,
  });
}
