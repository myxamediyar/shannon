// Browser-mode Anthropic SDK client. Used by lib/providers/chat-stream.ts
// (and lib/providers/compact.ts) to call Anthropic from the SPA without a
// server proxy. The SDK's custom `fetch` hook lets platformFetch handle the
// transport switch (Tauri http plugin vs /api/proxy fetch).

import Anthropic from "@anthropic-ai/sdk";
import { platformFetch } from "@/lib/platform/http";

export function createAnthropicBrowser(apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    // Required for any browser context. Shannon is BYOK with the user's own
    // key going to the user's own machine — the warning's threat model
    // (server-leaked keys to untrusted clients) doesn't apply here.
    dangerouslyAllowBrowser: true,
    fetch: platformFetch as unknown as typeof fetch,
  });
}
