export type OpenAICompatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export type OpenAICompatRequest = {
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: OpenAICompatMessage[];
  temperature?: number;
  stream?: boolean;
  /** Caller-provided fetch — lets the SPA route through platformFetch
   *  (Tauri http plugin in desktop, /api/proxy in web). Defaults to global
   *  fetch for the legacy server-side callers. */
  fetchImpl?: typeof fetch;
};

export async function openAICompatChat(req: OpenAICompatRequest): Promise<Response> {
  const fetchImpl = req.fetchImpl ?? fetch;
  const url = `${req.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${req.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.stream ? { stream: true } : {}),
    }),
  });
}
