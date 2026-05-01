import { isTauri } from "./index";

// Path is relative to the OS home directory.
const CONFIG_PATH = ".shannon/config.json";

// Reads the persisted config. Returns null if it doesn't exist yet.
// In Tauri, reads `~/.shannon/config.json` via the fs plugin.
// In web, fetches `/api/config` (the npm CLI shell handles file I/O).
export async function readConfig<T = unknown>(): Promise<T | null> {
  if (isTauri) {
    const { readTextFile, exists, BaseDirectory } = await import(
      "@tauri-apps/plugin-fs"
    );
    if (!(await exists(CONFIG_PATH, { baseDir: BaseDirectory.Home }))) {
      return null;
    }
    const text = await readTextFile(CONFIG_PATH, {
      baseDir: BaseDirectory.Home,
    });
    return JSON.parse(text) as T;
  }
  const res = await fetch("/api/config");
  if (!res.ok) return null;
  return (await res.json()) as T;
}

// Writes the config. In Tauri, writes to `~/.shannon/config.json`.
// In web, POSTs to `/api/config`.
export async function writeConfig<T = unknown>(config: T): Promise<void> {
  const json = JSON.stringify(config, null, 2);
  if (isTauri) {
    const { mkdir, BaseDirectory } = await import("@tauri-apps/plugin-fs");
    const { atomicWriteTextFile } = await import("./atomic-write");
    await mkdir(".shannon", { baseDir: BaseDirectory.Home, recursive: true });
    await atomicWriteTextFile(CONFIG_PATH, json, { baseDir: BaseDirectory.Home });
    return;
  }
  const res = await fetch("/api/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: json,
  });
  if (!res.ok) throw new Error(`writeConfig failed: ${res.status}`);
}
