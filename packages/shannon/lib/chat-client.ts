import { BACKEND } from "./canvas-types";

/** SSE payload types the /api/chat endpoint emits. Keep in sync with the backend. */
export type SseEvent =
  | { type: "delta"; text: string }
  | {
      type: "input_tokens";
      tokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      contextWindow?: number | null;
      /** Most recent turn's input size (used / contextWindow for the indicator).
       *  NOT summed across loop iterations or chat turns. */
      lastTurnInputTokens?: number;
    }
  | {
      type: "usage";
      tokens: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      contextWindow?: number | null;
      lastTurnInputTokens?: number;
    }
  | { type: "citations"; citations: string[] }
  | { type: "canvas_command"; command: string; args: Record<string, unknown> }
  | { type: "tool_status"; status: string | null }
  | { type: "error"; message: string }
  | { type: "stop" }
  | { type: "rasterize_shapes"; callbackId: string }
  | { type: "read_pdf_page"; callbackId: string; filename: string; page: number }
  | { type: "read_note"; callbackId: string; noteId: string }
  | { type: "read_current_note"; callbackId: string }
  | { type: "read_chat"; callbackId: string; chatNumber: number; offset: number; count: number };

export type ChatRequestBody = {
  messages: { role: string; content: string }[];
  visibleContext: string;
  visibleImages: { mediaType: string; data: string }[];
  sidebarNotes: { id: string; title: string }[];
  /** Title of the note this chat lives in — surfaced to the LLM so it knows the current context. */
  noteTitle?: string;
  ephemeral?: boolean;
};

/** Fire the /api/chat request and return the response (caller reads the body stream). */
export async function openChatStream(body: ChatRequestBody, signal: AbortSignal): Promise<Response> {
  return fetch(`${BACKEND}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

/** Async iterator over SSE events from a response body. Caller handles aborts. */
export async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop()!;
    for (const chunk of chunks) {
      if (!chunk.startsWith("data: ")) continue;
      yield JSON.parse(chunk.slice(6)) as SseEvent;
    }
  }
}

/** POST a tool-callback result back to the server so the pending tool-use
 *  Promise in the chat route resumes. Used by any client-side tool:
 *  rasterize_shapes, read_pdf_pages, read_note, read_current_note, read_chat. */
export async function postToolCallback(callbackId: string, payload: string): Promise<void> {
  await fetch(`${BACKEND}/chat/tool-callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callbackId, payload }),
  });
}

export type CompactResponse = {
  status: "ok";
  summary: string;
  newContext: { role: "user" | "assistant"; content: string }[];
  summarizedCount: number;
} | { status: "error"; message: string };

/** POST a chat history slice to the compaction endpoint. Returns the synthesized
 *  summary + replacement context. Caller persists the result. */
export async function postCompactRequest(
  history: { role: "user" | "assistant"; content: string }[],
  keepLastN = 4,
): Promise<CompactResponse> {
  const res = await fetch(`${BACKEND}/chat/compact`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ history, keepLastN }),
  });
  return (await res.json()) as CompactResponse;
}
