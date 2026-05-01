# Shannon

A local-first, BYOK AI whiteboard. Infinite canvas for notes, chat,
drawings, math, graphs, charts, tables, PDFs, and embeds — with your
chosen LLM and search providers wired in. Notes and files live on your
machine; the only network calls are to the providers you configure.

## Demo

[![Shannon demo](https://img.youtube.com/vi/HoNoBNYV194/maxresdefault.jpg "▶ Watch the demo on YouTube")](https://youtu.be/HoNoBNYV194)

## Packages in this repo

| Path | What it is |
| ---- | ---------- |
| [`packages/shannon`](packages/shannon) | The Next.js app, published to npm as **`tryshannon`**. This is the canonical install. |
| [`packages/shannon-desktop`](packages/shannon-desktop) | A Tauri 2 desktop shell that wraps the npm package as a native app. |

## Quick start (npm)

```bash
npm install -g tryshannon
shannon              # http://localhost:1948
```

Or run without installing:

```bash
npx tryshannon
```

See [`packages/shannon/README.md`](packages/shannon/README.md) for full
features, provider setup, and storage details.

## Working in this repo

```bash
npm install                  # installs both packages (hoisted)
npm run dev                  # boots packages/shannon at :3000
npm run tauri:dev            # boots packages/shannon-desktop
```

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
