import { isTauri } from "./index";

// Drop-in replacement for `fetch`. In Tauri, routes through the native HTTP
// plugin (Rust does the request, no CORS). In web, rewrites the URL to
// `/api/proxy/<host>/<path>` so the npm CLI shell can proxy past CORS.
export async function platformFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  if (isTauri) {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    return tauriFetch(url, init);
  }
  const u = new URL(url);
  return fetch(`/api/proxy/${u.host}${u.pathname}${u.search}`, init);
}
