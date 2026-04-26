import { NextRequest, NextResponse } from "next/server";
import { resolveRole } from "@/lib/providers/resolve";
import { createAnthropic } from "@/lib/providers/anthropic-client";
import { compactContext } from "@/lib/chat/compaction";
import type { ChatContextMessage } from "@/lib/canvas-types";

/** POST /api/chat/compact
 *  Body: { history: ChatContextMessage[], keepLastN?: number }
 *  Returns: { summary, newContext, summarizedCount }
 *
 *  Caller (client) is responsible for replacing its chatHistoriesRef + ChatEl.contextMessages
 *  with newContext, and appending a UI marker to ChatEl.messages. */
export async function POST(request: NextRequest) {
  const data = await request.json().catch(() => null);
  if (!data || !Array.isArray(data.history)) {
    return NextResponse.json({ status: "error", message: "history required" }, { status: 400 });
  }

  const history: ChatContextMessage[] = data.history;
  for (const m of history) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") {
      return NextResponse.json({ status: "error", message: "Invalid history entry" }, { status: 400 });
    }
  }
  const keepLastN: number = typeof data.keepLastN === "number" && data.keepLastN >= 0 ? data.keepLastN : 4;

  let chatRole;
  try {
    chatRole = await resolveRole("chat");
  } catch (e: unknown) {
    return NextResponse.json({ status: "error", message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  // Compaction is a single non-tool LLM call. Anthropic only — the OpenAI-compat
  // path can be added later if there's demand. For now, gate clearly.
  if (chatRole.kind !== "anthropic") {
    return NextResponse.json(
      { status: "error", message: "Compaction currently requires an Anthropic provider for chat." },
      { status: 400 },
    );
  }

  try {
    const client = createAnthropic(chatRole.apiKey);
    const result = await compactContext({
      client,
      model: chatRole.model,
      history,
      keepLastN,
    });
    return NextResponse.json({ status: "ok", ...result });
  } catch (e: unknown) {
    return NextResponse.json({ status: "error", message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
