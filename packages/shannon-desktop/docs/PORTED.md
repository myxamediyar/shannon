---
created: 2026-04-30
---

# Origin

`shannon-desktop` is a Tauri 2 shell that wraps the Next.js app living in
`packages/shannon/` (sibling workspace inside this monorepo).

It was scaffolded on **2026-04-30** as a lightweight alternative to Electron:
ship a small native binary that boots Shannon's Next server in the background
and renders it in a chromeless OS window.

On **2026-04-30** the originally separate `shannon_desktop/` directory was
folded into the `shannon/` repo as `packages/shannon-desktop/` (Phase 0 of
the plan at `docs/MIGRATION_PLAN.md` at the monorepo root).

## How it relates to `shannon/`

- The frontend in `src/` is the unmodified Tauri vanilla scaffold and is
  **not used at runtime** — the window points at `http://localhost:1948`
  directly.
- The Rust backend in `src-tauri/` is the actual desktop app: it spawns
  Shannon as a child process, waits for the port, and shows the window.
- Source-of-truth for the UI is still the sibling `shannon/` repo. Changes
  to canvas/notes/UI happen there, not here.

## Setup that was done

1. Installed Rust via rustup (stable, minimal profile).
2. `npm create tauri-app@latest shannon_desktop -- --template vanilla --manager npm --identifier com.shannon.desktop -y`.
3. Edited `src-tauri/tauri.conf.json`:
   - `productName` → `Shannon`, window title → `Shannon`
   - window `url` → `http://localhost:1948`
   - window starts hidden (`visible: false`) so there's no flash of
     `ERR_CONNECTION_REFUSED` while the Node server boots.
4. Rewrote `src-tauri/src/lib.rs` with sidecar logic (stdlib only — no
   extra crates):
   - On startup: probe port 1948. If already serving, attach. Otherwise
     spawn `shannon` (override with env var `SHANNON_BIN`).
   - Background thread polls the port up to ~30s; on first success,
     reload + show the window.
   - On `CloseRequested`: kill + wait the child so Node dies with the app.

## How to run (dev)

From the monorepo root:
```bash
npm run tauri:dev
```
Or from this package's directory: `npm run tauri -- dev`.

First run compiles ~200 Rust crates (~5–8 min). Subsequent runs are fast.

After Phase 0 (workspace setup), the Shannon CLI is auto-symlinked into
`node_modules/.bin/shannon`, so the Tauri sidecar's `Command::new("shannon")`
resolves to the workspace's own `tryshannon` package — no global install
needed.

If `cargo` isn't found, the current shell's PATH doesn't have rustup's
bin dir. Fix: `source "$HOME/.cargo/env"` or open a new terminal.

## Known caveats / unresolved

- **Packaged `.app` won't find `shannon` on PATH.** When launched from
  Finder, `$PATH` doesn't include `/opt/homebrew/bin`. For a real
  `tauri build` artifact, switch to a real Tauri sidecar (`bundle.externalBin`
  with Shannon compiled to a single binary), or hard-code an absolute
  path in `spawn_shannon`.
- **Zombie child on hard kill.** If the Tauri process is force-killed
  (not closed normally via the window), the spawned `shannon` survives.
  Production fix: spawn into its own process group, kill the group on
  `Drop`.
- **Port hard-coded to 1948.** If running from a clone with `npm run dev`
  (port 3000), edit `tauri.conf.json` window url and `SERVER_ADDR` in
  `lib.rs`. Could be made configurable later.
- **Frontend `src/` is dead code.** Could be deleted, but Tauri's bundle
  step might want a `frontendDist` to exist; leaving it for now.

## Useful pointers

- Sidecar logic: `src-tauri/src/lib.rs`
- Window/bundle config: `src-tauri/tauri.conf.json`
- Cargo deps: `src-tauri/Cargo.toml` (only `tauri` + `tauri-plugin-opener`)
- Sibling workspace (the actual app): `../shannon/`
