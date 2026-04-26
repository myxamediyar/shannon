import Anthropic from "@anthropic-ai/sdk";
import { toOpenAITools, TOOLS, toolInvocationLabel } from "./tool-schemas";
import type { ToolContext } from "./execute-tool";
import { executeTool } from "./execute-tool";
import { SYSTEM_PROMPT, EPHEMERAL_CONSTRAINT } from "./stream-anthropic";
import { contextWindowFor } from "./context-windows";

type OAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type OAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | OAIContentPart[] }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

const MAX_ITERATIONS = 10;

function anthropicToOpenAI(msg: Anthropic.MessageParam): OAIMessage {
  if (typeof msg.content === "string") {
    if (msg.role === "user") return { role: "user", content: msg.content };
    return { role: "assistant", content: msg.content };
  }
  const parts: OAIContentPart[] = [];
  for (const block of msg.content) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      if (block.source.type === "base64") {
        parts.push({
          type: "image_url",
          image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
        });
      }
    }
    // tool_use / tool_result blocks never appear in initial route-built messages.
  }
  if (msg.role === "user") return { role: "user", content: parts };
  // Assistant with content parts — flatten to text since OAI assistant doesn't take image parts.
  const flattened = parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
  return { role: "assistant", content: flattened };
}

export async function streamOpenAICompatChat(params: {
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: Anthropic.MessageParam[];
  ephemeral: boolean;
  ctx: ToolContext;
}): Promise<void> {
  const { apiKey, baseUrl, model, ephemeral, ctx } = params;
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const contextWindow = contextWindowFor(model);

  const history: OAIMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...(ephemeral ? ([{ role: "system", content: EPHEMERAL_CONSTRAINT }] as OAIMessage[]) : []),
    ...params.messages.map(anthropicToOpenAI),
  ];
  const tools = toOpenAITools(TOOLS);

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  // Latest API call's prompt_tokens — closest measure of "current context
  // size", not summed across iterations.
  let lastTurnInputTokens = 0;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: history,
        tools,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => `HTTP ${res.status}`);
      throw new Error(`Chat request failed: ${errText}`);
    }

    let textSoFar = "";
    const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    let toolLabelSent = false;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") continue;
          let event: {
            choices?: {
              delta?: {
                content?: string;
                tool_calls?: {
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }[];
              };
              finish_reason?: string | null;
            }[];
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              prompt_tokens_details?: { cached_tokens?: number };
            };
          };
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }

          const choice = event.choices?.[0];
          const delta = choice?.delta;
          if (delta?.content) {
            textSoFar += delta.content;
            ctx.emit({ type: "delta", text: delta.content });
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              let entry = pendingToolCalls.get(idx);
              if (!entry) {
                entry = { id: "", name: "", arguments: "" };
                pendingToolCalls.set(idx, entry);
              }
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) {
                if (!entry.name && !toolLabelSent) {
                  ctx.emit({
                    type: "tool_status",
                    status: `Invoking ${toolInvocationLabel(tc.function.name)} tool...`,
                  });
                  toolLabelSent = true;
                }
                entry.name = tc.function.name;
              }
              if (tc.function?.arguments) entry.arguments += tc.function.arguments;
            }
          }
          if (event.usage) {
            inputTokens += event.usage.prompt_tokens ?? 0;
            outputTokens += event.usage.completion_tokens ?? 0;
            cacheReadTokens += event.usage.prompt_tokens_details?.cached_tokens ?? 0;
            lastTurnInputTokens = event.usage.prompt_tokens ?? lastTurnInputTokens;
            ctx.emit({
              type: "input_tokens",
              tokens: inputTokens,
              cacheReadTokens,
              contextWindow,
              lastTurnInputTokens,
            });
          }
        }
      }
    }

    if (pendingToolCalls.size === 0) break;

    const toolCalls = [...pendingToolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, tc]) => tc)
      .filter((tc) => tc.name);

    history.push({
      role: "assistant",
      content: textSoFar || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments || "{}" },
      })),
    });

    const allCitations: string[] = [];
    for (const tc of toolCalls) {
      ctx.emit({ type: "tool_status", status: `Invoking ${toolInvocationLabel(tc.name)} tool...` });
      let parsedInput: Record<string, unknown> = {};
      try {
        parsedInput = tc.arguments ? JSON.parse(tc.arguments) : {};
      } catch {
        /* leave empty */
      }
      const outcome = await executeTool(tc.name, parsedInput, ctx);
      if (outcome.canvasCommand) {
        ctx.emit({
          type: "canvas_command",
          command: outcome.canvasCommand.command,
          args: outcome.canvasCommand.args,
        });
      }
      if (outcome.citations?.length) allCitations.push(...outcome.citations);

      history.push({
        role: "tool",
        tool_call_id: tc.id,
        content: outcome.text,
      });

      if (outcome.images && outcome.images.length > 0) {
        const parts: OAIContentPart[] = [];
        for (const img of outcome.images) {
          if (img.caption) parts.push({ type: "text", text: img.caption });
          parts.push({
            type: "image_url",
            image_url: { url: `data:${img.mediaType};base64,${img.data}` },
          });
        }
        history.push({ role: "user", content: parts });
      }
    }

    if (allCitations.length > 0) {
      ctx.emit({ type: "citations", citations: allCitations });
    }
    if (textSoFar.length > 0) {
      ctx.emit({ type: "delta", text: "\n\n" });
    }
  }

  ctx.emit({
    type: "usage",
    tokens: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    contextWindow,
    lastTurnInputTokens,
  });
}
