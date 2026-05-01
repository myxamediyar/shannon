# Shannon

A local-first, BYOK ("bring your own keys") AI whiteboard. Infinite
canvas for notes, chat, drawings, math, graphs, charts, tables, PDFs,
and embeds — with your chosen LLM and search providers wired in.

## Install

```bash
npm install -g tryshannon
shannon              # http://localhost:1948
```

Or run without installing:

```bash
npx tryshannon
```

The default port (1948) is the year of Shannon's *A Mathematical Theory
of Communication*. Override with `PORT=1234 shannon`.

After launch, open the app, go to **Model** in the sidebar, and paste
your provider API keys. Keys live in `~/.shannon/config.json` (mode 0600)
and never leave your machine except as outbound calls to the provider.

## Full docs, source, demo, and desktop app

Everything else — feature list, provider matrix, storage details, contributing,
and the Tauri desktop wrapper — lives in the repo:

→ **<https://github.com/myxamediyar/shannon>**

## License

Apache 2.0.
