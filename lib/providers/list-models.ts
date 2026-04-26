// Live model-list fetcher per provider kind. The /api/config/models/[id]
// route uses this to populate the role-row autocomplete; failures surface to
// the user as "Unable to fetch model list: <reason>". No static fallbacks —
// if the provider doesn't expose a list endpoint, the upstream HTTP error is
// what the user sees.

import { readConfig } from "./config";
import { BRAVE_VERTICALS } from "./search-brave";

// Perplexity's plain Sonar API has no /models endpoint. Their /v1/models is a
// separate multi-vendor gateway that returns vendor-prefixed IDs (e.g.
// "perplexity/sonar") which the Sonar /chat/completions path rejects. So we
// short-circuit list-fetch for any provider pointing at api.perplexity.ai
// and surface the static Sonar model set instead.
const PERPLEXITY_MODELS = ["sonar", "sonar-pro", "sonar-reasoning"];

function isPerplexityHost(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname === "api.perplexity.ai";
  } catch {
    return false;
  }
}

export async function listProviderModels(providerId: string): Promise<string[]> {
  const cfg = await readConfig();
  const provider = cfg.providers[providerId];
  if (!provider) throw new Error(`Provider "${providerId}" is not configured.`);
  if (!provider.apiKey) {
    throw new Error(`Provider "${providerId}" has no API key — save it first.`);
  }

  switch (provider.kind) {
    case "anthropic":
      return fetchAnthropicModels(provider.apiKey);
    case "search-perplexity":
      return [...PERPLEXITY_MODELS];
    case "openai-compatible":
      if (isPerplexityHost(provider.baseUrl)) return [...PERPLEXITY_MODELS];
      return fetchOpenAICompatModels(
        provider.apiKey,
        provider.baseUrl ?? "https://api.openai.com/v1",
      );
    case "search-tavily":
      // The "model" field for Tavily is really `search_depth`.
      throw new Error(
        "Tavily has no model list endpoint — set search depth to 'basic' or 'advanced'.",
      );
    case "search-brave":
      // Brave has no discovery endpoint, but our adapter dispatches across
      // verticals (BRAVE_VERTICALS) — return that list so users get a real
      // dropdown of what we support, not a one-line guidance string.
      return [...BRAVE_VERTICALS];
  }
}

async function fetchAnthropicModels(apiKey: string): Promise<string[]> {
  const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });
  if (!res.ok) {
    throw new Error(`Anthropic /v1/models returned ${res.status}: ${await res.text().catch(() => "")}`.trim());
  }
  const json = await res.json();
  const data: { id?: string }[] = Array.isArray(json?.data) ? json.data : [];
  return data.map((m) => m.id).filter((id): id is string => typeof id === "string");
}

async function fetchOpenAICompatModels(apiKey: string, baseUrl: string): Promise<string[]> {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${apiKey}` };

  // Some providers expose only /v1/models (e.g. Perplexity), but legacy user
  // configs save baseUrl without /v1 because their /chat/completions also
  // works without it. Try the literal baseUrl first, then transparently fall
  // back to /v1 — preserves existing configs without forcing a manual edit.
  let url = `${trimmed}/models`;
  let res = await fetch(url, { headers });
  if (res.status === 404 && !/\/v\d+(\/|$)/.test(trimmed)) {
    url = `${trimmed}/v1/models`;
    res = await fetch(url, { headers });
  }

  if (!res.ok) {
    throw new Error(`${url} returned ${res.status}: ${await res.text().catch(() => "")}`.trim());
  }
  const json = await res.json();
  // OpenAI shape: { data: [{ id, ... }] }. Ollama /v1/models matches.
  const data: { id?: string }[] = Array.isArray(json?.data) ? json.data : [];
  return data.map((m) => m.id).filter((id): id is string => typeof id === "string");
}
