import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";
import { TEXT_LINE_HEIGHT } from "../lib/canvas-types";
import type {
  ArrowEl, CanvasEl, ChartDataset, ChartEl, ChartType, ChatContextMessage, ChatEl, ChatMessage, GraphEl, ImageEl, MathEl,
  ShapeEl, TableCell, TableEl,
} from "../lib/canvas-types";
import { CHART_TYPES } from "../lib/canvas-types";
import type { Dispatch } from "../components/canvas/types";
import { escapeCellHtml, placeChain } from "../lib/canvas-utils";
import { openChatStream, readSseEvents, type SseEvent, type ChatRequestBody } from "../lib/chat-client";
import { compactChatHistory } from "../lib/chat/compact-client";

type ChatHistoryMessage = ChatContextMessage;

/** When the most recent turn's input crosses this fraction of the model's
 *  context window, the next finishStream auto-fires a compaction. */
const AUTO_COMPACT_THRESHOLD = 0.8;
/** Trailing turns kept verbatim during auto-compaction. */
const AUTO_COMPACT_KEEP_LAST = 4;

export type ChatStreamDeps = {
  /** Canvas-wide mutation dispatch (for spawning/mutating other elements from tool events). */
  dispatch: Dispatch;
  /** Fast in-place mutation of this chat element (bypasses placement engine; used during streaming). */
  chatMutate: (chatElId: string, fn: (chat: ChatEl) => ChatEl) => void;
  /** Build the LLM's context view of the canvas (text summary + rasterized images). */
  buildContext: (chatEl: ChatEl) => { text: string; images: { mediaType: string; data: string }[] };
  /** Sidebar notes so the LLM's read_note tool can target them by id. */
  buildSidebarNotes: () => { id: string; title: string }[];
  /** Title of the current note (the one this chat lives in) — sent with every request so Claude knows which note it's in. */
  getCurrentNoteTitle: () => string | null;
  /** Shared history ref — cross-chat for fork semantics. */
  chatHistoriesRef: RefObject<Map<string, ChatHistoryMessage[]>>;
  /** Dedup context snapshots across requests. */
  lastSentVisibleRef: RefObject<Map<string, string>>;
  /** Current element snapshot — used by tool handlers (e.g. `edit_graph` target lookup, next graph number). */
  readAllElements: () => CanvasEl[];
  /** Compute placement for a tool-spawned element (honors args.x/args.y, else uses shell's auto-placement). */
  resolvePos: (chatElId: string, args: Record<string, unknown>, elW: number, elH: number) => { x: number; y: number };
  /**
   * Fallback for advanced tool events the hook still delegates to the shell:
   * rasterize_shapes, read_pdf_page, read_note, read_chat. Phase 4/5 may migrate these.
   */
  handleLegacyEvent: (chatElId: string, ev: SseEvent) => void;
  /** After the stream finishes — lets the shell flush to localStorage. */
  onStreamComplete?: () => void;
};

/**
 * Owns the streaming lifecycle for one ChatContainer:
 *   - watches `chatEl.pendingSubmit` for auto-submit on mount
 *   - fires the /api/chat request + consumes SSE events
 *   - drains text tokens through `chatMutate` at 15ms intervals (typewriter effect)
 *   - routes `create_shape` tool events through `dispatch` (spike validation)
 *   - delegates other tool events to `handleLegacyEvent` (Phase 3 migration)
 *   - owns a per-instance AbortController + drain timer
 */
export function useChatStream(chatEl: ChatEl, deps: ChatStreamDeps) {
  // Per-instance streaming state (lives for the component's lifetime)
  const abortRef = useRef<{ ctrl: AbortController; timer: ReturnType<typeof setInterval> | null } | null>(null);
  /** Hoisted drain-timer reference so stop() can always clear it, even if the
   *  streamRequest closure hasn't yet assigned it to abortRef.current.timer. */
  const drainTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Guards against React 18 StrictMode's simulated double-mount retriggering the auto-submit. */
  const autoSubmittedRef = useRef(false);

  const submit = (query: string, isQuick: boolean) => {
    // Defensive: if a prior stream is still in flight (e.g., the user rapidly
    // re-submits via pendingSubmit), abort it and drop any leaked drain timer
    // before starting the new one. Otherwise two drainTimers race on the same chat.
    if (abortRef.current) {
      try { abortRef.current.ctrl.abort(); } catch { /* already aborted */ }
    }
    if (drainTimerRef.current) {
      clearInterval(drainTimerRef.current);
      drainTimerRef.current = null;
    }
    abortRef.current = null;

    const chatElId = chatEl.id;
    const chatId = chatEl.chatId;

    // Build context + dedupe against the previous send
    const latest = deps.buildContext(chatEl);
    const lastSent = deps.lastSentVisibleRef.current?.get(chatId);
    const visibleContext = lastSent === latest.text
      ? "The visible canvas elements have not changed since the last message."
      : latest.text;
    deps.lastSentVisibleRef.current?.set(chatId, latest.text);

    const sidebarNotes = deps.buildSidebarNotes();
    const noteTitle = deps.getCurrentNoteTitle() ?? undefined;

    // Hydrate history on first send after reload. Prefer the persisted
    // contextMessages (what the LLM actually saw — survives compaction) over
    // the raw UI message log. Legacy elements without contextMessages fall
    // back to messages, filtered to drop placeholders and compaction markers.
    const histMap = deps.chatHistoriesRef.current;
    if (histMap && !histMap.has(chatId)) {
      const prior: ChatHistoryMessage[] = chatEl.contextMessages && chatEl.contextMessages.length > 0
        ? chatEl.contextMessages.map((m) => ({ role: m.role, content: m.content }))
        : chatEl.messages
            .filter((m) => !m.kind && m.content && m.content !== "…")
            .map((m) => ({ role: m.role, content: m.content }));
      histMap.set(chatId, prior);
    }
    const history = histMap?.get(chatId) ?? [];

    // For quick mode, don't duplicate the user message if it's already there
    deps.chatMutate(chatElId, (chat) => {
      const lastMsg = chat.messages[chat.messages.length - 1];
      const userAlreadyAdded = lastMsg && lastMsg.role === "user" && lastMsg.content === query;
      return {
        ...chat,
        inputText: "",
        isStreaming: true,
        messages: [
          ...chat.messages,
          ...(userAlreadyAdded ? [] : [{ role: "user" as const, content: query }]),
          { role: "assistant" as const, content: "…" },
        ],
      };
    });

    // Append user message to LLM history — but only if not already there.
    // (When chat.messages was spawned with the user query already in it, seeding from
    // chat.messages above already put it in history. Pushing again would duplicate.)
    const last = history[history.length - 1];
    const alreadyInHistory = last?.role === "user" && last.content === query;
    if (!alreadyInHistory) {
      history.push({ role: "user", content: query });
      histMap?.set(chatId, history);
    }
    // Mirror the runtime ref to ChatEl.contextMessages so the LLM's view of
    // the conversation survives reloads and is what fork/sideq inherit. The
    // ref is a write-through cache over this field.
    deps.chatMutate(chatElId, (chat) => ({ ...chat, contextMessages: history.map((m) => ({ role: m.role, content: m.content })) }));

    // Kick off request + SSE consumption
    const ctrl = new AbortController();
    abortRef.current = { ctrl, timer: null };

    void streamRequest({
      chatElId,
      chatId,
      body: {
        messages: history,
        visibleContext,
        visibleImages: latest.images,
        sidebarNotes,
        ...(noteTitle ? { noteTitle } : {}),
        ...(isQuick && { ephemeral: true }),
      },
      ctrl,
      appendAssistantToHistory: !isQuick,
      deps,
      abortRef,
      drainTimerRef,
    });
  };

  const stop = () => {
    // Always clear our known state — don't early-return when abortRef is null.
    // If the UI is showing isStreaming=true but our hook lost track of the
    // AbortController (timing race, hot reload, etc.), we still want the red
    // button click to force the chat back into a usable state.
    const entry = abortRef.current;
    if (entry) {
      try { entry.ctrl.abort(); } catch { /* already aborted */ }
    }
    if (drainTimerRef.current) {
      clearInterval(drainTimerRef.current);
      drainTimerRef.current = null;
    }
    abortRef.current = null;

    const chatId = chatEl.chatId;
    // Flush whatever has been rendered so far into history, then clear isStreaming so
    // the input textarea comes back and the stop button disappears.
    deps.chatMutate(chatEl.id, (chat) => {
      if (!chat.isStreaming && !chat.toolStatus) return chat; // idempotent no-op
      const lastMsg = chat.messages[chat.messages.length - 1];
      const partial = lastMsg?.role === "assistant" ? lastMsg.content : "";
      // Never persist the "…" placeholder to history.
      let nextContext = chat.contextMessages;
      if (partial && partial !== "…") {
        const hist = deps.chatHistoriesRef.current?.get(chatId) ?? [];
        hist.push({ role: "assistant", content: partial });
        deps.chatHistoriesRef.current?.set(chatId, hist);
        nextContext = hist.map((m) => ({ role: m.role, content: m.content }));
      }
      return { ...chat, isStreaming: false, toolStatus: null, estimatedOutputTokens: undefined, contextMessages: nextContext };
    });
    deps.onStreamComplete?.();
  };

  /** Compact the older portion of this chat's history into a single summarized
   *  user message, keeping the last `keepLastN` turns verbatim. */
  const compact = (keepLastN = 2) =>
    compactChatHistory({
      chat: chatEl,
      chatMutate: deps.chatMutate,
      chatHistoriesRef: deps.chatHistoriesRef,
      keepLastN,
    });

  // Auto-submit on mount if pendingSubmit is set. Guarded against StrictMode's double-mount
  // by autoSubmittedRef — once we've fired, the second mount skips.
  useEffect(() => {
    if (autoSubmittedRef.current) return;
    if (chatEl.pendingSubmit) {
      autoSubmittedRef.current = true;
      const query = chatEl.pendingSubmit;
      const isQuick = !!chatEl.pendingSubmitIsQuick;
      deps.chatMutate(chatEl.id, (chat) => ({
        ...chat,
        pendingSubmit: undefined,
        pendingSubmitIsQuick: undefined,
      }));
      submit(query, isQuick);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clear drain timer on unmount. We intentionally do NOT abort the fetch —
  // StrictMode's simulated unmount would otherwise cancel the first mount's request, and
  // a dangling fetch on a truly-removed chat is harmless (chatMutate no-ops if the chat is gone).
  // User-initiated aborts go through `stop()` instead.
  useEffect(() => {
    return () => {
      if (drainTimerRef.current) {
        clearInterval(drainTimerRef.current);
        drainTimerRef.current = null;
      }
      const entry = abortRef.current;
      if (entry?.timer) clearInterval(entry.timer);
    };
  }, []);

  return { submit, stop, compact };
}

async function streamRequest(args: {
  chatElId: string;
  chatId: string;
  body: ChatRequestBody;
  ctrl: AbortController;
  appendAssistantToHistory: boolean;
  deps: ChatStreamDeps;
  abortRef: RefObject<{ ctrl: AbortController; timer: ReturnType<typeof setInterval> | null } | null>;
  drainTimerRef: MutableRefObject<ReturnType<typeof setInterval> | null>;
}) {
  const { chatElId, chatId, body, ctrl, appendAssistantToHistory, deps, drainTimerRef } = args;

  // Snapshot pre-stream counts for accumulation
  let baseInputTokens = 0, baseOutputTokens = 0, baseTokenCount = 0;
  deps.chatMutate(chatElId, (chat) => {
    baseInputTokens = chat.inputTokens ?? 0;
    baseOutputTokens = chat.outputTokens ?? 0;
    baseTokenCount = chat.tokenCount ?? 0;
    return chat;
  });

  try {
    const res = await openChatStream(body, ctrl.signal);
    if (!res.ok || !res.body) {
      deps.chatMutate(chatElId, (chat) => {
        const msgs = [...chat.messages];
        msgs[msgs.length - 1] = { role: "assistant", content: "Error: could not reach AI" };
        return { ...chat, messages: msgs, isStreaming: false };
      });
      return;
    }

    // Clear placeholder "…"
    deps.chatMutate(chatElId, (chat) => {
      const msgs = [...chat.messages];
      msgs[msgs.length - 1] = { role: "assistant", content: "" };
      return { ...chat, messages: msgs };
    });

    let full = "";
    let displayedLen = 0;
    let streamDone = false;
    let streamTokens = 0;
    let streamInputTokens = 0;
    let streamOutputTokens = 0;
    let streamCacheReadTokens = 0;
    let streamContextWindow: number | null = null;
    let streamLastTurnInputTokens = 0;
    let streamCitations: string[] = [];
    // Tool-status label is keyed off typewriter position (not raw SSE arrival) so
    // it appears exactly when the user has "caught up" to the pre-tool text, and
    // stays visible for a minimum window even if the next delta arrives instantly
    // (common for fast synchronous tools like create_shape).
    let pendingToolStatus: string | null = null;
    let toolStatusAtLen: number | null = null;
    let toolStatusSetAt: number | null = null;
    const TOOL_STATUS_MIN_MS = 500;
    const drainOne = (): boolean => {
      // At or past the pending/active freeze point — decide whether to reveal, pause, or resume.
      if (toolStatusAtLen != null && displayedLen >= toolStatusAtLen) {
        // Commit the pending label the moment the typewriter catches up to it.
        if (pendingToolStatus != null) {
          const label = pendingToolStatus;
          pendingToolStatus = null;
          toolStatusSetAt = Date.now();
          deps.chatMutate(chatElId, (chat) => ({ ...chat, toolStatus: label }));
        }
        const elapsed = Date.now() - (toolStatusSetAt ?? 0);
        const hasMoreContent = full.length > toolStatusAtLen;
        // Keep the label visible until we've both honored MIN_DISPLAY_MS *and* have
        // post-tool content queued up. Otherwise we'd blink the label off only to
        // immediately idle with nothing new on-screen.
        if (!hasMoreContent || elapsed < TOOL_STATUS_MIN_MS) {
          return !streamDone;
        }
        toolStatusAtLen = null;
        toolStatusSetAt = null;
        deps.chatMutate(chatElId, (chat) => chat.toolStatus ? { ...chat, toolStatus: null } : chat);
      }
      if (displayedLen >= full.length) return !streamDone;
      displayedLen++;
      const shown = full.slice(0, displayedLen);
      deps.chatMutate(chatElId, (chat) => {
        const msgs = [...chat.messages];
        msgs[msgs.length - 1] = { role: "assistant", content: shown };
        return { ...chat, messages: msgs };
      });
      return true;
    };

    const finishStream = () => {
      deps.chatMutate(chatElId, (chat) => {
        const msgs = [...chat.messages];
        msgs[msgs.length - 1] = {
          role: "assistant",
          content: full,
          ...(streamCitations.length > 0 ? { citations: streamCitations } : {}),
        };
        return {
          ...chat,
          messages: msgs,
          isStreaming: false,
          toolStatus: null,
          tokenCount: baseTokenCount + streamTokens,
          inputTokens: baseInputTokens + streamInputTokens,
          outputTokens: baseOutputTokens + streamOutputTokens,
          cacheReadTokens: streamCacheReadTokens || chat.cacheReadTokens,
          contextWindow: streamContextWindow ?? chat.contextWindow,
          lastTurnInputTokens: streamLastTurnInputTokens || chat.lastTurnInputTokens,
          estimatedOutputTokens: undefined,
        };
      });

      if (appendAssistantToHistory) {
        const hist = deps.chatHistoriesRef.current?.get(chatId) ?? [];
        hist.push({ role: "assistant", content: full });
        deps.chatHistoriesRef.current?.set(chatId, hist);
        deps.chatMutate(chatElId, (chat) => ({ ...chat, contextMessages: hist.map((m) => ({ role: m.role, content: m.content })) }));
      }
      // Auto-compact when this turn's input crowded out >80% of the model's
      // context window. Fire-and-forget — the next user turn will benefit from
      // the smaller context. Skip ephemeral chats since their state evaporates.
      const ctxWin = streamContextWindow ?? null;
      const lastIn = streamLastTurnInputTokens || 0;
      if (
        appendAssistantToHistory &&
        ctxWin != null &&
        ctxWin > 0 &&
        lastIn > ctxWin * AUTO_COMPACT_THRESHOLD
      ) {
        // Look up the freshest chat snapshot — finishStream just mutated it.
        const latest = deps.readAllElements().find(
          (el) => el.id === chatElId && el.type === "chat",
        ) as ChatEl | undefined;
        if (latest && (latest.contextMessages?.length ?? 0) > AUTO_COMPACT_KEEP_LAST + 1) {
          void compactChatHistory({
            chat: latest,
            chatMutate: deps.chatMutate,
            chatHistoriesRef: deps.chatHistoriesRef,
            keepLastN: AUTO_COMPACT_KEEP_LAST,
          });
        }
      }
      deps.onStreamComplete?.();
    };

    const drainTimer = setInterval(() => {
      if (!drainOne()) {
        clearInterval(drainTimer);
        if (drainTimerRef.current === drainTimer) drainTimerRef.current = null;
        finishStream();
      }
    }, 15);
    drainTimerRef.current = drainTimer;
    const entry = args.abortRef.current;
    if (entry) entry.timer = drainTimer;

    for await (const ev of readSseEvents(res.body)) {
      if (ev.type === "delta") {
        full += ev.text;
        const est = baseOutputTokens + Math.round(full.length / 4);
        // Don't clear toolStatus here — drainOne owns the lifecycle so the label
        // stays visible until the typewriter is ready to reveal post-tool content.
        deps.chatMutate(chatElId, (chat) => ({ ...chat, estimatedOutputTokens: est }));
      } else if (ev.type === "input_tokens") {
        streamInputTokens = ev.tokens ?? 0;
        streamCacheReadTokens = ev.cacheReadTokens ?? streamCacheReadTokens;
        if (ev.contextWindow !== undefined) streamContextWindow = ev.contextWindow;
        if (ev.lastTurnInputTokens !== undefined) streamLastTurnInputTokens = ev.lastTurnInputTokens;
        deps.chatMutate(chatElId, (chat) => ({
          ...chat,
          inputTokens: baseInputTokens + streamInputTokens,
          cacheReadTokens: streamCacheReadTokens || chat.cacheReadTokens,
          contextWindow: streamContextWindow ?? chat.contextWindow,
          lastTurnInputTokens: streamLastTurnInputTokens || chat.lastTurnInputTokens,
        }));
      } else if (ev.type === "usage") {
        streamTokens = ev.tokens ?? 0;
        streamInputTokens = ev.inputTokens ?? 0;
        streamOutputTokens = ev.outputTokens ?? 0;
        streamCacheReadTokens = ev.cacheReadTokens ?? streamCacheReadTokens;
        if (ev.contextWindow !== undefined) streamContextWindow = ev.contextWindow;
        if (ev.lastTurnInputTokens !== undefined) streamLastTurnInputTokens = ev.lastTurnInputTokens;
      } else if (ev.type === "citations") {
        streamCitations = ev.citations ?? [];
      } else if (ev.type === "canvas_command") {
        runCanvasCommand(chatElId, ev.command, ev.args, deps);
      } else if (ev.type === "tool_status") {
        if (ev.status) {
          // Defer commit until drainOne catches up — prevents the label from popping
          // in while the typewriter is still mid-typing pre-tool text, and survives
          // the common case where the next delta follows within the same tick.
          pendingToolStatus = ev.status;
          toolStatusAtLen = full.length;
        } else {
          pendingToolStatus = null;
          toolStatusAtLen = null;
          toolStatusSetAt = null;
          deps.chatMutate(chatElId, (chat) => chat.toolStatus ? { ...chat, toolStatus: null } : chat);
        }
      } else if (ev.type === "error") {
        full += `Error: ${ev.message || "Unknown error from AI"}`;
      } else {
        // Not migrated yet — let the shell handle it
        deps.handleLegacyEvent(chatElId, ev);
      }
    }
    if (full === "") {
      full = "Sorry, I wasn't able to generate a response. Please try again.";
    }
    streamDone = true;
  } catch {
    // Either the fetch/reader threw mid-stream, or the user aborted. In both
    // cases the drain timer is still alive; clear it so it doesn't leak and
    // no finishStream fires after us.
    if (drainTimerRef.current) {
      clearInterval(drainTimerRef.current);
      drainTimerRef.current = null;
    }
    if (ctrl.signal.aborted) return;
    deps.chatMutate(chatElId, (chat) => {
      const msgs = [...chat.messages];
      msgs[msgs.length - 1] = { role: "assistant", content: "Error: connection failed" };
      return { ...chat, messages: msgs, isStreaming: false };
    });
  }
}

// Type export so ChatContainer can wire up the correct ChatMessage shape
export type { ChatMessage };

/** Next unused graphNum across the element list (pure). */
function nextGraphNum(elements: CanvasEl[]): number {
  let max = 0;
  for (const el of elements) if (el.type === "graph" && el.graphNum > max) max = el.graphNum;
  return max + 1;
}

/**
 * Dispatch a tool-triggered canvas_command into the placement engine via `deps.dispatch`.
 * Mirrors the previous shell-side `handleCanvasCommand`, now co-located with the chat streaming
 * that triggers it so the shell no longer needs to know about chat tool semantics.
 */
function runCanvasCommand(
  chatElId: string,
  command: string,
  args: Record<string, unknown>,
  deps: ChatStreamDeps,
) {
  if (command === "create_shape") {
    const shapeMap: Record<string, "rect" | "circle" | "triangle"> = {
      rectangle: "rect", square: "rect", circle: "circle", triangle: "triangle",
    };
    const shape = shapeMap[args.shape as string] ?? "rect";
    const w = (args.width as number) || 150;
    const h = args.shape === "square" ? w : ((args.height as number) || 150);
    const pos = deps.resolvePos(chatElId, args, w, h);
    const el: ShapeEl = { id: crypto.randomUUID(), type: "shape", x: pos.x, y: pos.y, w, h, shape };
    deps.dispatch({ kind: "spawn", element: el }, { immediate: true });
    return;
  }
  if (command === "create_table") {
    const rowCount = Math.min((args.rows as number) || 3, 50);
    const colCount = Math.min((args.cols as number) || 3, 20);
    const data = args.data as string[][] | undefined;
    const cells: TableCell[][] = Array.from({ length: rowCount }, (_, r) =>
      Array.from({ length: colCount }, (_, c) => ({ html: escapeCellHtml(data?.[r]?.[c] ?? "") })),
    );
    const estW = colCount * 120;
    const estH = 34 + (rowCount - 1) * 32 + 2;
    const pos = deps.resolvePos(chatElId, args, estW, estH);
    const el: TableEl = { id: crypto.randomUUID(), type: "table", x: pos.x, y: pos.y, w: estW, h: estH, cells };
    deps.dispatch({ kind: "spawn", element: el }, { immediate: true });
    return;
  }
  if (command === "create_chart") {
    const rawType = args.chart_type as string | undefined;
    const chartType: ChartType = (rawType && (CHART_TYPES as readonly string[]).includes(rawType))
      ? (rawType as ChartType)
      : "bar";
    const labels = (Array.isArray(args.labels) ? args.labels : []).map(String);
    const datasets: ChartDataset[] = (Array.isArray(args.datasets) ? args.datasets : []).map((ds: unknown) => {
      const d = ds as { label?: unknown; values?: unknown[] };
      return {
        label: typeof d.label === "string" ? d.label : "Value",
        values: Array.isArray(d.values) ? d.values.map(Number) : [],
      };
    });
    const description = typeof args.description === "string" ? args.description : undefined;
    const formula = typeof args.formula === "string" && args.formula ? (args.formula as string) : undefined;
    const W = 500, H = 320;
    const pos = deps.resolvePos(chatElId, args, W, H);
    const el: ChartEl = {
      id: crypto.randomUUID(), type: "chart",
      x: pos.x, y: pos.y, w: W, h: H,
      chartType, labels, datasets,
      ...(description ? { description } : {}),
      ...(formula ? { formula } : {}),
    };
    deps.dispatch({ kind: "spawn", element: el }, { immediate: true });
    return;
  }
  if (command === "create_graph") {
    const expressions = (args.expressions as string[]) ?? [];
    const pos = deps.resolvePos(chatElId, args, 600, 400);
    const el: GraphEl = {
      id: crypto.randomUUID(), type: "graph",
      x: pos.x, y: pos.y, w: 600, h: 400,
      graphNum: nextGraphNum(deps.readAllElements()),
      expressions: expressions.length > 0 ? expressions : undefined,
    };
    deps.dispatch({ kind: "spawn", element: el }, { immediate: true });
    return;
  }
  if (command === "edit_graph") {
    const graphNum = args.graph_num as number;
    const action = args.action as string;
    const target = deps.readAllElements().find(
      (e): e is GraphEl => e.type === "graph" && e.graphNum === graphNum,
    );
    if (!target) return;

    if (action === "add") {
      const expr = args.expression as string;
      if (!expr) return;
      const updated = [...(target.expressions ?? []), expr];
      deps.dispatch({ kind: "mutate", id: target.id, changes: { expressions: updated } as Partial<GraphEl> }, { immediate: true });
    } else if (action === "remove") {
      const idx = args.index as number;
      if (!target.expressions || idx < 0 || idx >= target.expressions.length) return;
      const updated = target.expressions.filter((_, i) => i !== idx);
      deps.dispatch({ kind: "mutate", id: target.id, changes: { expressions: updated } as Partial<GraphEl> }, { immediate: true });
    } else if (action === "replace") {
      const idx = args.index as number;
      const expr = args.expression as string;
      if (!target.expressions || idx < 0 || idx >= target.expressions.length || !expr) return;
      const updated = [...target.expressions];
      updated[idx] = expr;
      deps.dispatch({ kind: "mutate", id: target.id, changes: { expressions: updated } as Partial<GraphEl> }, { immediate: true });
    } else if (action === "rescale") {
      const changes: Partial<GraphEl> = {};
      const xb = args.x_bounds as [number, number] | undefined;
      const yb = args.y_bounds as [number, number] | undefined;
      if (xb && xb.length === 2) changes.xBounds = xb;
      if (yb && yb.length === 2) changes.yBounds = yb;
      if (Object.keys(changes).length > 0) {
        deps.dispatch({ kind: "mutate", id: target.id, changes }, { immediate: true });
      }
    }
    return;
  }
  if (command === "create_math") {
    const latex = args.latex as string;
    if (!latex) return;
    const pos = deps.resolvePos(chatElId, args, 300, 60);
    const el: MathEl = { id: crypto.randomUUID(), type: "math", x: pos.x, y: pos.y, latex };
    deps.dispatch({ kind: "spawn", element: el }, { immediate: true });
    return;
  }
  if (command === "create_arrow") {
    const len = (args.length as number) || 200;
    const dir = (args.direction as string) || "right";
    const elW = dir === "left" || dir === "right" ? len : 30;
    const elH = dir === "up" || dir === "down" ? len : 30;
    const pos = deps.resolvePos(chatElId, args, elW, elH);
    const x1 = pos.x, y1 = pos.y;
    let x2 = x1, y2 = y1;
    if (dir === "right") x2 = x1 + len;
    else if (dir === "left") x2 = x1 - len;
    else if (dir === "down") y2 = y1 + len;
    else if (dir === "up") y2 = y1 - len;
    const el: ArrowEl = { id: crypto.randomUUID(), type: "arrow", x1, y1, x2, y2 };
    deps.dispatch({ kind: "spawn", element: el }, { immediate: true });
    return;
  }
  if (command === "create_text") {
    // The model sometimes double-escapes newlines (`\\n` in the JSON → literal "\n" two chars
    // after parse). Normalize to real line breaks so the text→HTML renderer sees paragraphs.
    const raw = (args.text as string) ?? "";
    const text = raw.replace(/\\r\\n|\\n/g, "\n").replace(/\\t/g, "\t");
    if (!text) return;
    const fontScale = Math.max(1, Math.min(4, (args.font_scale as number) ?? 2));
    const lines = text.split("\n");
    const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
    const estW = Math.max(80, longest * 8 * fontScale);
    const estH = Math.max(TEXT_LINE_HEIGHT, lines.length * TEXT_LINE_HEIGHT * fontScale);
    const pos = deps.resolvePos(chatElId, args, estW, estH);
    const chain = placeChain(lines, pos.x, pos.y, { fontScale });
    deps.dispatch(chain.op, { immediate: true });
    return;
  }
  if (command === "create_logo") {
    const size = Math.max(40, Math.min(1200, (args.size as number) || 200));
    const pos = deps.resolvePos(chatElId, args, size, size);
    const el: ImageEl = {
      id: crypto.randomUUID(), type: "image",
      x: pos.x, y: pos.y, w: size, h: size,
      src: "/shannon-logo.png",
    };
    deps.dispatch({ kind: "spawn", element: el }, { immediate: true });
    return;
  }
}
