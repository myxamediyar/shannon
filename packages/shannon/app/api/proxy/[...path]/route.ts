// Generic CORS-bypass proxy. Used in web mode by lib/platform/http.ts when
// isTauri is false — the SPA rewrites provider URLs from
// `https://api.anthropic.com/v1/messages` to
// `/api/proxy/api.anthropic.com/v1/messages`, and this route forwards.
//
// In Tauri mode, lib/platform/http.ts goes through @tauri-apps/plugin-http
// instead and never hits this route.
//
// This route gets replaced by the tiny http server in bin/shannon.js after
// Phase 2e (which serves static out/ + this proxy + /api/config).

import type { NextRequest } from "next/server";

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (path.length === 0) {
    return new Response("missing host", { status: 400 });
  }
  const [host, ...rest] = path;
  const search = new URL(req.url).search;
  const target = `https://${host}/${rest.join("/")}${search}`;

  // Strip the hop-by-hop / origin-bound headers Next adds; forward the rest.
  const headers = new Headers();
  for (const [k, v] of req.headers.entries()) {
    const lk = k.toLowerCase();
    if (
      lk === "host" ||
      lk === "connection" ||
      lk === "content-length" ||
      lk === "x-forwarded-for" ||
      lk === "x-forwarded-proto" ||
      lk === "x-forwarded-host" ||
      lk === "x-real-ip" ||
      lk.startsWith("x-vercel-")
    ) continue;
    headers.set(k, v);
  }

  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    // Required by undici when streaming a request body.
    init.duplex = "half";
  }

  const upstream = await fetch(target, init);

  // Pass through status, headers, and body (streaming preserved).
  const respHeaders = new Headers();
  for (const [k, v] of upstream.headers.entries()) {
    if (k.toLowerCase() === "content-encoding") continue; // upstream already decoded by fetch
    respHeaders.set(k, v);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
export const PATCH = handle;
