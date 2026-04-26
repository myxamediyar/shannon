import { resolveRole } from "./providers/resolve";
import { perplexitySearch } from "./providers/search-perplexity";
import { tavilySearch } from "./providers/search-tavily";
import { braveSearch } from "./providers/search-brave";

export type WebSearchResult = { answer: string; citations: string[] };

/** Dispatch a web-search query to the configured provider. Each kind speaks
 *  a different protocol — Perplexity pretends to be OpenAI chat completions,
 *  Tavily POSTs JSON, Brave GETs with a header — so we keep one adapter per
 *  kind in lib/providers/search-*. */
export async function runWebSearch(query: string): Promise<WebSearchResult> {
  const role = await resolveRole("websearch");

  switch (role.kind) {
    case "search-perplexity": {
      if (!role.baseUrl) throw new Error("Perplexity provider is missing a baseUrl.");
      return perplexitySearch({
        apiKey: role.apiKey,
        baseUrl: role.baseUrl,
        model: role.model,
        query,
      });
    }
    case "search-tavily": {
      if (!role.baseUrl) throw new Error("Tavily provider is missing a baseUrl.");
      return tavilySearch({
        apiKey: role.apiKey,
        baseUrl: role.baseUrl,
        searchDepth: role.model,
        query,
      });
    }
    case "search-brave": {
      if (!role.baseUrl) throw new Error("Brave provider is missing a baseUrl.");
      return braveSearch({
        apiKey: role.apiKey,
        baseUrl: role.baseUrl,
        query,
        vertical: role.model,
      });
    }
    default:
      throw new Error(`Web search not supported for provider kind "${role.kind}".`);
  }
}
