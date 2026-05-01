// Client-side chat streaming. Replaces the POST /api/chat → SSE flow with a
// direct in-process call: reads config, resolves role, calls the existing
// streamAnthropicChat / streamOpenAICompatChat with platformFetch-backed
// transport, and bridges their emit() callbacks into an AsyncGenerator so
// useChatStream can `for await` the same SseEvent shape it consumed before.

import type Anthropic from "@anthropic-ai/sdk";
import type { SseEvent, ChatRequestBody } from "@/lib/chat-client";
import type { ToolCallbacks } from "@/lib/chat/tools/types";
import { streamAnthropicChat } from "@/lib/chat/stream-anthropic";
import { streamOpenAICompatChat } from "@/lib/chat/stream-openai-compat";
import { createAnthropicBrowser } from "./anthropic-browser";
import { platformFetch } from "@/lib/platform/http";
import { readConfig as readPlatformConfig } from "@/lib/platform/config";
import type { ProviderKind, RoleName } from "./registry";

// Mirror of ShannonConfig from lib/providers/config.ts — duplicated here
// because that file imports node:fs and can't be referenced from client
// bundles.
type ShannonProvider = { kind: ProviderKind; apiKey: string; baseUrl?: string };
type ShannonRole = { provider: string; model: string };
type ShannonConfigShape = {
  providers: Record<string, ShannonProvider>;
  roles: Partial<Record<RoleName, ShannonRole>>;
};

type ResolvedRole = {
  kind: ProviderKind;
  apiKey: string;
  baseUrl?: string;
  model: string;
};

function resolveRoleFromConfig(
  cfg: ShannonConfigShape,
  name: RoleName,
): ResolvedRole {
  const role = cfg.roles[name];
  if (!role) {
    throw new Error(
      `No provider configured for role "${name}". Open /model in the sidebar to set one up.`,
    );
  }
  const provider = cfg.providers[role.provider];
  if (!provider) {
    throw new Error(
      `Role "${name}" points to provider "${role.provider}" which isn't configured. Open /model to fix.`,
    );
  }
  if (!provider.apiKey) {
    throw new Error(
      `Provider "${role.provider}" has no API key. Open /model to add one.`,
    );
  }
  return {
    kind: provider.kind,
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    model: role.model,
  };
}

export async function loadChatRole(): Promise<ResolvedRole> {
  const cfg = await readPlatformConfig<ShannonConfigShape>();
  if (!cfg) {
    throw new Error(
      "No config found. Open /model in the sidebar to set up a chat provider.",
    );
  }
  return resolveRoleFromConfig(cfg, "chat");
}

function buildApiMessages(
  body: ChatRequestBody,
): Anthropic.MessageParam[] {
  return body.messages.map((msg, idx) => {
    const isLastUser = idx === body.messages.length - 1 && msg.role === "user";
    if (!isLastUser) {
      return { role: msg.role as "user" | "assistant", content: msg.content };
    }
    const parts: Anthropic.ContentBlockParam[] = [];
    if (body.noteTitle) {
      parts.push({
        type: "text",
        text: `<note title="${body.noteTitle.replace(/"/g, "&quot;")}">\nYou are in a chat inside the note titled above. When the user says "this note", "the canvas", "here", or their current context, they mean this note. Use read_current_note to load its full contents.\n</note>`,
      });
    }
    if (body.visibleContext) {
      parts.push({
        type: "text",
        text: `<canvas>\nThese are the elements the user currently sees on the whiteboard:\n${body.visibleContext}\n</canvas>`,
      });
    }
    for (const img of body.visibleImages) {
      parts.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
          data: img.data,
        },
      });
    }
    parts.push({ type: "text", text: msg.content });
    return { role: "user" as const, content: parts };
  });
}

export type StreamChatArgs = ChatRequestBody & {
  callbacks: ToolCallbacks;
  signal?: AbortSignal;
};

/**
 * Async generator yielding the same SseEvent shape the legacy /api/chat
 * route emitted. Caller consumes via `for await`. Aborts cleanly on
 * args.signal — the underlying SDK call is cancelled and the generator
 * yields a final "stop" event.
 */
export async function* streamChat(
  args: StreamChatArgs,
): AsyncGenerator<SseEvent> {
  const queue: SseEvent[] = [];
  const wakers: Array<() => void> = [];
  let done = false;

  const wake = () => {
    const pending = wakers.splice(0);
    for (const w of pending) w();
  };

  const emit = (ev: SseEvent) => {
    queue.push(ev);
    wake();
  };

  const apiMessages = buildApiMessages(args);
  const ctx = {
    sidebarNotes: args.sidebarNotes,
    emit,
    ...args.callbacks,
  };

  // Fire the actual chat call as a background task. Errors are surfaced as
  // {type: "error"} events so the consumer's existing handler picks them up.
  void (async () => {
    try {
      if (args.signal?.aborted) {
        emit({ type: "stop" });
        return;
      }
      const role = await loadChatRole();
      if (role.kind === "anthropic") {
        const client = createAnthropicBrowser(role.apiKey);
        await streamAnthropicChat({
          client,
          model: role.model,
          messages: apiMessages,
          ephemeral: !!args.ephemeral,
          ctx,
        });
      } else if (role.kind === "openai-compatible") {
        if (!role.baseUrl) {
          throw new Error(
            "OpenAI-compatible provider is missing a baseUrl. Edit /model to fix.",
          );
        }
        await streamOpenAICompatChat({
          apiKey: role.apiKey,
          baseUrl: role.baseUrl,
          model: role.model,
          messages: apiMessages,
          ephemeral: !!args.ephemeral,
          ctx,
          fetchImpl: platformFetch as unknown as typeof fetch,
        });
      } else {
        throw new Error(`Unsupported chat provider kind: ${role.kind}`);
      }
      emit({ type: "stop" });
    } catch (e) {
      emit({
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      done = true;
      wake();
    }
  })();

  while (!done || queue.length > 0) {
    if (args.signal?.aborted) return;
    if (queue.length === 0) {
      await new Promise<void>((resolve) => {
        wakers.push(resolve);
      });
      continue;
    }
    while (queue.length > 0) {
      yield queue.shift()!;
    }
  }
}
