// Brave Search adapter. Brave exposes several verticals at /res/v1/<vertical>/search;
// they share the X-Subscription-Token auth but each vertical has a slightly
// different response shape that we flatten into our { answer, citations } contract.

import type { SearchResult } from "./search-perplexity";

/** Verticals we know how to parse. The "model" field on the websearch role
 *  picks one of these. Update both lists in lockstep. */
export const BRAVE_VERTICALS = ["web", "news"] as const;
export type BraveVertical = (typeof BRAVE_VERTICALS)[number];

export async function braveSearch(params: {
  apiKey: string;
  baseUrl: string;
  query: string;
  /** "web" | "news" — defaults to "web" if omitted or unknown. */
  vertical?: string;
  fetchImpl?: typeof fetch;
}): Promise<SearchResult> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const vertical = (BRAVE_VERTICALS as readonly string[]).includes(params.vertical ?? "")
    ? (params.vertical as BraveVertical)
    : "web";
  const path = `/${vertical}/search`;
  const url = `${params.baseUrl.replace(/\/+$/, "")}${path}?q=${encodeURIComponent(params.query)}&count=5`;
  const res = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": params.apiKey,
    },
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown error");
    throw new Error(`Brave ${vertical} search failed: ${errText}`);
  }
  const result = await res.json();

  if (vertical === "web") {
    const results: { title?: string; url?: string; description?: string }[] =
      result?.web?.results ?? [];
    return formatResults(results);
  }
  // news: flatter shape, results live at the top level
  const results: { title?: string; url?: string; description?: string }[] =
    Array.isArray(result?.results) ? result.results : [];
  return formatResults(results);
}

function formatResults(
  results: { title?: string; url?: string; description?: string }[],
): SearchResult {
  if (results.length === 0) return { answer: "No results found.", citations: [] };
  const answer = results
    .map((r, i) => `[${i + 1}] ${r.title ?? ""}\n${r.description ?? ""}`)
    .join("\n\n");
  const citations = results
    .map((r) => r.url)
    .filter((u): u is string => typeof u === "string");
  return { answer, citations };
}
