// Slash-command dispatcher. Extracted from NotesCanvas to keep the component
// focused on state + rendering; this module owns the parse/route/spawn logic
// for every "/…" command the user types.

import type { RefObject } from "react";
import {
  elementTightCanvasAabb,
  spawnArrowFromCommand,
  spawnChat,
  spawnChecklistFromCommand,
  spawnLogoFromCommand,
  spawnMathFromCommand,
  spawnQuickChat,
  spawnShapeFromCommand,
  spawnSideq,
  spawnTableFromCommand,
} from "./canvas-utils";
import { validateGraphDelete, validateGraphPlace, validateGraphScale } from "../components/GraphContainer";
import { parseEmbedUrl } from "./canvas-embed";
import { compactChatHistory } from "./chat/compact-client";
import type {
  CanvasEl,
  ChatContextMessage,
  ChatEl,
  EmbedEl,
  GraphEl,
  PageRotation,
  PageSize,
  PlacementOp,
  PlacementResponse,
  TextEl,
} from "./canvas-types";

export type ChatHistoryMessage = ChatContextMessage;

export interface SlashCommandDeps {
  /** Latest snapshot of all elements (reads should reflect mid-dispatch mutations from prior execPlace calls). */
  readAllElements: () => CanvasEl[];
  /** Chat histories keyed by chatId — mutated in place (get/set/delete). */
  chatHistoriesRef: RefObject<Map<string, ChatHistoryMessage[]>>;
  /** Returns the next chat number and increments the internal counter. */
  nextChatNumber: () => number;
  /** Returns the next graph number (based on existing graphs). */
  nextGraphNumber: () => number;
  /** Flash a text element red to signal command-parse failure. */
  flashRed: (id: string) => void;
  /** Center viewport on (x, y) using current scale. */
  centerOn: (x: number, y: number) => void;
  /** Mutate a chat element in place without rebuilding the spatial index. */
  mutateChatEl: (chatElId: string, fn: (chat: ChatEl) => ChatEl) => void;
  /** Execute a placement operation on the active note. */
  execPlace: (op: PlacementOp, opts?: PlacementResponse & { immediate?: boolean; skipHistory?: boolean; changedId?: string }) => void;
  /** Focus the textarea inside a newly spawned chat element. */
  focusChatInput: (chatElId: string) => void;
  /** Open the note-picker UI at canvas coords (component handles screen-space conversion). */
  openNotePicker: (canvasX: number, canvasY: number) => void;
  /** Spawn a printable page region at canvas coords. */
  spawnPageRegionAt: (cx: number, cy: number, size?: PageSize, rotation?: PageRotation) => void;
  /** Open the OS file picker for an image; place it at the given canvas coords on pick. */
  openImagePickerAt: (canvasX: number, canvasY: number) => void;
  /** Open the OS file picker for a PDF; place it at the given canvas coords on pick. */
  openPdfPickerAt: (canvasX: number, canvasY: number) => void;
}

/** Wrap a transform-spawn op so the newly-spawned chat carries a `pendingSubmit` flag —
 *  `useChatStream` auto-submits on mount when it sees one. */
function injectPendingSubmit(
  op: PlacementOp,
  chatElId: string,
  prompt: string,
  isQuick: boolean,
) {
  if (op.kind !== "transform") return;
  const origFn = op.fn;
  op.fn = (els) => origFn(els).map((e) =>
    e.id === chatElId && e.type === "chat"
      ? { ...e, pendingSubmit: prompt, pendingSubmitIsQuick: isQuick }
      : e,
  );
}

/** Snapshot of the running token / context counters worth carrying to a fork or sideq. */
function pickChatStats(c: ChatEl) {
  const stats: Partial<Pick<ChatEl, "tokenCount" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "contextWindow" | "lastTurnInputTokens">> = {};
  if (c.tokenCount != null) stats.tokenCount = c.tokenCount;
  if (c.inputTokens != null) stats.inputTokens = c.inputTokens;
  if (c.outputTokens != null) stats.outputTokens = c.outputTokens;
  if (c.cacheReadTokens != null) stats.cacheReadTokens = c.cacheReadTokens;
  if (c.contextWindow != null) stats.contextWindow = c.contextWindow;
  if (c.lastTurnInputTokens != null) stats.lastTurnInputTokens = c.lastTurnInputTokens;
  return stats;
}

/** Load parent chat history from ref; fall back to persisted contextMessages,
 *  then to reconstructing from the UI message log. The runtime ref wins because
 *  the current turn may have appended entries that haven't been mirrored yet. */
function readParentHistory(parentChat: ChatEl, chatHistories: Map<string, ChatHistoryMessage[]>): ChatHistoryMessage[] {
  if (chatHistories.has(parentChat.chatId)) {
    return [...chatHistories.get(parentChat.chatId)!];
  }
  if (parentChat.contextMessages && parentChat.contextMessages.length > 0) {
    return parentChat.contextMessages.map((m) => ({ role: m.role, content: m.content }));
  }
  return parentChat.messages
    .filter((m) => !m.kind && m.content && m.content !== "…")
    .map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Dispatch a slash command. Returns true if the command was recognized and handled
 * (caller should `preventDefault` and short-circuit the keydown). Returns false if
 * the command is unknown — caller should let Tiptap handle Enter normally.
 */
export function dispatchSlashCommand(
  command: string,
  args: string,
  textEl: TextEl,
  deps: SlashCommandDeps,
): boolean {
  const { readAllElements, chatHistoriesRef, nextChatNumber, nextGraphNumber, flashRed,
    centerOn, mutateChatEl, execPlace, focusChatInput,
    openNotePicker, spawnPageRegionAt, openImagePickerAt, openPdfPickerAt } = deps;

  const findChatByNumber = (n: number) =>
    readAllElements().find(
      (x) => x.type === "chat" && (x as ChatEl).chatNumber === n && !(x as ChatEl).ephemeral,
    ) as ChatEl | undefined;

  /** Spawn a chat that inherits chat #parentNum's context. Parent history is always seeded
   *  into chatHistoriesRef (LLM sees it); `renderHistory` controls whether it's rendered
   *  in the new chat's UI. With a prompt, auto-submits; without, focuses the empty input. */
  const spawnChildChat = (
    parentNum: number,
    opts: { prompt?: string; renderHistory?: boolean } = {},
  ): boolean => {
    const { prompt, renderHistory = false } = opts;
    const parentChat = findChatByNumber(parentNum);
    if (!parentChat) return false;

    const chatHistories = chatHistoriesRef.current;
    if (!chatHistories) return false;
    const parentHistory = readParentHistory(parentChat, chatHistories);

    const num = nextChatNumber();
    const seed = renderHistory
      ? parentHistory.map((m) => ({ role: m.role, content: m.content }))
      : undefined;
    // Persist parent's LLM context onto the new chat so reloads survive.
    const seedContext = parentHistory.map((m) => ({ role: m.role, content: m.content }));
    // Carry parent's running counters so the new chat's HUD doesn't reset to 0.
    const seedStats = pickChatStats(parentChat);
    const { op, chatId, chatElId } = spawnChat(textEl, prompt ?? "", num, parentNum, seed, seedContext, seedStats);
    chatHistories.set(chatId, parentHistory);
    if (prompt) injectPendingSubmit(op, chatElId, prompt, false);
    execPlace(op, { immediate: true, skipHistory: true });
    if (!prompt) focusChatInput(chatElId);
    return true;
  };

  switch (command) {
    case "/chat": {
      const rawArgs = args;
      const firstSpace = rawArgs.indexOf(" ");
      const head = (firstSpace === -1 ? rawArgs : rawArgs.slice(0, firstSpace)).toLowerCase();
      const tail = firstSpace === -1 ? "" : rawArgs.slice(firstSpace + 1).trim();

      // /chat @<n> — center viewport on chat #n (no spawn)
      if (/^@\d+$/.test(head)) {
        const n = parseInt(head.slice(1), 10);
        const target = findChatByNumber(n);
        if (!target) { flashRed(textEl.id); return true; }
        const bbox = elementTightCanvasAabb(target);
        if (!bbox) { flashRed(textEl.id); return true; }
        centerOn(bbox.x + bbox.w / 2, bbox.y + bbox.h / 2);
        execPlace({ kind: "remove", ids: new Set([textEl.id]) }, { immediate: true });
        return true;
      }

      // /chat fork <n> — new chat inheriting chat #n's context (no auto-prompt)
      if (head === "fork") {
        const n = parseInt(tail, 10);
        if (isNaN(n) || !spawnChildChat(n, { renderHistory: true })) flashRed(textEl.id);
        return true;
      }

      // /chat compact <n> — summarize older history of chat #n; UI gets a divider.
      if (head === "compact") {
        const n = parseInt(tail, 10);
        const target = findChatByNumber(n);
        if (isNaN(n) || !target) { flashRed(textEl.id); return true; }
        // Fire and forget — UI shows the spinner via toolStatus while it runs.
        void compactChatHistory({
          chat: target,
          chatMutate: mutateChatEl,
          chatHistoriesRef,
        });
        execPlace({ kind: "remove", ids: new Set([textEl.id]) }, { immediate: true });
        return true;
      }

      // /chat clear <n> — wipe chat #n's messages in place
      if (head === "clear") {
        const n = parseInt(tail, 10);
        const target = findChatByNumber(n);
        if (isNaN(n) || !target) { flashRed(textEl.id); return true; }
        mutateChatEl(target.id, (chat) => ({ ...chat, messages: [], inputTokens: undefined, outputTokens: undefined, tokenCount: undefined, cacheReadTokens: undefined }));
        chatHistoriesRef.current?.delete(target.chatId);
        execPlace({ kind: "remove", ids: new Set([textEl.id]) }, { immediate: true });
        return true;
      }

      // /chat (empty) — spawn a blank chat, no LLM call
      if (!rawArgs) {
        const num = nextChatNumber();
        const { op, chatElId } = spawnChat(textEl, "", num);
        execPlace(op, { immediate: true, skipHistory: true });
        focusChatInput(chatElId);
        return true;
      }

      // Default: treat args as a question — container auto-submits via pendingSubmit
      const num = nextChatNumber();
      const { op, chatElId } = spawnChat(textEl, rawArgs, num);
      injectPendingSubmit(op, chatElId, rawArgs, false);
      execPlace(op, { immediate: true, skipHistory: true });
      return true;
    }

    case "/q": {
      if (!args) { flashRed(textEl.id); return true; }
      const { op, chatElId } = spawnQuickChat(textEl, args);
      injectPendingSubmit(op, chatElId, args, true);
      execPlace(op, { immediate: true, skipHistory: true });
      return true;
    }

    case "/sideq": {
      // Parse: /sideq <id> <prompt>
      const spaceIdx = args.indexOf(" ");
      if (spaceIdx === -1) { flashRed(textEl.id); return true; }
      const parentNum = parseInt(args.slice(0, spaceIdx), 10);
      const prompt = args.slice(spaceIdx + 1).trim();
      if (isNaN(parentNum) || !prompt) { flashRed(textEl.id); return true; }

      // Find parent chat by chatNumber
      const parentChat = readAllElements().find(
        (el) => el.type === "chat" && (el as ChatEl).chatNumber === parentNum,
      ) as ChatEl | undefined;
      if (!parentChat) { flashRed(textEl.id); return true; }

      // Count existing sideqs for this parent to determine sideqNumber
      const existingSideqs = readAllElements().filter(
        (el) => el.type === "chat" && (el as ChatEl).parentChatNumber === parentNum,
      ).length;
      const sideqNum = existingSideqs + 1;

      const chatHistories = chatHistoriesRef.current;
      if (!chatHistories) return true;
      const parentHistory = readParentHistory(parentChat, chatHistories);

      const seedContext = parentHistory.map((m) => ({ role: m.role, content: m.content }));
      const seedStats = pickChatStats(parentChat);
      const { op, chatId, chatElId } = spawnSideq(textEl, prompt, parentNum, sideqNum, seedContext, seedStats);
      chatHistories.set(chatId, parentHistory);
      injectPendingSubmit(op, chatElId, prompt, true);
      execPlace(op, { immediate: true, skipHistory: true });
      return true;
    }

    case "/sidechat": {
      const spaceIdx = args.indexOf(" ");
      if (spaceIdx === -1) { flashRed(textEl.id); return true; }
      const parentNum = parseInt(args.slice(0, spaceIdx), 10);
      const prompt = args.slice(spaceIdx + 1).trim();
      if (isNaN(parentNum) || !prompt) { flashRed(textEl.id); return true; }
      if (!spawnChildChat(parentNum, { prompt })) flashRed(textEl.id);
      return true;
    }

    case "/math": {
      if (!args) { flashRed(textEl.id); return true; }
      execPlace(spawnMathFromCommand(textEl, args), { immediate: true });
      return true;
    }

    case "/rectangle": {
      execPlace(spawnShapeFromCommand(textEl, "rect", args), { immediate: true });
      return true;
    }

    case "/square": {
      const nums = args.split(/[\sx,]+/).map(Number).filter((n) => !isNaN(n) && n > 0);
      const dim = nums[0] ? String(nums[0]) : "";
      execPlace(spawnShapeFromCommand(textEl, "rect", dim ? `${dim} ${dim}` : ""), { immediate: true });
      return true;
    }

    case "/circle": {
      execPlace(spawnShapeFromCommand(textEl, "circle", args), { immediate: true });
      return true;
    }

    case "/triangle": {
      execPlace(spawnShapeFromCommand(textEl, "triangle", args), { immediate: true });
      return true;
    }

    case "/arrow": {
      execPlace(spawnArrowFromCommand(textEl, args), { immediate: true });
      return true;
    }

    case "/logo": {
      execPlace(spawnLogoFromCommand(textEl, args), { immediate: true });
      return true;
    }

    case "/table": {
      execPlace(spawnTableFromCommand(textEl, args), { immediate: true });
      return true;
    }

    case "/checklist": {
      execPlace(spawnChecklistFromCommand(textEl, args), { immediate: true });
      return true;
    }

    case "/graph": {
      const exprArgs = args;
      const findGraph = (num?: number) => num != null
        ? readAllElements().find((e): e is GraphEl => e.type === "graph" && e.graphNum === num)
        : readAllElements().filter((e): e is GraphEl => e.type === "graph")
            .reduce<GraphEl | null>((a, b) => !a || b.graphNum > a.graphNum ? b : a, null);

      // "/graph <id> scale x x0 x1 [y y0 y1]" — rescale axes
      if (exprArgs && /^\d+\s+scale\b/i.test(exprArgs)) {
        const result = validateGraphScale(exprArgs);
        if (!result) { flashRed(textEl.id); return true; }
        const target = findGraph(result.graphNum);
        if (!target) { flashRed(textEl.id); return true; }
        const changes: Partial<GraphEl> = {};
        if (result.xBounds) changes.xBounds = result.xBounds;
        if (result.yBounds) changes.yBounds = result.yBounds;
        execPlace({ kind: "remove", ids: new Set([textEl.id]) }, { immediate: true });
        execPlace({ kind: "mutate", id: target.id, changes }, { immediate: true });
        return true;
      }

      // "/graph <id> delete <index>" — remove expression by index
      if (exprArgs) {
        const rmResult = validateGraphDelete(exprArgs);
        if (rmResult) {
          const target = findGraph(rmResult.graphNum);
          if (!target || !target.expressions || rmResult.index < 0 || rmResult.index >= target.expressions.length) {
            flashRed(textEl.id); return true;
          }
          const updated = target.expressions.filter((_, i) => i !== rmResult.index);
          execPlace({ kind: "remove", ids: new Set([textEl.id]) }, { immediate: true });
          execPlace({ kind: "mutate", id: target.id, changes: { expressions: updated } as Partial<GraphEl> }, { immediate: true });
          return true;
        }
      }

      // "/graph <id> place <index> <expression>" — replace expression by index
      if (exprArgs) {
        const sedResult = validateGraphPlace(exprArgs);
        if (sedResult) {
          const target = findGraph(sedResult.graphNum);
          if (!target || !target.expressions || sedResult.index < 0 || sedResult.index >= target.expressions.length) {
            flashRed(textEl.id); return true;
          }
          const updated = [...target.expressions];
          updated[sedResult.index] = sedResult.expression;
          execPlace({ kind: "remove", ids: new Set([textEl.id]) }, { immediate: true });
          execPlace({ kind: "mutate", id: target.id, changes: { expressions: updated } as Partial<GraphEl> }, { immediate: true });
          return true;
        }
      }

      // "/graph <id> <expression>" — append expression to existing graph
      const addExprMatch = exprArgs?.match(/^(\d+)\s+(.+)$/);
      if (addExprMatch) {
        const num = parseInt(addExprMatch[1]);
        const newExpr = addExprMatch[2].trim();
        const target = findGraph(num);
        if (!target) { flashRed(textEl.id); return true; }
        const updated = [...(target.expressions ?? []), newExpr];
        execPlace({ kind: "remove", ids: new Set([textEl.id]) }, { immediate: true });
        execPlace({ kind: "mutate", id: target.id, changes: { expressions: updated } as Partial<GraphEl> }, { immediate: true });
        return true;
      }

      // "/graph <expr1>, <expr2>, ..." — create new graph
      const expressions = exprArgs ? exprArgs.split(",").map((s) => s.trim()).filter(Boolean) : [];
      execPlace({ kind: "remove", ids: new Set([textEl.id]) }, { immediate: true });
      const graphEl: GraphEl = {
        id: crypto.randomUUID(), type: "graph",
        x: textEl.x, y: textEl.y, w: 600, h: 400,
        graphNum: nextGraphNumber(),
        expressions: expressions.length > 0 ? expressions : undefined,
      };
      execPlace({ kind: "spawn", element: graphEl }, { immediate: true });
      return true;
    }

    case "/link": {
      execPlace({ kind: "remove", ids: new Set([textEl.id]) }, { immediate: true });
      openNotePicker(textEl.x, textEl.y);
      return true;
    }

    case "/print": {
      const sizeArg = (args ?? "").trim().toLowerCase();
      const size: PageSize = sizeArg === "a4" || sizeArg === "legal" ? sizeArg : "letter";
      execPlace({ kind: "remove", ids: new Set([textEl.id]) }, { immediate: true });
      spawnPageRegionAt(textEl.x, textEl.y, size, 0);
      return true;
    }

    case "/image": {
      execPlace({ kind: "remove", ids: new Set([textEl.id]) }, { immediate: true });
      openImagePickerAt(textEl.x, textEl.y);
      return true;
    }

    case "/pdf": {
      execPlace({ kind: "remove", ids: new Set([textEl.id]) }, { immediate: true });
      openPdfPickerAt(textEl.x, textEl.y);
      return true;
    }

    case "/embed": {
      const embedInfo = parseEmbedUrl(args.trim());
      if (!embedInfo) { flashRed(textEl.id); return true; }
      execPlace({ kind: "remove", ids: new Set([textEl.id]) }, { immediate: true });
      const newEl: EmbedEl = {
        id: crypto.randomUUID(),
        type: "embed",
        x: textEl.x,
        y: textEl.y,
        w: embedInfo.w,
        h: embedInfo.h,
        embedUrl: embedInfo.embedUrl,
        title: embedInfo.title,
        provider: embedInfo.provider,
      };
      execPlace({ kind: "spawn", element: newEl }, { immediate: true });
      return true;
    }

    default:
      return false;
  }
}
