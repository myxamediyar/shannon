// Client-side model-list fetcher per provider kind. Replaces the
// /api/config/models/[id] route — the /model page calls this directly
// instead of going through HTTP. Uses platformFetch so calls work in
// both Tauri (http plugin) and web (rewrite to /api/proxy) modes.

import { platformFetch } from "@/lib/platform/http";
import { readConfig } from "@/lib/platform/config";
import { BRAVE_VERTICALS } from "./search-brave";
import type { ProviderKind, RoleName } from "./registry";

type ShannonProvider = { kind: ProviderKind; apiKey: string; baseUrl?: string };
type ShannonRole = { provider: string; model: string };
type ShannonConfigShape = {
  providers: Record<string, ShannonProvider>;
  roles: Partial<Record<RoleName, ShannonRole>>;
};

// Perplexity's plain Sonar API has no /models endpoint.
const PERPLEXITY_MODELS = ["sonar", "sonar-pro", "sonar-reasoning"];

function isPerplexityHost(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname === "api.perplexity.ai";
  } catch {
    return false;
  }
}

export async function listProviderModelsClient(
  providerId: string,
): Promise<string[]> {
  const cfg = await readConfig<ShannonConfigShape>();
  if (!cfg) {
    throw new Error("No config found. Save your provider settings first.");
  }
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
      throw new Error(
        "Tavily has no model list endpoint — set search depth to 'basic' or 'advanced'.",
      );
    case "search-brave":
      return [...BRAVE_VERTICALS];
  }
}

async function fetchAnthropicModels(apiKey: string): Promise<string[]> {
  const res = await platformFetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });
  if (!res.ok) {
    throw new Error(
      `Anthropic /v1/models returned ${res.status}: ${await res.text().catch(() => "")}`.trim(),
    );
  }
  const json = await res.json();
  const data: { id?: string }[] = Array.isArray(json?.data) ? json.data : [];
  return data.map((m) => m.id).filter((id): id is string => typeof id === "string");
}

async function fetchOpenAICompatModels(
  apiKey: string,
  baseUrl: string,
): Promise<string[]> {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${apiKey}` };

  let url = `${trimmed}/models`;
  let res = await platformFetch(url, { headers });
  if (res.status === 404 && !/\/v\d+(\/|$)/.test(trimmed)) {
    url = `${trimmed}/v1/models`;
    res = await platformFetch(url, { headers });
  }

  if (!res.ok) {
    throw new Error(
      `${url} returned ${res.status}: ${await res.text().catch(() => "")}`.trim(),
    );
  }
  const json = await res.json();
  const data: { id?: string }[] = Array.isArray(json?.data) ? json.data : [];
  return data.map((m) => m.id).filter((id): id is string => typeof id === "string");
}
