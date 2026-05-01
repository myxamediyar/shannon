#!/usr/bin/env node

// Shannon's npm CLI shell. Three responsibilities:
//   1. Serve the prebuilt static SPA from out/.
//   2. /api/proxy/<host>/<path> — CORS-bypass proxy the SPA hits when
//      isTauri is false (Anthropic, OpenAI, etc. don't allow direct
//      browser calls). In Tauri mode the SPA bypasses CORS via
//      tauri-plugin-http and never touches this route.
//   3. /api/config GET/POST — read/write ~/.shannon/config.json (mode
//      0600 in a 0700 directory). Same pattern.
//
// Auto-opens the URL in the user's default browser unless
// SHANNON_NO_OPEN=1 is set. Listens on 1948 unless overridden.

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { Readable } = require("node:stream");
const { spawn } = require("node:child_process");

const PORT = parseInt(process.env.PORT || process.env.SHANNON_PORT || "1948", 10);
const HOST = process.env.HOST || process.env.SHANNON_HOST || "127.0.0.1";
const URL_DISPLAY = `http://localhost:${PORT}`;

const STATIC_DIR = path.resolve(__dirname, "..", "out");
const CONFIG_DIR = path.join(os.homedir(), ".shannon");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function safeJoin(base, requestPath) {
  // Path traversal guard: resolve, then assert the result stays within base.
  const resolved = path.resolve(base, "." + requestPath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

async function tryFile(absPath) {
  try {
    const stat = await fsp.stat(absPath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const pathname = decodeURIComponent(url.pathname);
  const candidatePaths = pathname === "/"
    ? ["/index.html"]
    : [pathname, pathname + ".html", path.posix.join(pathname, "index.html")];

  for (const cand of candidatePaths) {
    const abs = safeJoin(STATIC_DIR, cand);
    if (!abs) continue;
    const stat = await tryFile(abs);
    if (!stat) continue;
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    });
    fs.createReadStream(abs).pipe(res);
    return;
  }

  // SPA fallback: serve 404 page if Next produced one, else a minimal 404.
  const notFound = safeJoin(STATIC_DIR, "/404.html");
  if (notFound) {
    const stat = await tryFile(notFound);
    if (stat) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      fs.createReadStream(notFound).pipe(res);
      return;
    }
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("404 Not Found");
}

async function handleProxy(req, res, hostAndPath, search) {
  const target = `https://${hostAndPath}${search}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    const lk = k.toLowerCase();
    if (lk === "host" || lk === "connection" || lk === "content-length") continue;
    if (Array.isArray(v)) v.forEach((val) => headers.append(k, val));
    else headers.set(k, v);
  }
  const init = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = Readable.toWeb(req);
    init.duplex = "half";
  }
  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end(`Upstream fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const respHeaders = {};
  for (const [k, v] of upstream.headers.entries()) {
    if (k.toLowerCase() === "content-encoding") continue; // body's already decoded
    respHeaders[k] = v;
  }
  res.writeHead(upstream.status, respHeaders);
  if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
  else res.end();
}

async function handleConfigGet(_req, res) {
  try {
    const raw = await fsp.readFile(CONFIG_PATH, "utf8");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(raw);
  } catch (e) {
    if (e && e.code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end("null");
      return;
    }
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }
}

async function handleConfigPost(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  try {
    JSON.parse(body); // validate shape (caller is responsible for content)
    await fsp.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${CONFIG_PATH}.tmp`;
    await fsp.writeFile(tmp, body, { mode: 0o600 });
    await fsp.rename(tmp, CONFIG_PATH);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }
}

const server = http.createServer((req, res) => {
  (async () => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/proxy/")) {
        const hostAndPath = url.pathname.slice("/api/proxy/".length);
        return handleProxy(req, res, hostAndPath, url.search);
      }
      if (url.pathname === "/api/config") {
        if (req.method === "GET") return handleConfigGet(req, res);
        if (req.method === "POST" || req.method === "PUT") return handleConfigPost(req, res);
        res.writeHead(405, { "Content-Type": "text/plain" });
        return res.end("method not allowed");
      }
      return serveStatic(req, res);
    } catch (e) {
      console.error("shannon:", e);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`Shannon ready at ${URL_DISPLAY}`);
  if (process.env.SHANNON_NO_OPEN !== "1") {
    setTimeout(() => {
      if (process.platform === "darwin") {
        spawn("open", [URL_DISPLAY], { stdio: "ignore", detached: true }).unref();
      } else if (process.platform === "win32") {
        spawn("cmd", ["/c", "start", "", URL_DISPLAY], { stdio: "ignore", detached: true }).unref();
      } else {
        spawn("xdg-open", [URL_DISPLAY], { stdio: "ignore", detached: true }).unref();
      }
    }, 500);
  }
});

const shutdown = (signal) => () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(signal === "SIGINT" ? 130 : 143), 2000).unref();
};
process.on("SIGINT", shutdown("SIGINT"));
process.on("SIGTERM", shutdown("SIGTERM"));
