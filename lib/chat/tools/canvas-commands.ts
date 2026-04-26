// Canvas-command tools: the server does no work beyond acknowledging; the
// browser's NotesCanvas receives a `canvas_command` SSE event and does the
// actual rendering (draw the shape, insert the table, spawn the graph, etc.).
// The ToolOutcome here carries both a synthetic success string (fed back to
// the LLM as the tool result) and the canvasCommand payload the driver emits.

import type { ToolOutcome } from "./types";

export const CANVAS_COMMAND_TOOL_NAMES = new Set([
  "create_shape",
  "create_table",
  "create_chart",
  "create_graph",
  "edit_graph",
  "create_math",
  "create_arrow",
  "create_text",
  "create_logo",
]);

export function executeCanvasCommand(
  name: string,
  input: Record<string, unknown>,
): ToolOutcome {
  const label = name.replace("create_", "").replace("edit_", "");
  return {
    text: `Successfully created ${label} on the canvas.`,
    canvasCommand: { command: name, args: input },
  };
}
