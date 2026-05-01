// Perplexity Sonar search adapter. Perplexity speaks the OpenAI chat-completions
// shape; it returns a `citations` array alongside `choices[0].message.content`,
// which is what makes it useful as a search-with-citations backend.

import { openAICompatChat } from "./openai-compat-client";

export type SearchResult = { answer: string; citations: string[] };

export async function perplexitySearch(params: {
  apiKey: string;
  baseUrl: string;
  model: string;
  query: string;
}): Promise<SearchResult> {
  const res = await openAICompatChat({
    apiKey: params.apiKey,
    baseUrl: params.baseUrl,
    model: params.model,
    messages: [
      {
        role: "system",
        content:
          "You are a helpful research assistant. Answer the user's question accurately and cite your sources.",
      },
      { role: "user", content: params.query },
    ],
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "Unknown error");
    throw new Error(`Perplexity search failed: ${errText}`);
  }
  const result = await res.json();
  const answer = result.choices?.[0]?.message?.content ?? "No results found.";
  const citations: string[] = Array.isArray(result.citations) ? result.citations : [];
  return { answer, citations };
}
