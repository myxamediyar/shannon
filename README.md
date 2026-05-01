# Shannon

A local-first, BYOK ("bring your own keys") AI whiteboard. Infinite canvas for
notes, chat, drawings, math, graphs, charts, tables, PDFs, and embeds — with
your chosen LLM and search providers wired in. Notes and files live on your
machine; the only network calls are to the providers you configure.

## Demo

[![Shannon demo](https://img.youtube.com/vi/HoNoBNYV194/maxresdefault.jpg "▶ Watch the demo on YouTube")](https://youtu.be/HoNoBNYV194)

## Quick start

Install globally and run from anywhere:

```bash
npm install -g tryshannon
shannon              # http://localhost:1948
```

Or run without installing:

```bash
npx tryshannon
```

Or, from a clone (for hacking on it):

```bash
npm install
npm run build && npm start -w packages/shannon   # http://localhost:1948
# or, for the chromeless desktop window:
npm run tauri:dev
```

`npm run dev` (Next on :3000) also works for pure UI/visual changes, but
provider calls and note persistence go through the small CLI in
[`packages/shannon/bin/shannon.js`](packages/shannon/bin/shannon.js), so
anything network- or storage-touching needs `npm start` (or Tauri).

The default port (1948) is the year of Shannon's *A Mathematical Theory
of Communication*. Override per run with `PORT=1234 shannon`.

Then open the app, go to **Model** in the sidebar, paste your API keys, and
assign them to the **Chat** and **Web Search** roles. Keys are written to
`~/.shannon/config.json` (mode 0600) and stay on the machine — outbound
traffic only goes to the providers you configured.

The home page is a live cheat-sheet of every tool, command, and shortcut.

## What's in it

- **Canvas elements** — text, shapes, freehand drawing, arrows, images,
  PDFs (paginated viewer), Google Docs/Sheets/Slides + YouTube embeds,
  charts, math (KaTeX), 2D graphs, tables, checklists, AI chats, and
  cross-note links.
- **Slash commands** — typed inside any text fragment. Spawn chats
  (`/chat`, `/q`, `/sideq`, `/sidechat`, `/compact`), shapes
  (`/rectangle`, `/circle`, `/triangle`, `/arrow`), math and graphs
  (`/math`, `/graph`), tables, checklists, files, embeds, and prints.
- **AI tools** — the chat model can create canvas elements directly
  (`create_chart`, `create_graph`, `create_math`, …), search the web,
  rasterize selected shapes, and read PDFs, embeds, and other notes.
- **Import / export** — round-trippable `.shannon` snapshots (note +
  inlined blobs) or self-contained static `.html`.
- **Themes & backgrounds** — light/dark, custom canvas backgrounds with
  blur / grayscale / opacity, expanded toolbar toggles.

## Provider support

Configure each role independently. Templates ship for:

- **Chat**: Anthropic (Claude), OpenAI, OpenRouter, Groq, Together,
  Ollama, Perplexity, plus a Custom OpenAI-compatible base URL.
- **Web search**: Perplexity, Tavily, Brave.

Anthropic uses the official SDK; everything else speaks the
OpenAI-compatible chat-completions shape.

## Desktop app

A native Tauri 2 wrapper lives at [`packages/shannon-desktop`](packages/shannon-desktop).
It loads the prebuilt static SPA over a `tauri://localhost` custom
protocol — no Node server, no Next runtime — and talks to the
filesystem and provider HTTP endpoints directly through the Tauri FS
and HTTP plugins. Run from source with `npm run tauri:dev`; build a
distributable binary with `npm run tauri:build`. See
[`packages/shannon-desktop/docs/PORTED.md`](packages/shannon-desktop/docs/PORTED.md)
for the design notes.

## Stack

Next.js 16 (App Router, exported as a static SPA) · React 18 ·
TypeScript · Tailwind · `@anthropic-ai/sdk` · Tiptap (rich text) ·
KaTeX + `mathjs` · Chart.js · `pdfjs-dist` · `rbush` (spatial index) ·
filesystem-backed storage under `~/.shannon/`.

There is no separate Next backend. The npm distribution ships a tiny
~400-line Node CLI ([`bin/shannon.js`](packages/shannon/bin/shannon.js))
that serves `out/` and exposes a few CORS-bypass / filesystem routes;
the Tauri distribution doesn't even use that — the SPA hits FS and
HTTP directly via Tauri plugins.

## Storage

Everything lives in `~/.shannon/` on the user's machine. Same layout in
both npm and Tauri modes (the npm CLI just proxies file I/O for the
browser).

| Path | What |
| ---- | ---- |
| `~/.shannon/notes/<id>.shannon` | one JSON file per note (image/PDF `src` stripped) |
| `~/.shannon/blobs/<id>` | image and PDF blob payloads (data-URL text) |
| `~/.shannon/folders.json` | folder tree |
| `~/.shannon/note-counter.json` | running "Note #N" title counter |
| `~/.shannon/backgrounds.json` | custom canvas-background metadata (blobs share `~/.shannon/blobs/`) |
| `~/.shannon/config.json` | provider keys (mode 0600 in a 0700 dir) |
| `~/.shannon/recents.json` | Tauri-only — File → Open Recent menu |
| `localStorage` | UI-only settings (theme, toolbar, dot grid, …) — per browser, not synced |

Nothing is uploaded anywhere. Open a note in another browser or on
another machine by exporting it as `.shannon` and importing on the
other side, or copy `~/.shannon/notes/` directly.

> **One mode at a time.** Both `shannon` (npm) and the desktop app
> read and write the same files under `~/.shannon/`, but neither
> watches the directory or holds a lock. Running both simultaneously
> can produce torn writes. Close one before opening the other.

## Project layout

The repo is an npm-workspaces monorepo. Source lives under
[`packages/shannon`](packages/shannon) (the published npm package) and
[`packages/shannon-desktop`](packages/shannon-desktop) (the Tauri shell).

Inside `packages/shannon/`:

```
app/                Next.js pages (no API routes — SPA-only)
  page.tsx          locked dashboard (the cheat-sheet view)
  notes/            sidebar + per-note canvas
  model/            provider config UI
  settings/         theme, background, toolbar, draw mode
bin/
  shannon.js        npm CLI: serves out/ + /api/{proxy,config,notes,blobs,…}
components/
  NotesCanvas.tsx   top-level canvas
  canvas/           per-element containers + toolbars
lib/
  canvas-*.ts       per-feature ops (drags, history, serialize, exports, …)
  chat/             client-side streaming, tool schemas, compaction
  providers/        registry, role resolution, per-provider adapters
  platform/         filesystem & fetch shims (Tauri plugins ↔ npm CLI)
hooks/              React hooks (history, pan/zoom, chat stream, marquee)
```

Inside `packages/shannon-desktop/`:

```
src-tauri/          Rust shell — menu wiring, recents IPC, print helper window
src-tauri/capabilities/default.json   permissions (FS scope, allowed HTTP hosts)
```

## Contributing

Issues and PRs welcome. Before opening a PR:

```bash
npm install         # workspace install (hoists deps to root)
npm run build       # Next.js + TS will surface most regressions
```

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
