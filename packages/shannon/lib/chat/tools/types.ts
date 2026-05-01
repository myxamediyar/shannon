import type { SseEvent } from "@/lib/chat-client";

export type ToolImage = { mediaType: string; data: string; caption?: string };

export type ToolOutcome = {
  text: string;
  images?: ToolImage[];
  citations?: string[];
  canvasCommand?: { command: string; args: Record<string, unknown> };
};

/**
 * Direct callbacks the consumer (the React SPA) provides when running tools
 * client-side. When present, client-callback.ts uses these instead of the
 * old SSE-emit + /api/chat/tool-callback dance. The dance is preserved as
 * a fallback so the legacy server-side /api/chat route still works during
 * the migration.
 */
export type ToolCallbacks = {
  rasterizeShapes?: () => Promise<{
    groups: { image: string; description: string }[];
  }>;
  readPdfPage?: (
    filename: string,
    page: number,
  ) => Promise<{ image?: string; error?: string }>;
  readNote?: (noteId: string) => Promise<string>;
  readCurrentNote?: () => Promise<string>;
  readChat?: (
    chatNumber: number,
    offset: number,
    count: number,
  ) => Promise<string>;
  /** Server-tool callbacks: client-side implementations of what used to run
   *  server-only. When present, tools/server.ts dispatches through these
   *  instead of the legacy runWebSearch / direct fetch path. */
  webSearch?: (
    query: string,
  ) => Promise<{ answer: string; citations: string[] }>;
  readEmbed?: (embedUrl: string, title: string) => Promise<string>;
};

export type ToolContext = {
  sidebarNotes: { id: string; title: string }[];
  emit: (event: SseEvent) => void;
} & ToolCallbacks;
