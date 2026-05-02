#!/usr/bin/env node
// Assembles latest.json for the Tauri auto-updater from per-platform
// .sig files. Run after the local mac build + the CI Win/Linux artifact
// download, before `gh release create`.
//
//   node scripts/build-latest-json.mjs <version> <release-dir>
//
// Where <release-dir> is the folder containing:
//   ├── Shannon_<v>_aarch64.dmg            (mac, copied from local build)
//   ├── Shannon.app.tar.gz                 (mac updater bundle, copied from local build)
//   ├── Shannon.app.tar.gz.sig             (mac updater sig, copied from local build)
//   ├── shannon-windows-x64/
//   │   └── nsis/
//   │       ├── Shannon_<v>_x64-setup.exe
//   │       ├── Shannon_<v>_x64-setup.nsis.zip
//   │       └── Shannon_<v>_x64-setup.nsis.zip.sig
//   └── shannon-linux-x64/
//       └── appimage/
//           ├── Shannon_<v>_amd64.AppImage
//           ├── Shannon_<v>_amd64.AppImage.tar.gz
//           └── Shannon_<v>_amd64.AppImage.tar.gz.sig
//
// Output: writes latest.json to <release-dir>/latest.json. The URLs
// inside reference https://github.com/myxamediyar/shannon/releases/
// download/v<version>/<filename> — change OWNER/REPO if you fork.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";

const OWNER = "myxamediyar";
const REPO = "shannon";

const [, , version, releaseDirArg] = process.argv;

if (!version || !releaseDirArg) {
  console.error("usage: node scripts/build-latest-json.mjs <version> <release-dir>");
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

// ── macOS ───────────────────────────────────────────────────────────────────
const macSigs = findFile(releaseDir, (n) => n === "Shannon.app.tar.gz.sig");
if (macSigs.length !== 1) {
  console.error(`expected 1 mac .sig, found ${macSigs.length} — looked for Shannon.app.tar.gz.sig`);
  process.exit(1);
}
const macUpdaterFile = macSigs[0].replace(/\.sig$/, "");
// We upload the .tar.gz to the release with the bare filename "Shannon.app.tar.gz".
const macAsset = basename(macUpdaterFile);

// ── Windows ─────────────────────────────────────────────────────────────────
const winSigs = findFile(releaseDir, (n) => n.endsWith(".nsis.zip.sig"));
if (winSigs.length !== 1) {
  console.error(`expected 1 windows .nsis.zip.sig, found ${winSigs.length}`);
  process.exit(1);
}
const winAsset = basename(winSigs[0]).replace(/\.sig$/, "");

// ── Linux ───────────────────────────────────────────────────────────────────
const linuxSigs = findFile(releaseDir, (n) => n.endsWith(".AppImage.tar.gz.sig"));
if (linuxSigs.length !== 1) {
  console.error(`expected 1 linux .AppImage.tar.gz.sig, found ${linuxSigs.length}`);
  process.exit(1);
}
const linuxAsset = basename(linuxSigs[0]).replace(/\.sig$/, "");

// ── Manifest ────────────────────────────────────────────────────────────────
const manifest = {
  version,
  notes: `See https://github.com/${OWNER}/${REPO}/releases/tag/v${version}`,
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  platforms: {
    "darwin-aarch64": {
      signature: readSig(macSigs[0]),
      url: downloadUrl(macAsset),
    },
    "windows-x86_64": {
      signature: readSig(winSigs[0]),
      url: downloadUrl(winAsset),
    },
    "linux-x86_64": {
      signature: readSig(linuxSigs[0]),
      url: downloadUrl(linuxAsset),
    },
  },
};

const out = resolve(releaseDir, "latest.json");
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");

console.log(`wrote ${out}`);
console.log(`  darwin-aarch64 → ${macAsset}`);
console.log(`  windows-x86_64 → ${winAsset}`);
console.log(`  linux-x86_64   → ${linuxAsset}`);
