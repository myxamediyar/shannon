import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { resolveRole } from "@/lib/providers/resolve";
import { createAnthropic } from "@/lib/providers/anthropic-client";
import { streamAnthropicChat } from "@/lib/chat/stream-anthropic";
import { streamOpenAICompatChat } from "@/lib/chat/stream-openai-compat";
import type { SseEvent } from "@/lib/chat-client";

export async function POST(request: NextRequest) {
  const data = await request.json().catch(() => null);
  if (!data || !data.messages) {
    return NextResponse.json({ status: "error", message: "messages required" }, { status: 400 });
  }

  const messages: { role: string; content: string }[] = data.messages;
  const ephemeral: boolean = !!data.ephemeral;
  const visibleContext: string | undefined = data.visibleContext;
  const visibleImages: { mediaType: string; data: string }[] = data.visibleImages ?? [];
  const sidebarNotes: { id: string; title: string }[] = Array.isArray(data.sidebarNotes)
    ? data.sidebarNotes
    : [];
  const noteTitle: string | undefined =
    typeof data.noteTitle === "string" ? data.noteTitle : undefined;
  for (const msg of messages) {
    if (!["user", "assistant"].includes(msg.role) || typeof msg.content !== "string") {
      return NextResponse.json({ status: "error", message: "Invalid message format" }, { status: 400 });
    }
  }

  const apiMessages: Anthropic.MessageParam[] = messages.map((msg, idx) => {
    const isLastUser = idx === messages.length - 1 && msg.role === "user";
    if (isLastUser) {
      const parts: Anthropic.ContentBlockParam[] = [];
      if (noteTitle) {
        parts.push({
          type: "text",
          text: `<note title="${noteTitle.replace(/"/g, "&quot;")}">\nYou are in a chat inside the note titled above. When the user says "this note", "the canvas", "here", or their current context, they mean this note. Use read_current_note to load its full contents.\n</note>`,
        });
      }
      if (visibleContext) {
        parts.push({
          type: "text",
          text: `<canvas>\nThese are the elements the user currently sees on the whiteboard:\n${visibleContext}\n</canvas>`,
        });
      }
      for (const img of visibleImages) {
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
    }
    return { role: msg.role as "user" | "assistant", content: msg.content };
  });

  let chatRole;
  try {
    chatRole = await resolveRole("chat");
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ status: "error", message }, { status: 500 });
  }
  if (chatRole.kind === "openai-compatible" && !chatRole.baseUrl) {
    return NextResponse.json(
      { status: "error", message: "Chat provider is missing a baseUrl. Edit /model to fix." },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      const emit = (event: SseEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const ctx = { sidebarNotes, emit };

      try {
        if (chatRole.kind === "anthropic") {
          const client = createAnthropic(chatRole.apiKey);
          await streamAnthropicChat({
            client,
            model: chatRole.model,
            messages: apiMessages,
            ephemeral,
            ctx,
          });
        } else {
          await streamOpenAICompatChat({
            apiKey: chatRole.apiKey,
            baseUrl: chatRole.baseUrl!,
            model: chatRole.model,
            messages: apiMessages,
            ephemeral,
            ctx,
          });
        }
        emit({ type: "stop" });
      } catch (e: unknown) {
        emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
