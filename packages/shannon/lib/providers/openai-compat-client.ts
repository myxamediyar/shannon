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
};

export async function openAICompatChat(req: OpenAICompatRequest): Promise<Response> {
  const url = `${req.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return fetch(url, {
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
