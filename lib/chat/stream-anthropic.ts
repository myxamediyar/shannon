import Anthropic from "@anthropic-ai/sdk";
import type { SseEvent } from "@/lib/chat-client";
import { TOOLS, toolInvocationLabel } from "./tool-schemas";
import type { ToolContext } from "./execute-tool";
import { executeTool } from "./execute-tool";
import { contextWindowFor } from "./context-windows";

const SYSTEM_PROMPT = `You are Shannon, a tool for intelligent ideation (for university students). Be helpful, clear, and concise. Use markdown formatting when appropriate.

You live on an infinite whiteboard canvas. You can only see the elements the user currently has visible in their viewport — anything scrolled off-screen is invisible to you. Canvas coordinates: x increases rightward; **smaller y is up, larger y is down** (standard screen-space). Your own position is listed as [self (this chat) @ (x,y)].

You have canvas tools to visually create elements on the whiteboard:
- create_shape: Draw rectangles, squares, circles, triangles
- create_table: Create data tables with optional pre-filled content
- create_chart: Generate charts (bar, line, pie, etc.) from descriptions
- create_graph: Plot mathematical functions using math.js syntax (x^2, sin(x), 2x+1, etc. — NOT LaTeX) — returns a graph number
- edit_graph: Modify an existing graph — add/remove/replace expressions (math.js syntax) or rescale axes
- create_math: Render LaTeX equations
- create_arrow: Draw arrows
- create_text: Spawn plain text (notes, labels, definitions) — supports multi-line via \\n, optional font_scale 1–4

Use these tools proactively when visual aids would help explain a concept. For example, plot a graph when discussing a function, create a chart when comparing data, or render an equation when explaining math. You can use multiple tools in one response.

Placement:
- SINGLE element (one shape, one chart, one graph, etc.): OMIT x/y. The canvas auto-places it next to your chat in the nearest empty slot — this is what you want. Never guess coordinates for single elements.
- COMPOSITION (multiple elements whose positions matter relative to each other — e.g. a smiley face = face + 2 eyes + mouth; a diagram; a labeled figure; a flowchart): you MUST specify x/y on EVERY element. If you omit coords for a composition, each shape stacks vertically in separate slots ~200px apart and the composition breaks. Pick a base point near your [self @ (x,y)] position (e.g. self.x + 400, self.y) and compute all other coords relative to it. Remember: smaller y is up, larger y is down — to place an eye ABOVE the face's center, use a SMALLER y than the center's y.
- Never pick "empty-looking" spots in the middle of the canvas — always anchor compositions to your own position.

PDF reading: When the user asks about PDF content, ALWAYS confirm the page range before calling read_pdf_pages. Ask something like "Which pages should I read?" or suggest a range based on context. Never read pages without the user's confirmation first. Max 50 pages per call — for any range larger than 50 pages, you MUST issue multiple sequential read_pdf_pages calls covering the full requested range (e.g. for pages 1–120, call 1–50, then 51–100, then 101–120). The tool result will tell you when a call was clipped and which pages still need to be fetched.

Embedded documents: When the user asks about an embedded Google Doc/Sheet/Slides, use read_embed to fetch its text content. The canvas context shows available embeds with their titles and providers.

Sidebar notes: The user has other notes in their sidebar that are NOT in your context. When the user refers to another note (by name or topic), first call find_note with a name/keyword. If nothing matches, call list_notes (offset=0, up to 50 per page) and paginate by increasing the offset until you find the closest title. Then call read_note with that id. Never guess note ids.

Other chats: The canvas context shows other chats as [chat #N @ (x,y)]: M messages — contents are NOT included. When the user references another chat or when its contents would help, call read_chat with chat_number=N (up to 10 messages per call; paginate with offset for longer chats).

You cannot create links or new chat windows — only the user can do that.`;

const EPHEMERAL_CONSTRAINT = `CRITICAL: This is a one-shot ephemeral chat. There is NO follow-up — the input box is hidden after this response. You MUST give a complete, self-contained answer. NEVER ask questions, NEVER say "let me know", "feel free to ask", "would you like me to", or anything that implies a follow-up is possible. Just answer fully and stop.`;

export { SYSTEM_PROMPT, EPHEMERAL_CONSTRAINT };

export async function streamAnthropicChat(params: {
  client: Anthropic;
  model: string;
  messages: Anthropic.MessageParam[];
  ephemeral: boolean;
  ctx: ToolContext;
}): Promise<void> {
  const { client, model, ephemeral, ctx } = params;
  const contextWindow = contextWindowFor(model);
  let currentMessages = params.messages;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  // The latest message_start's input_tokens — what the model actually saw on
  // its most recent call, which is the closest thing we have to "current
  // conversation context". Not summed across iterations so it doesn't
  // double-count shared history.
  let lastTurnInputTokens = 0;

  while (true) {
    const stream = client.messages.stream({
      model,
      max_tokens: 4096,
      tools: TOOLS,
      system: [
        { type: "text", cache_control: { type: "ephemeral" }, text: SYSTEM_PROMPT },
        ...(ephemeral ? [{ type: "text" as const, text: EPHEMERAL_CONSTRAINT }] : []),
      ],
      messages: currentMessages,
    });

    let hasToolUse = false;
    const toolUseBlocks: { id: string; name: string; input: Record<string, unknown> }[] = [];
    let textSoFar = "";

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        textSoFar += event.delta.text;
        ctx.emit({ type: "delta", text: event.delta.text });
      } else if (event.type === "content_block_start") {
        if (event.content_block.type === "tool_use") {
          hasToolUse = true;
          ctx.emit({
            type: "tool_status",
            status: `Invoking ${toolInvocationLabel(event.content_block.name)} tool...`,
          });
        }
      } else if (event.type === "message_start") {
        const usage = event.message?.usage;
        if (usage) {
          const turnInput = usage.input_tokens ?? 0;
          inputTokens += turnInput;
          cacheReadTokens += usage.cache_read_input_tokens ?? 0;
          cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
          // Anthropic's input_tokens excludes cached prefix; for the actual
          // "what the model just saw" we add cache reads back in.
          lastTurnInputTokens = turnInput + (usage.cache_read_input_tokens ?? 0);
          ctx.emit({
            type: "input_tokens",
            tokens: inputTokens,
            cacheReadTokens,
            cacheCreationTokens,
            contextWindow,
            lastTurnInputTokens,
          });
        }
      } else if (event.type === "message_delta") {
        outputTokens += event.usage?.output_tokens ?? 0;
      }
    }

    const finalMessage = await stream.finalMessage();
    for (const block of finalMessage.content) {
      if (block.type === "tool_use") {
        toolUseBlocks.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    if (!hasToolUse || toolUseBlocks.length === 0) break;

    const allCitations: string[] = [];
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tool of toolUseBlocks) {
      ctx.emit({
        type: "tool_status",
        status: `Invoking ${toolInvocationLabel(tool.name)} tool...`,
      });
      const outcome = await executeTool(tool.name, tool.input, ctx);
      if (outcome.canvasCommand) {
        ctx.emit({
          type: "canvas_command",
          command: outcome.canvasCommand.command,
          args: outcome.canvasCommand.args,
        });
      }
      if (outcome.citations?.length) allCitations.push(...outcome.citations);

      if (outcome.images && outcome.images.length > 0) {
        const content: Anthropic.ToolResultBlockParam["content"] = [];
        for (const img of outcome.images) {
          if (img.caption) content.push({ type: "text", text: img.caption });
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: img.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
              data: img.data,
            },
          });
        }
        toolResults.push({ type: "tool_result", tool_use_id: tool.id, content });
      } else {
        toolResults.push({ type: "tool_result", tool_use_id: tool.id, content: outcome.text });
      }
    }

    if (allCitations.length > 0) {
      ctx.emit({ type: "citations", citations: allCitations });
    }
    if (textSoFar.length > 0) {
      ctx.emit({ type: "delta", text: "\n\n" });
    }

    currentMessages = [
      ...currentMessages,
      { role: "assistant" as const, content: finalMessage.content },
      { role: "user" as const, content: toolResults },
    ];
  }

  ctx.emit({
    type: "usage",
    tokens: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    contextWindow,
    lastTurnInputTokens,
  });
}
