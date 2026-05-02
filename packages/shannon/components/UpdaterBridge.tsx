"use client";

// Tauri auto-updater. On app boot, polls the manifest URL configured in
// tauri.conf.json's plugins.updater.endpoints. If a newer version is
// available, prompts the user via a native macOS confirm dialog (the
// `dialog: true` config option is a Tauri-1 holdover that doesn't apply
// when driving the updater from the JS plugin API — the UI is ours).
// On confirm, downloads, verifies the Ed25519 signature, swaps the
// binary in place, and relaunches.
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

        const { ask } = await import("@tauri-apps/plugin-dialog");
        const wantsInstall = await ask(
          `Shannon ${update.version} is available — you have ${update.currentVersion}.\n\nInstall and restart now?`,
          { title: "Update available", kind: "info", okLabel: "Install", cancelLabel: "Later" },
        );
        if (cancelled || !wantsInstall) return;

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
