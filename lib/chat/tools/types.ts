import type { SseEvent } from "@/lib/chat-client";

export type ToolImage = { mediaType: string; data: string; caption?: string };

export type ToolOutcome = {
  text: string;
  images?: ToolImage[];
  citations?: string[];
  canvasCommand?: { command: string; args: Record<string, unknown> };
};

export type ToolContext = {
  sidebarNotes: { id: string; title: string }[];
  emit: (event: SseEvent) => void;
};
