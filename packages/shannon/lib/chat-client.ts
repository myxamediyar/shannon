// Type definitions shared between the chat streaming generator
// (lib/providers/chat-stream.ts) and its consumers (useChatStream,
// stream-anthropic.ts, stream-openai-compat.ts, the tool modules).
//
// Pre-Phase-2b this file also exported openChatStream + readSseEvents +
// postToolCallback + postCompactRequest — the legacy SSE wire-protocol
// helpers. Those are gone now: the stream runs in-process, no HTTP, no SSE.

/** Events streamChat() yields. Same shape the legacy /api/chat route used
 *  to emit over SSE, kept identical so useChatStream's event loop and the
 *  ChatEl message reducer didn't need to change. */
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
  | { type: "stop" };

export type ChatRequestBody = {
  messages: { role: string; content: string }[];
  visibleContext: string;
  visibleImages: { mediaType: string; data: string }[];
  sidebarNotes: { id: string; title: string }[];
  /** Title of the note this chat lives in — surfaced to the LLM so it knows the current context. */
  noteTitle?: string;
  ephemeral?: boolean;
};

export type CompactResponse =
  | {
      status: "ok";
      summary: string;
      newContext: { role: "user" | "assistant"; content: string }[];
      summarizedCount: number;
    }
  | { status: "error"; message: string };
