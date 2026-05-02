#!/usr/bin/env node
// Assembles latest.json for the Tauri auto-updater from per-platform
// .sig files. Run after the local mac build + the CI Win/Linux artifact
// download, before `gh release create`.
//
//   node scripts/build-latest-json.mjs <version> <release-dir>
//
// In Tauri 2 the updater downloads the regular installers and verifies a
// matching .sig — there's no separate .nsis.zip / .AppImage.tar.gz wrapper.
// Layout expected:
//
//   ├── Shannon_<v>_aarch64.dmg            (mac first-install)
//   ├── Shannon.app.tar.gz                 (mac updater bundle)
//   ├── Shannon.app.tar.gz.sig             (mac sig)
//   ├── shannon-windows-x64/
//   │   └── nsis/
//   │       ├── Shannon_<v>_x64-setup.exe
//   │       └── Shannon_<v>_x64-setup.exe.sig
//   └── shannon-linux-x64/
//       └── appimage/
//           ├── Shannon_<v>_amd64.AppImage
//           └── Shannon_<v>_amd64.AppImage.sig
//
// Pass `--platforms=darwin` (or any comma-list) to skip platforms whose
// sigs are missing — useful while a CI run is being debugged. Default
// is all three.
//
// Output: writes latest.json to <release-dir>/latest.json. The URLs
// inside reference https://github.com/myxamediyar/shannon/releases/
// download/v<version>/<filename> — change OWNER/REPO if you fork.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";

const OWNER = "myxamediyar";
const REPO = "shannon";

const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith("--"));
const releaseDirArg = args.find((a, i) => !a.startsWith("--") && i > args.indexOf(version));
const platformsArg = args.find((a) => a.startsWith("--platforms="));
const wanted = new Set(
  platformsArg
    ? platformsArg.replace("--platforms=", "").split(",")
    : ["darwin", "windows", "linux"],
);

if (!version || !releaseDirArg) {
  console.error("usage: node scripts/build-latest-json.mjs <version> <release-dir> [--platforms=darwin,windows,linux]");
  process.exit(1);
}

const releaseDir = resolve(releaseDirArg);

function findFile(dir, predicate) {
  const matches = [];
  function walk(d) {
    for (const entry of readdirSync(d)) {
      const p = resolve(d, entry);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (predicate(entry)) matches.push(p);
    }
  }
  walk(dir);
  return matches;
}

function readSig(path) {
  return readFileSync(path, "utf8").trim();
}

function downloadUrl(filename) {
  return `https://github.com/${OWNER}/${REPO}/releases/download/v${version}/${filename}`;
}

const platforms = {};

// ── macOS ───────────────────────────────────────────────────────────────────
if (wanted.has("darwin")) {
  const macSigs = findFile(releaseDir, (n) => n === "Shannon.app.tar.gz.sig");
  if (macSigs.length !== 1) {
    console.error(`darwin: expected 1 Shannon.app.tar.gz.sig, found ${macSigs.length}`);
    process.exit(1);
  }
  const asset = basename(macSigs[0]).replace(/\.sig$/, "");
  platforms["darwin-aarch64"] = {
    signature: readSig(macSigs[0]),
    url: downloadUrl(asset),
  };
}

// ── Windows ─────────────────────────────────────────────────────────────────
// Tauri 2 signs the .exe / .msi installer directly; updater downloads
// and re-runs it.
if (wanted.has("windows")) {
  const winSigs = findFile(releaseDir, (n) => n.endsWith("-setup.exe.sig"));
  if (winSigs.length !== 1) {
    console.error(`windows: expected 1 -setup.exe.sig, found ${winSigs.length}`);
    process.exit(1);
  }
  const asset = basename(winSigs[0]).replace(/\.sig$/, "");
  platforms["windows-x86_64"] = {
    signature: readSig(winSigs[0]),
    url: downloadUrl(asset),
  };
}

// ── Linux ───────────────────────────────────────────────────────────────────
// AppImage is its own updater bundle in Tauri 2 (self-contained binary).
if (wanted.has("linux")) {
  const linuxSigs = findFile(releaseDir, (n) => n.endsWith(".AppImage.sig"));
  if (linuxSigs.length !== 1) {
    console.error(`linux: expected 1 .AppImage.sig, found ${linuxSigs.length}`);
    process.exit(1);
  }
  const asset = basename(linuxSigs[0]).replace(/\.sig$/, "");
  platforms["linux-x86_64"] = {
    signature: readSig(linuxSigs[0]),
    url: downloadUrl(asset),
  };
}

const manifest = {
  version,
  notes: `See https://github.com/${OWNER}/${REPO}/releases/tag/v${version}`,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms,
};

const out = resolve(releaseDir, "latest.json");
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");

console.log(`wrote ${out}`);
for (const [k, v] of Object.entries(platforms)) {
  console.log(`  ${k.padEnd(16)} → ${basename(v.url)}`);
}
