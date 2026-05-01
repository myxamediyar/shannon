// Compaction = "summarize the older slice of chat.contextMessages, keep the
// last N verbatim, write back". Single source of truth: chat.contextMessages.
// The runtime chatHistoriesRef is updated as a side effect so the next submit
// uses the compacted state.

import type { RefObject } from "react";
import { compactChat } from "../providers/compact";
import type { ChatContextMessage, ChatEl, ChatMessage } from "../canvas-types";

export type CompactArgs = {
  chat: ChatEl;
  chatMutate: (chatElId: string, fn: (chat: ChatEl) => ChatEl) => void;
  /** Optional — kept in sync so the next request uses the compacted history. */
  chatHistoriesRef?: RefObject<Map<string, ChatContextMessage[]>>;
  /** Trailing messages to keep verbatim (default 2). */
  keepLastN?: number;
};

export type CompactResult =
  | { ok: true; summarizedCount: number }
  | { ok: false; summarizedCount: 0; error: string };

/** Build the LLM-visible history from the chat. Prefers persisted
 *  contextMessages; falls back to the UI log filtered for non-marker entries. */
function readHistory(chat: ChatEl): ChatContextMessage[] {
  if (chat.contextMessages && chat.contextMessages.length > 0) {
    return chat.contextMessages.map((m) => ({ role: m.role, content: m.content }));
  }
  return chat.messages
    .filter((m) => !m.kind && m.content && m.content !== "…")
    .map((m) => ({ role: m.role, content: m.content }));
}

export async function compactChatHistory(args: CompactArgs): Promise<CompactResult> {
  const { chat, chatMutate, chatHistoriesRef } = args;
  const history = readHistory(chat);
  if (history.length < 2) {
    return { ok: false, summarizedCount: 0, error: "Not enough history to compact." };
  }
  const keepLastN = Math.min(args.keepLastN ?? 2, history.length - 1);

  // Mount a placeholder so the working indicator has an assistant message to
  // attach to; gate the input via toolStatus until teardown.
  const placeholder: ChatMessage = { role: "assistant", content: "…", kind: "compacting" };
  chatMutate(chat.id, (c) => ({
    ...c,
    toolStatus: "Compacting…",
    messages: [...c.messages, placeholder],
  }));

  const stripPlaceholder = (msgs: ChatMessage[]) =>
    msgs.filter((m) => m.kind !== "compacting");

  let res;
  try {
    res = await compactChat(history, keepLastN);
  } catch (e) {
    chatMutate(chat.id, (c) => ({ ...c, toolStatus: null, messages: stripPlaceholder(c.messages) }));
    return { ok: false, summarizedCount: 0, error: e instanceof Error ? e.message : String(e) };
  }
  if (res.status !== "ok") {
    chatMutate(chat.id, (c) => ({ ...c, toolStatus: null, messages: stripPlaceholder(c.messages) }));
    return { ok: false, summarizedCount: 0, error: res.message };
  }
  if (res.summarizedCount === 0) {
    chatMutate(chat.id, (c) => ({ ...c, toolStatus: null, messages: stripPlaceholder(c.messages) }));
    return { ok: false, summarizedCount: 0, error: "Compaction returned no summary." };
  }

  const newContext: ChatContextMessage[] = res.newContext.map((m) => ({ role: m.role, content: m.content }));
  // Keep the runtime cache aligned so the next submit reads the compacted state.
  chatHistoriesRef?.current?.set(chat.chatId, [...newContext]);
  // Estimate the post-compaction context size for the HUD; the next real turn
  // overwrites with the model's reported input_tokens.
  const estimatedTokens = Math.ceil(
    newContext.reduce((sum, m) => sum + m.content.length, 0) / 4,
  );
  chatMutate(chat.id, (c) => {
    const marker: ChatMessage = {
      role: "assistant",
      content: "",
      kind: "compaction",
      summarizedCount: res.summarizedCount,
    };
    return {
      ...c,
      toolStatus: null,
      contextMessages: newContext,
      lastTurnInputTokens: estimatedTokens,
      messages: [...stripPlaceholder(c.messages), marker],
    };
  });
  return { ok: true, summarizedCount: res.summarizedCount };
}
