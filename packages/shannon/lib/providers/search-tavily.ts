// Tavily search adapter. Tavily exposes POST /search with the API key in the
// JSON body (not a Bearer header). We ask for `include_answer` so the response
// carries a synthesized answer string in addition to source URLs.

import type { SearchResult } from "./search-perplexity";

export async function tavilySearch(params: {
  apiKey: string;
  baseUrl: string;
  /** "basic" | "advanced" — Tavily search depth. Free-form here so unknown
   *  values pass through to the API which returns a clear error. */
  searchDepth?: string;
  query: string;
  fetchImpl?: typeof fetch;
}): Promise<SearchResult> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const url = `${params.baseUrl.replace(/\/+$/, "")}/search`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: params.apiKey,
      query: params.query,
      search_depth: params.searchDepth ?? "basic",
      include_answer: true,
      max_results: 5,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown error");
    throw new Error(`Tavily search failed: ${errText}`);
  }
  const result = await res.json();
  const answer: string = typeof result.answer === "string" && result.answer.length > 0
    ? result.answer
    : Array.isArray(result.results) && result.results.length > 0
      ? result.results.map((r: { title?: string; content?: string }) => `${r.title ?? ""}: ${r.content ?? ""}`).join("\n\n")
      : "No results found.";
  const citations: string[] = Array.isArray(result.results)
    ? (result.results as { url?: string }[]).map((r) => r.url).filter((u): u is string => typeof u === "string")
    : [];
  return { answer, citations };
}
