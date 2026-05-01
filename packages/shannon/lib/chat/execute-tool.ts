// Dispatch a tool call to the right handler based on where it actually runs.
// Three surfaces:
//   • server            → pure server-side (web_search, read_embed, find_note, list_notes)
//   • canvas-command    → server-side passthrough, browser does the rendering
//   • client-callback   → server asks browser to do work and awaits the reply
// Each surface lives in its own file under tools/ so concerns don't bleed.

import type { ToolContext, ToolOutcome } from "./tools/types";
import { SERVER_TOOL_NAMES, executeServerTool } from "./tools/server";
import { CANVAS_COMMAND_TOOL_NAMES, executeCanvasCommand } from "./tools/canvas-commands";
import { CLIENT_CALLBACK_TOOL_NAMES, executeClientCallbackTool } from "./tools/client-callback";

export type { ToolContext, ToolOutcome, ToolImage } from "./tools/types";

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  if (CANVAS_COMMAND_TOOL_NAMES.has(name)) return executeCanvasCommand(name, input);
  if (SERVER_TOOL_NAMES.has(name)) return executeServerTool(name, input, ctx);
  if (CLIENT_CALLBACK_TOOL_NAMES.has(name)) return executeClientCallbackTool(name, input, ctx);
  return { text: `Unknown tool: ${name}` };
}
