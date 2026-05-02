#!/usr/bin/env node
// One-shot version bumper. Updates the three places version lives,
// re-runs `npm install` so package-lock picks it up, then commits and
// tags. Run from the repo root:
//
//   node scripts/version-bump.mjs 0.2.0
//   node scripts/version-bump.mjs 0.2.0 --no-tag    # bump only, don't commit/tag
//
// Requires a clean working tree (no uncommitted changes) — refuses
// otherwise to avoid mixing release commits with in-flight work.

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");

const args = process.argv.slice(2);
const version = args[0];
const skipCommit = args.includes("--no-tag") || args.includes("--no-commit");

if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("usage: node scripts/version-bump.mjs <semver> [--no-tag]");
  console.error("       version must be plain semver: 1.2.3 or 1.2.3-rc.1");
  process.exit(1);
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { cwd: REPO, encoding: "utf8", stdio: opts.silent ? "pipe" : "inherit", ...opts });
}

if (!skipCommit) {
  const dirty = sh("git status --porcelain", { silent: true }).trim();
  if (dirty) {
    console.error("working tree is dirty — commit or stash first:");
    console.error(dirty);
    process.exit(1);
  }
}

// ── 1. JSON files ───────────────────────────────────────────────────────────
const jsonFiles = [
  "packages/shannon/package.json",
  "packages/shannon-desktop/src-tauri/tauri.conf.json",
];
for (const rel of jsonFiles) {
  const path = resolve(REPO, rel);
  const json = JSON.parse(readFileSync(path, "utf8"));
  json.version = version;
  // Preserve trailing newline (npm's convention) — JSON.stringify drops it.
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
  console.log(`bumped ${rel} → ${version}`);
}

// ── 2. Cargo.toml ───────────────────────────────────────────────────────────
// Only touch the [package] section's version line. A repo-wide regex would
// risk hitting `tauri = { version = "2" }` or similar.
const cargoPath = resolve(REPO, "packages/shannon-desktop/src-tauri/Cargo.toml");
let cargo = readFileSync(cargoPath, "utf8");
cargo = cargo.replace(
  /(\[package\][\s\S]*?\nversion\s*=\s*)"[^"]+"/,
  `$1"${version}"`,
);
writeFileSync(cargoPath, cargo);
console.log(`bumped packages/shannon-desktop/src-tauri/Cargo.toml → ${version}`);

// ── 3. package-lock refresh ─────────────────────────────────────────────────
// `npm install` with no args re-resolves and updates lockfiles to reflect
// the new version on tryshannon. Output is noisy; suppress unless TTY.
console.log("refreshing package-lock.json…");
sh("npm install --silent");

// ── 4. Cargo.lock refresh ───────────────────────────────────────────────────
// The version in Cargo.toml is also recorded in Cargo.lock. Without this
// the CI build would patch it on first run and produce a dirty tree.
console.log("refreshing Cargo.lock…");
sh("cargo update -p shannon_desktop --workspace --offline 2>/dev/null || cargo update -p shannon_desktop", {
  cwd: resolve(REPO, "packages/shannon-desktop/src-tauri"),
});

// ── 5. Commit + tag ─────────────────────────────────────────────────────────
if (skipCommit) {
  console.log(`\nfiles updated; skipping commit/tag (--no-tag).`);
  process.exit(0);
}

sh(`git add packages/shannon/package.json \
        packages/shannon-desktop/src-tauri/tauri.conf.json \
        packages/shannon-desktop/src-tauri/Cargo.toml \
        packages/shannon-desktop/src-tauri/Cargo.lock \
        package-lock.json`);
sh(`git commit -m "release: v${version}"`);
sh(`git tag v${version}`);

console.log(`\ntagged v${version}. Push when ready:`);
console.log(`  git push origin main --tags`);
