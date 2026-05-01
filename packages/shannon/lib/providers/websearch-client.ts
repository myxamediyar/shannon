// Client-side runWebSearch. Resolves the websearch role from the platform
// config and dispatches to the right adapter with platformFetch as the
// transport.

import { platformFetch } from "@/lib/platform/http";
import { resolveClientRole } from "./resolve-client";
import { perplexitySearch } from "./search-perplexity";
import { tavilySearch } from "./search-tavily";
import { braveSearch } from "./search-brave";

export type WebSearchResult = { answer: string; citations: string[] };

export async function runWebSearchClient(query: string): Promise<WebSearchResult> {
  const role = await resolveClientRole("websearch");
  const fetchImpl = platformFetch as unknown as typeof fetch;

  switch (role.kind) {
    case "search-perplexity": {
      if (!role.baseUrl) throw new Error("Perplexity provider is missing a baseUrl.");
      return perplexitySearch({
        apiKey: role.apiKey,
        baseUrl: role.baseUrl,
        model: role.model,
        query,
        fetchImpl,
      });
    }
    case "search-tavily": {
      if (!role.baseUrl) throw new Error("Tavily provider is missing a baseUrl.");
      return tavilySearch({
        apiKey: role.apiKey,
        baseUrl: role.baseUrl,
        searchDepth: role.model,
        query,
        fetchImpl,
      });
    }
    case "search-brave": {
      if (!role.baseUrl) throw new Error("Brave provider is missing a baseUrl.");
      return braveSearch({
        apiKey: role.apiKey,
        baseUrl: role.baseUrl,
        query,
        vertical: role.model,
        fetchImpl,
      });
    }
    default:
      throw new Error(`Web search not supported for provider kind "${role.kind}".`);
  }
}
