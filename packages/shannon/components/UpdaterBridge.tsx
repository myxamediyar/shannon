"use client";

// Tauri auto-updater. On app boot, polls the manifest URL configured in
// tauri.conf.json's plugins.updater.endpoints. If a newer version is
// available, the plugin's built-in dialog (`dialog: true`) prompts the
// user to download + install. After the install we relaunch the app.
//
// No-op outside Tauri. Mounted once at the dashboard root next to
// MenuEventBridge.

import { useEffect } from "react";

import { isTauri } from "../lib/platform";

export default function UpdaterBridge() {
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;

    (async () => {
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        if (cancelled || !update) return;

        // dialog: true in tauri.conf shows the OS-native prompt. If the
        // user declines, downloadAndInstall throws or is a no-op
        // depending on the version — guard with try/catch.
        await update.downloadAndInstall();

        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      } catch {
        // Network errors, manifest 404 (no release yet), user-declined
        // installs, etc. all land here. Silent — this runs on every boot
        // and noisy logs would clutter the console.
      }
    })();

    return () => { cancelled = true; };
  }, []);

  return null;
}
