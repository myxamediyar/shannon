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
npm run dev          # http://localhost:3000
```

The default port (1948) is the year of Shannon's *A Mathematical Theory
of Communication*. Override per run with `PORT=1234 shannon`.

Then open the app, go to **Model** in the sidebar, paste your API keys, and
assign them to the **Chat** and **Web Search** roles. Keys are written to
`~/.shannon/config.json` (mode 0600) on the machine running `next` — they
never leave it except as outbound calls to the provider you picked.

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

## Stack

Next.js 16 (App Router) · React 18 · TypeScript · Tailwind ·
`@anthropic-ai/sdk` · Tiptap (rich text) · KaTeX + `mathjs` · Chart.js ·
`pdfjs-dist` · `rbush` (spatial index) · localStorage + IndexedDB.

There is no separate backend — every server route lives under `app/api/`.

## Storage

| Where | What |
| ----- | ---- |
| `localStorage` | notes, folders, settings |
| `IndexedDB` | image and PDF blobs, custom backgrounds |
| `~/.shannon/config.json` | provider keys (mode 0600 in a 0700 dir) |

Nothing is uploaded anywhere. Open a note in another browser by exporting
it as `.shannon` and importing on the other side.

## Project layout

```
app/                Next.js pages and API routes
  page.tsx          locked dashboard (the cheat-sheet view)
  notes/            sidebar + per-note canvas
  model/            provider config UI
  settings/         theme, background, toolbar, draw mode
  api/              chat, websearch, config, submit, tool-callback
components/
  NotesCanvas.tsx   top-level canvas
  canvas/           per-element containers + toolbars
lib/
  canvas-*.ts       per-feature ops (drags, history, serialize, exports, …)
  chat/             streaming, tool schemas, compaction
  providers/        registry, role resolution, per-provider adapters
hooks/              React hooks (history, pan/zoom, chat stream, marquee)
```

## Contributing

Issues and PRs welcome. Before opening a PR:

```bash
npm run build       # Next.js + TS will surface most regressions
```

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
