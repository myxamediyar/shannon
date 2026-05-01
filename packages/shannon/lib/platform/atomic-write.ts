// Atomic file writes for the Tauri side: write to a unique temp path, then
// rename onto the final path. Two reasons it's worth the indirection:
//
//   * `rename` is atomic on the same filesystem — readers either see the
//     old inode or the new one, never a half-written file. A direct
//     `writeTextFile(final, …)` exposes the file mid-write to any other
//     process that's reading.
//
//   * Concurrent writers can't tear each other's bytes. As long as each
//     writer picks a *unique* temp path, two parallel writes just race to
//     rename last; the loser's bytes vanish cleanly with the unlinked
//     inode. Sharing a temp path (e.g. `<id>.shannon.tmp`) is what creates
//     interleaved corruption when a CLI write and a Tauri write land at
//     the same time.
//
// The CLI mirrors this pattern in bin/shannon.js. Either side can race
// the other safely now — last-writer-wins, no torn bytes.

import { BaseDirectory } from "@tauri-apps/plugin-fs";

function tmpSuffix(): string {
  return `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
}

export async function atomicWriteTextFile(
  finalPath: string,
  contents: string,
  options: { baseDir: BaseDirectory },
): Promise<void> {
  const { writeTextFile, rename, remove, exists } = await import(
    "@tauri-apps/plugin-fs"
  );
  const tmp = `${finalPath}.tmp.${tmpSuffix()}`;
  try {
    await writeTextFile(tmp, contents, options);
    await rename(tmp, finalPath, {
      oldPathBaseDir: options.baseDir,
      newPathBaseDir: options.baseDir,
    });
  } catch (err) {
    // Best-effort cleanup so a failed write doesn't leave a stray .tmp.<id>
    // file lying around. If the tmp was never created (writeTextFile threw
    // before opening), the exists check returns false and remove is skipped.
    try {
      if (await exists(tmp, { baseDir: options.baseDir })) {
        await remove(tmp, { baseDir: options.baseDir });
      }
    } catch {
      /* swallow — original error is what matters */
    }
    throw err;
  }
}
