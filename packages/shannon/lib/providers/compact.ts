// Client-side compaction. Replaces POST /api/chat/compact with a direct
// Anthropic SDK call (browser mode + platformFetch).

import { compactContext } from "@/lib/chat/compaction";
import type { ChatContextMessage } from "@/lib/canvas-types";
import type { CompactResponse } from "@/lib/chat-client";
import { createAnthropicBrowser } from "./anthropic-browser";
import { loadChatRole } from "./chat-stream";

export async function compactChat(
  history: ChatContextMessage[],
  keepLastN = 4,
): Promise<CompactResponse> {
  try {
    const role = await loadChatRole();
    if (role.kind !== "anthropic") {
      return {
        status: "error",
        message: "Compaction currently requires an Anthropic provider for chat.",
      };
    }
    const client = createAnthropicBrowser(role.apiKey);
    const result = await compactContext({
      client,
      model: role.model,
      history,
      keepLastN,
    });
    return { status: "ok", ...result };
  } catch (e) {
    return {
      status: "error",
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
