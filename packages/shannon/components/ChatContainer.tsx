"use client";

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkMark } from "remark-mark-highlight";
import type { ChatEl, ToolId } from "../lib/canvas-types";
import {
  TEXT_BASE_FONT_PX,
  CHAT_INDICATOR_MARGIN,
  CHAT_MAX_VISIBLE_LINES,
} from "../lib/canvas-types";
import {
  chatElContentHeight,
  chatElContentWidth,
  chatLineHeight,
  snapTextLineY,
} from "../lib/canvas-utils";
import { useChatStream, type ChatStreamDeps } from "../hooks/useChatStream";

// ── Memoized markdown block (skips re-parse when content hasn't changed) ───

const MarkdownBlock = memo(function MarkdownBlock({ content }: { content: string }) {
  return (
    <div className="chat-markdown" style={{ wordBreak: "break-word", overflowWrap: "break-word" }}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMark]}>{content}</ReactMarkdown>
    </div>
  );
});

// ── Source citation pills ──────────────────────────────────────────────────

function getDomain(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host;
  } catch {
    return url;
  }
}

function getFavicon(url: string): string {
  try {
    const origin = new URL(url).origin;
    return `${origin}/favicon.ico`;
  } catch {
    return "";
  }
}

const SourcePills = memo(function SourcePills({ citations, fontSize }: { citations: string[]; fontSize: number }) {
  // Deduplicate by domain
  const seen = new Set<string>();
  const unique: { url: string; domain: string }[] = [];
  for (const url of citations) {
    const domain = getDomain(url);
    if (!seen.has(domain)) {
      seen.add(domain);
      unique.push({ url, domain });
    }
  }

  const pillH = fontSize * 1.1;

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: fontSize * 0.3, marginTop: fontSize * 0.3, marginBottom: fontSize * 0.15 }}>
      {unique.map(({ url, domain }) => (
        <a
          key={url}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: fontSize * 0.25,
            height: pillH,
            padding: `0 ${fontSize * 0.4}px`,
            borderRadius: pillH / 2,
            background: "var(--th-border-30, rgba(128,128,128,0.15))",
            color: "var(--th-text)",
            fontSize: fontSize * 0.5,
            fontFamily: "var(--font-lexend), sans-serif",
            textDecoration: "none",
            lineHeight: `${pillH}px`,
            whiteSpace: "nowrap",
            cursor: "pointer",
            transition: "background 0.15s",
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--th-border-30, rgba(128,128,128,0.25))"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--th-border-30, rgba(128,128,128,0.15))"; }}
        >
          <img
            src={getFavicon(url)}
            alt=""
            width={fontSize * 0.5}
            height={fontSize * 0.5}
            style={{ borderRadius: 2, flexShrink: 0 }}
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
          />
          <span>{domain}</span>
        </a>
      ))}
    </div>
  );
});

// ── Constants ───────────────────────────────────────────────────────────────

const FOG_HEIGHT_PX = 60;
const FONT_SIZE = TEXT_BASE_FONT_PX * 2; // default text scale = 2
const HANDLE_SIZE = 8; // px in canvas-space
const MIN_W = 200; // minimum total width (including indicator margin)
const MIN_H = 60;  // minimum height

// ── Props ───────────────────────────────────────────────────────────────────

export interface ChatContainerProps {
  chatEl: ChatEl;
  activeTool: ToolId | null;
  locked: boolean;
  selectionMoveLive: boolean;
  canvasScale: number;
  onInputChange: (chatElId: string, inputText: string) => void;
  /** Fired when the chat's textarea receives focus — used by the canvas to
   *  drop any leftover selection outline that would otherwise sit on top of
   *  the chat the user is now editing. */
  onInputFocus?: (chatElId: string) => void;
  onMeasuredHeight: (chatElId: string, height: number) => void;
  onResize: (chatElId: string, w: number, h: number) => void;
  onResizeLive?: (chatElId: string, w: number, h: number) => void;
  /** Streaming lifecycle — container fires requests on mount (via `chatEl.pendingSubmit`) and on user input. */
  streamDeps: ChatStreamDeps;
}

// ── Component ───────────────────────────────────────────────────────────────

function ChatContainer({
  chatEl,
  activeTool,
  locked,
  selectionMoveLive,
  canvasScale,
  onInputChange,
  onInputFocus,
  onMeasuredHeight,
  onResize,
  onResizeLive,
  streamDeps,
}: ChatContainerProps) {
  // Container owns its own streaming via useChatStream.
  // - Auto-submits on mount if `chatEl.pendingSubmit` is set (slash commands).
  // - `submitInput`/`stopStream` drive user-typed follow-ups and the stop button.
  const stream = useChatStream(chatEl, streamDeps);
  const submitInput = (query: string) => {
    // Inline /compact runs compaction on this chat instead of being sent to the LLM.
    // Append a UI-only command marker so the user sees what they typed in the
    // log (rendered purple via kind: "command"), then kick off compaction.
    if (query === "/compact") {
      onInputChange(chatEl.id, "");
      streamDeps.chatMutate(chatEl.id, (chat) => ({
        ...chat,
        messages: [
          ...chat.messages,
          { role: "user" as const, content: "/compact", kind: "command" as const },
        ],
      }));
      void stream.compact();
      return;
    }
    stream.submit(query, false);
  };
  const stopStream = () => stream.stop();
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const prevMsgCountRef = useRef(chatEl.messages.length);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const focusAnchorRef = useRef<HTMLTextAreaElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const lastReportedH = useRef(chatEl.measuredH ?? 0);
  // Local mirror of the content height. Layout reads this instead of
  // `chatEl.measuredH` so viewportH stays in sync with the DOM within a single
  // render — the parent value lags one frame behind RO updates.
  const [measuredH, setMeasuredH] = useState<number>(chatEl.measuredH ?? 0);
  // Set in `onInput` so the inputText useLayoutEffect skips its redundant
  // auto/scrollHeight reflow when the user is actively typing.
  const heightAdjustedByInput = useRef(false);
  const [isHovered, setIsHovered] = useState(false);
  // Gate text selection on the chat subtree. Only true when the cursor entered
  // without a button held — prevents a native selection drag started on a
  // sibling element (e.g., a neighboring text element with user-select: text)
  // from extending through the DOM and highlighting chat content.
  const [selectable, setSelectable] = useState(false);

  // Lazy rendering: only render the last N messages, load more when user scrolls up
  const INITIAL_RENDER_COUNT = 6;
  const LOAD_MORE_COUNT = 6;
  const [renderCount, setRenderCount] = useState(INITIAL_RENDER_COUNT);

  // Resize drag state
  const resizeDragRef = useRef<{
    edge: "right" | "bottom" | "corner";
    startScreenX: number;
    startScreenY: number;
    startW: number;
    startH: number;
    lastW?: number;
    lastH?: number;
  } | null>(null);

  // Auto-scroll: pin to bottom only on new-message and on initial mount.
  // While streaming token deltas we deliberately do NOT pin — content flows
  // down past the viewport and a "more below" indicator appears instead.
  const userScrolledAwayRef = useRef(false);
  const [hasContentBelow, setHasContentBelow] = useState(false);

  // Track whether user has manually scrolled away from the bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
      userScrolledAwayRef.current = !atBottom;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // New message: reset lazy render count and pin once to show the new message.
  // The pin runs inside rAF so it lands after the new content has been measured.
  useLayoutEffect(() => {
    if (chatEl.messages.length > prevMsgCountRef.current) {
      setRenderCount(INITIAL_RENDER_COUNT);
      userScrolledAwayRef.current = false;
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (!el || userScrolledAwayRef.current) return;
        el.scrollTop = el.scrollHeight;
      });
    }
    prevMsgCountRef.current = chatEl.messages.length;
  }, [chatEl.messages.length]);

  // Initial mount: scroll to bottom so the latest message is visible when a
  // chat with existing history first renders.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // // Load more messages when sentinel becomes visible (user scrolled up)
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const scroll = scrollRef.current;
    if (!sentinel || !scroll) return;
    const ob = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && renderCount < chatEl.messages.length) {
          const prevScrollH = scroll.scrollHeight;
          setRenderCount((n) => Math.min(n + LOAD_MORE_COUNT, chatEl.messages.length));
          // Preserve scroll position after more messages render
          requestAnimationFrame(() => {
            scroll.scrollTop += scroll.scrollHeight - prevScrollH;
          });
        }
      },
      { root: scroll, threshold: 0 },
    );
    ob.observe(sentinel);
    return () => ob.disconnect();
  }, [renderCount, chatEl.messages.length]);

  // Reset textarea height when input text changes externally (e.g. cleared after
  // submit). Skipped while the user is typing — onInput already handled it,
  // and repeating the auto/scrollHeight dance makes RO see a shrink/grow cycle.
  useLayoutEffect(() => {
    if (heightAdjustedByInput.current) {
      heightAdjustedByInput.current = false;
      return;
    }
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
    const node = contentRef.current;
    if (node) {
      const h = node.scrollHeight;
      if (h !== lastReportedH.current) {
        lastReportedH.current = h;
        setMeasuredH(h);
        onMeasuredHeight(chatEl.id, h);
      }
    }
  }, [chatEl.inputText]);

  // Measure actual content height and report it back for canvas AABB
  useLayoutEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    const update = () => {
      const h = node.scrollHeight;
      if (h === lastReportedH.current) return;
      lastReportedH.current = h;
      setMeasuredH(h);
      onMeasuredHeight(chatEl.id, h);
    };
    const ro = new ResizeObserver(update);
    ro.observe(node);
    update();
    return () => ro.disconnect();
  }, []);

  // viewportH is derived from local `measuredH` (not `chatEl.measuredH`) so it
  // stays in sync with DOM growth within a single render — the parent's copy
  // lags by one frame because the RO update has to round-trip through state.
  const LINE_H = chatLineHeight();
  const contentW = chatElContentWidth(chatEl);
  const totalW = contentW + CHAT_INDICATOR_MARGIN;
  const localContentH = measuredH > 0 ? measuredH : chatElContentHeight(chatEl);
  const viewportH = (chatEl.h != null && chatEl.h > 0)
    ? chatEl.h
    : Math.min(localContentH, CHAT_MAX_VISIBLE_LINES * LINE_H);
  const scrollH = viewportH;
  const needsScroll = (localContentH || LINE_H) > scrollH;

  // Per-message dim box — same tokens as ChecklistItemRow's label box so the
  // treatment matches. Spread into each message wrapper (and the input row)
  // when chatEl.dimmed is on; off → empty object adds nothing.
  const DIM_PAD_X = 6; // = LABEL_PAD_X in ChecklistContainer
  const DIM_PAD_Y = 3; // = LABEL_PAD_Y in ChecklistContainer
  const DIM_BORDER = 1; // = LABEL_BORDER in ChecklistContainer
  const dimBoxStyle: React.CSSProperties = chatEl.dimmed
    ? {
        background: "var(--th-surface-hover, rgba(255,255,255,0.02))",
        border: `${DIM_BORDER}px solid var(--th-border-20, rgba(255,255,255,0.08))`,
        borderRadius: 4,
        padding: `${DIM_PAD_Y}px ${DIM_PAD_X}px`,
        marginBottom: DIM_PAD_Y,
      }
    : {};
  // Total horizontal chrome the dim box adds — used to shrink the input
  // textarea so it fits inside the padded wrapper without overflowing.
  const dimChromeX = chatEl.dimmed ? (DIM_PAD_X + DIM_BORDER) * 2 : 0;

  // Sync measuredH with the live DOM after every render. This catches
  // render-driven content growth (streaming tokens, message inserts, markdown
  // re-parse changing line heights) before paint, so the pin-to-bottom effect
  // below sees a viewport that already matches the content. Without this, RO
  // delivers the new height a frame later — long enough for pin-to-bottom to
  // scroll content up to fit the stale viewport, then snap it back down on
  // the next render. Visible as a brief up/down twitch per token.
  useLayoutEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    const h = node.scrollHeight;
    if (h !== lastReportedH.current) {
      lastReportedH.current = h;
      setMeasuredH(h);
      onMeasuredHeight(chatEl.id, h);
    }
  });

  // While streaming, surface a "more below" indicator whenever the assistant's
  // tokens have flowed past the bottom of the viewport. Recomputed every render
  // so the indicator reflects content growth, not just scroll events.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      if (hasContentBelow) setHasContentBelow(false);
      return;
    }
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const showIndicator = !!chatEl.isStreaming && distFromBottom > 30;
    if (showIndicator !== hasContentBelow) setHasContentBelow(showIndicator);
  });

  // ── Resize handlers ─────────────────────────────────────────────────────

  const handleResizePointerDown = useCallback((
    e: React.PointerEvent,
    edge: "right" | "bottom" | "corner"
  ) => {
    if (locked) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    resizeDragRef.current = {
      edge,
      startScreenX: e.clientX,
      startScreenY: e.clientY,
      startW: totalW,
      startH: viewportH,
    };
  }, [locked, totalW, viewportH]);

  const handleResizePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = resizeDragRef.current;
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();

    const dx = (e.clientX - drag.startScreenX) / canvasScale;
    const dy = (e.clientY - drag.startScreenY) / canvasScale;

    let newW = drag.startW;
    let newH = drag.startH;

    if (drag.edge === "right" || drag.edge === "corner") {
      newW = Math.max(MIN_W, drag.startW + dx);
    }
    if (drag.edge === "bottom" || drag.edge === "corner") {
      newH = Math.max(MIN_H, drag.startH + dy);
    }

    // DOM-only update during drag — no React state, no re-render
    const node = containerRef.current;
    if (node) {
      node.style.width = `${newW}px`;
      node.style.height = `${newH}px`;
      const scroll = scrollRef.current;
      if (scroll) scroll.style.height = `${newH}px`;
    }
    drag.lastW = newW;
    drag.lastH = newH;
    onResizeLive?.(chatEl.id, newW, newH);
  }, [canvasScale, chatEl.id, onResizeLive]);

  const handleResizePointerUp = useCallback((e: React.PointerEvent) => {
    const drag = resizeDragRef.current;
    if (!drag) return;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    // Commit final size to state — React's next render will overwrite inline styles
    if (drag.lastW != null && drag.lastH != null) {
      onResize(chatEl.id, drag.lastW, drag.lastH);
    }
    resizeDragRef.current = null;
  }, [chatEl.id, onResize]);

  const showHandles = !locked && (isHovered || resizeDragRef.current != null);

  // Shared handler props for resize edges
  const resizePointerProps = {
    onPointerMove: handleResizePointerMove,
    onPointerUp: handleResizePointerUp,
  };

  // Reset selectable when a drag finishes outside this chat. Without this,
  // the chat could stay selectable across an unrelated drag (since mouseleave
  // during a drag intentionally doesn't clear it).
  useEffect(() => {
    if (!selectable) return;
    const onUp = (e: MouseEvent) => {
      const node = containerRef.current;
      if (node && !node.contains(e.target as Node)) setSelectable(false);
    };
    document.addEventListener("mouseup", onUp);
    return () => document.removeEventListener("mouseup", onUp);
  }, [selectable]);

  return (
    <div
      ref={containerRef}
      data-el
      data-chat-container
      data-chat-id={chatEl.chatId}
      data-el-id={chatEl.id}
      className={selectable ? "chat-selectable" : undefined}
      onMouseEnter={(e) => {
        setIsHovered(true);
        // Only enable text selection if the cursor entered without a button
        // pressed — otherwise we'd opt in mid-drag and let a foreign selection
        // extend into chat content.
        if (e.buttons === 0) setSelectable(true);
      }}
      onMouseLeave={(e) => {
        if (!resizeDragRef.current) setIsHovered(false);
        // Keep selectable=true while a drag is in progress so the user's own
        // in-chat selection can extend out and back without losing the gate.
        if (e.buttons === 0) setSelectable(false);
      }}
      onClick={(e) => {
        // Clicks that land on the textarea manage their own caret/selection —
        // don't clobber with a focus-to-end redirect. (window.getSelection()
        // doesn't reflect a textarea's internal selection, so the check below
        // can't catch this on its own.)
        const target = e.target as HTMLElement;
        if (target.tagName === "TEXTAREA") return;
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return; // user is selecting text
        if (locked || activeTool === "mover") return;
        const ta = inputRef.current ?? focusAnchorRef.current;
        if (ta) {
          ta.focus({ preventScroll: true });
          const len = ta.value.length;
          ta.setSelectionRange(len, len);
        }
      }}
      style={{
        position: "absolute",
        left: chatEl.x - CHAT_INDICATOR_MARGIN,
        top: selectionMoveLive ? chatEl.y : snapTextLineY(chatEl.y),
        width: totalW,
        height: viewportH,
        overflow: "visible",
      }}
    >
      {/* Chat header: number + token count — positioned above the container */}
      <div
        style={{
          position: "absolute",
          top: -(LINE_H * 0.6),
          left: 0,
          width: "100%",
          paddingLeft: CHAT_INDICATOR_MARGIN,
          fontSize: `${FONT_SIZE * 0.55}px`,
          lineHeight: `${LINE_H * 0.6}px`,
          fontFamily: "var(--font-lexend), sans-serif",
          color: "var(--th-text)",
          opacity: 0.45,
          userSelect: "none",
          pointerEvents: "none",
          display: "flex",
          gap: "8px",
        }}
      >
        <span>#{chatEl.ephemeral ? (chatEl.parentChatNumber != null && chatEl.sideqNumber != null ? `${chatEl.parentChatNumber === -1 ? '??' : chatEl.parentChatNumber}-${chatEl.sideqNumber}` : 'ephemeral') : chatEl.chatNumber}{!chatEl.ephemeral && chatEl.parentChatNumber != null ? ` (: ${chatEl.parentChatNumber === -1 ? 'deleted' : chatEl.parentChatNumber})` : ''}</span>
        {(() => {
          const anyKnown =
            chatEl.inputTokens ||
            chatEl.outputTokens ||
            chatEl.estimatedOutputTokens ||
            chatEl.cacheReadTokens ||
            chatEl.tokenCount ||
            chatEl.contextWindow;
          if (!anyKnown) return null;
          const fmt = (v: number | null | undefined) =>
            v != null && v > 0 ? v.toLocaleString() : "—";
          const fmtCtx = (v: number | null | undefined) => {
            if (v == null) return "—";
            if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
            if (v >= 1_000) return `${Math.round(v / 1_000)}K`;
            return v.toString();
          };
          const ctxDisplay =
            chatEl.lastTurnInputTokens && chatEl.contextWindow
              ? `${fmtCtx(chatEl.lastTurnInputTokens)} : ${fmtCtx(chatEl.contextWindow)}`
              : chatEl.lastTurnInputTokens
                ? fmtCtx(chatEl.lastTurnInputTokens)
                : `— : ${fmtCtx(chatEl.contextWindow)}`;
          const outDisplay =
            chatEl.isStreaming && chatEl.estimatedOutputTokens && !chatEl.outputTokens
              ? `~${chatEl.estimatedOutputTokens.toLocaleString()}`
              : fmt(chatEl.outputTokens);
          return (
            <span>
              {fmt(chatEl.inputTokens)} in / {fmt(chatEl.cacheReadTokens)} cached / {outDisplay} out / {ctxDisplay} ctx
            </span>
          );
        })()}
        {!chatEl.ephemeral && chatEl.children && chatEl.children.length > 0 && (
          <span>→ {chatEl.children.map(c => `#${c}`).join(', ')}</span>
        )}
      </div>

      {/* Scrollable inner container */}
      <div
        ref={scrollRef}
        className="chat-scroll-hide"
        onMouseDown={(e) => {
          // Prevent canvas from stealing focus when user selects text in messages
          if (locked || activeTool === "mover") return;
          e.stopPropagation();
        }}
        style={{
          width: "100%",
          height: scrollH,
          overflowY: "auto",
          overflowX: "hidden",
          overscrollBehaviorX: "none",
          scrollbarWidth: "none",
          msOverflowStyle: "none",
          ...(needsScroll
            ? {
                maskImage: `linear-gradient(to bottom, transparent 0%, black ${FOG_HEIGHT_PX}px, black 100%)`,
                WebkitMaskImage: `linear-gradient(to bottom, transparent 0%, black ${FOG_HEIGHT_PX}px, black 100%)`,
              }
            : {}),
        }}
      >
        <div
          ref={contentRef}
          style={{
            paddingLeft: CHAT_INDICATOR_MARGIN,
            paddingTop: (viewportH < CHAT_MAX_VISIBLE_LINES * LINE_H && !chatEl.ephemeral) ? 0 : LINE_H,
            fontSize: `${FONT_SIZE}px`,
            lineHeight: `${LINE_H}px`,
            fontFamily: "var(--font-lexend), sans-serif",
            color: "var(--th-text)",
          }}
        >
          {/* Sentinel: triggers loading more messages when scrolled into view */}
          {renderCount < chatEl.messages.length && (
            <div ref={sentinelRef} style={{ height: 1 }} />
          )}

          {/* Render messages (only last renderCount) */}
          {(() => {
            const slicedMsgs = chatEl.messages.slice(-renderCount);
            return slicedMsgs.map((msg, idx) => {
            const realIdx = chatEl.messages.length - slicedMsgs.length + idx;
            // Slash-command marker (user-typed / etc commands intercepted before
            // being sent to the LLM). Rendered purple so it reads as a control
            // action rather than a normal user message.
            if (msg.kind === "command") {
              return (
                <div
                  key={realIdx}
                  style={{
                    position: "relative",
                    pointerEvents: "auto",
                    userSelect: "text",
                    color: "#a78bfa",
                    fontSize: `${FONT_SIZE}px`,
                    lineHeight: `${LINE_H}px`,
                    fontFamily: "var(--font-lexend), sans-serif",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    ...dimBoxStyle,
                  }}
                >
                  <span
                    style={{
                      position: "absolute",
                      right: "100%",
                      top: 0,
                      marginRight: 6,
                      lineHeight: `${LINE_H}px`,
                      fontSize: `${FONT_SIZE}px`,
                      color: "#a78bfa",
                      pointerEvents: "none",
                      userSelect: "none",
                      whiteSpace: "nowrap",
                    }}
                  >
                    &gt;
                  </span>
                  {msg.content}
                </div>
              );
            }
            // Compaction marker — the model can't see the original messages
            // anymore, only the synthesized summary in contextMessages. Render
            // a divider so the user knows where the boundary is.
            if (msg.kind === "compaction") {
              return (
                <div
                  key={realIdx}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: `${LINE_H * 0.25}px 0`,
                    color: "var(--th-text-faint)",
                    fontSize: `${FONT_SIZE * 0.85}px`,
                    lineHeight: `${LINE_H}px`,
                    fontFamily: "var(--font-lexend), sans-serif",
                    fontStyle: "italic",
                    userSelect: "none",
                    pointerEvents: "none",
                  }}
                >
                  <span style={{ flex: 1, height: 1, background: "var(--th-border-20)" }} />
                  <span>compacted {msg.summarizedCount ?? 0} message{msg.summarizedCount === 1 ? "" : "s"}</span>
                  <span style={{ flex: 1, height: 1, background: "var(--th-border-20)" }} />
                </div>
              );
            }
            const isLastMsg = idx === slicedMsgs.length - 1;
            const isStreamingThisMsg = chatEl.isStreaming && isLastMsg && msg.role === "assistant";
            const noContentYet = !msg.content || msg.content === "…";
            // Show the blinking indicator whenever toolStatus is live (regardless of the message
            // already having typed-out content), OR when this is the empty-placeholder message
            // waiting for the first deltas.
            const showWorkingIndicator =
              (!!chatEl.toolStatus && isLastMsg && msg.role === "assistant") ||
              (isStreamingThisMsg && noContentYet);
            // Server sends full "Invoking X tool..." labels for every tool
            // invocation. Empty-content placeholder shows "Working on it...".
            const workingLabel = chatEl.toolStatus ?? "Working on it...";
            return (
            <div
              key={realIdx}
              style={{
                position: "relative",
                pointerEvents: "auto",
                userSelect: "text",
                ...dimBoxStyle,
              }}
            >
              {/* Role indicator */}
              <span
                style={{
                  position: "absolute",
                  right: "100%",
                  top: 0,
                  marginRight: 6,
                  lineHeight: `${LINE_H}px`,
                  fontSize: `${FONT_SIZE}px`,
                  color: msg.role === "user" ? "#f78cb3" : "#22d3ee",
                  fontFamily: "var(--font-lexend), sans-serif",
                  pointerEvents: "none",
                  userSelect: "none",
                  whiteSpace: "nowrap",
                }}
              >
                &gt;
              </span>

              {msg.role === "assistant" ? (
                <>
                  <MarkdownBlock content={msg.content === "…" ? "" : msg.content} />
                  {msg.citations && msg.citations.length > 0 && (
                    <SourcePills citations={msg.citations} fontSize={FONT_SIZE} />
                  )}
                  {showWorkingIndicator && (
                    <span
                      style={{
                        display: "inline-block",
                        fontSize: `${FONT_SIZE}px`,
                        lineHeight: `${LINE_H}px`,
                        fontFamily: "var(--font-lexend), sans-serif",
                        color: "var(--th-text-secondary)",
                        fontStyle: "italic",
                        animation: "pulse-opacity 1.5s ease-in-out infinite",
                      }}
                    >
                      {workingLabel}
                    </span>
                  )}
                </>
              ) : (
                <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {msg.content}
                </div>
              )}
            </div>
            );
          });
          })()}

          {/* Input textarea / stop button (hidden for ephemeral sideq chats unless streaming) */}
          {(!chatEl.ephemeral || chatEl.isStreaming) && <div style={{ position: "relative", ...dimBoxStyle }}>
            {chatEl.isStreaming ? (
              <div
                style={{
                  position: "absolute",
                  right: "100%",
                  top: (LINE_H - FONT_SIZE) / 2,
                  marginRight: 6,
                  width: FONT_SIZE,
                  height: FONT_SIZE,
                  borderRadius: 4,
                  background: "#ef4444",
                  cursor: "pointer",
                  pointerEvents: "auto",
                  userSelect: "none",
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  stopStream();
                }}
                title="Stop generation (Esc)"
              />
            ) : (
              <span
                style={{
                  position: "absolute",
                  right: "100%",
                  top: 0,
                  marginRight: 6,
                  lineHeight: `${LINE_H}px`,
                  fontSize: `${FONT_SIZE * 1.3}px`,
                  color: "#f78cb3",
                  fontFamily: "var(--font-lexend), sans-serif",
                  pointerEvents: "none",
                  userSelect: "none",
                  whiteSpace: "nowrap",
                }}
              >
                &gt;
              </span>
            )}
            <textarea
              ref={inputRef}
              value={chatEl.inputText}
              readOnly={locked || chatEl.isStreaming || !!chatEl.toolStatus || activeTool === "mover"}
              onFocus={() => onInputFocus?.(chatEl.id)}
              onChange={(e) => {
                if (locked) return;
                onInputChange(chatEl.id, e.target.value);
              }}
              onMouseDown={(e) => {
                if (activeTool === "mover") {
                  e.preventDefault();
                  return;
                }
                // Locked: let mousedown flow through so the readOnly textarea
                // still gets native text selection + copy. stopPropagation
                // keeps the canvas pan handler from hijacking the drag.
                e.stopPropagation();
              }}
              onKeyDown={(e) => {
                if (chatEl.isStreaming || chatEl.toolStatus) {
                  if (chatEl.isStreaming && e.key === "Escape") {
                    e.preventDefault();
                    stopStream();
                  }
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  const text = chatEl.inputText.trim();
                  if (text) {
                    submitInput(text);
                  }
                }
              }}
              rows={1}
              placeholder=""
              spellCheck={false}
              className={`m-0 bg-transparent border-0 p-0 resize-none font-lexend text-sm text-[var(--th-text)] outline-none ring-0 shadow-none focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 rounded-none selection:bg-[var(--th-border-30)] ${(activeTool === "mover") ? "cursor-grab select-none" : "cursor-text"}`}
              style={{
                width: contentW - dimChromeX,
                minHeight: LINE_H,
                lineHeight: `${LINE_H}px`,
                fontSize: `${FONT_SIZE}px`,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                overflowX: "hidden",
                overflowY: "hidden",
                ...(activeTool === "mover"                  ? { userSelect: "none", WebkitUserSelect: "none" as const }
                  : {}),
              }}
              onInput={(e) => {
                const ta = e.currentTarget;
                ta.style.height = "auto";
                ta.style.height = `${ta.scrollHeight}px`;
                heightAdjustedByInput.current = true;
                // Sync measured height now (batched with onChange's setState)
                // so viewportH grows in the same render — without this, RO
                // delivers the new height a frame later, briefly leaving
                // content > viewport and flickering the fog/scroll on each
                // keystroke during the expansion phase.
                const node = contentRef.current;
                if (node) {
                  const h = node.scrollHeight;
                  if (h !== lastReportedH.current) {
                    lastReportedH.current = h;
                    setMeasuredH(h);
                    onMeasuredHeight(chatEl.id, h);
                  }
                }
                scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
              }}
            />
          </div>}

          {/* Invisible focus anchor for ephemeral chats (enables scroll via keyboard/wheel) */}
          {chatEl.ephemeral && !chatEl.isStreaming && (
            <textarea
              ref={focusAnchorRef}
              readOnly
              tabIndex={-1}
              style={{
                position: "absolute",
                width: 0,
                height: 0,
                opacity: 0,
                padding: 0,
                border: "none",
                overflow: "hidden",
                pointerEvents: "none",
              }}
            />
          )}
        </div>
      </div>

      {/* "More content below" indicator — visible while streaming when the
          assistant's tokens have flowed past the bottom of the viewport.
          Clicking jumps to the live edge. */}
      {hasContentBelow && (
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const el = scrollRef.current;
            if (!el) return;
            userScrolledAwayRef.current = false;
            el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
          }}
          title="Jump to live"
          style={{
            position: "absolute",
            bottom: 8,
            left: CHAT_INDICATOR_MARGIN + (contentW - FONT_SIZE * 1.6) / 2,
            width: FONT_SIZE * 1.6,
            height: FONT_SIZE * 1.6,
            borderRadius: "50%",
            background: "var(--th-surface, rgba(30,30,30,0.9))",
            border: "1px solid var(--th-border-30, rgba(255,255,255,0.18))",
            boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--th-text)",
            cursor: "pointer",
            pointerEvents: "auto",
            animation: "pulse-opacity 1.5s ease-in-out infinite",
            zIndex: 5,
          }}
        >
          <svg width={FONT_SIZE * 0.9} height={FONT_SIZE * 0.9} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      )}

      {/* ── Resize handles ──────────────────────────────────────────────── */}

      {/* Right edge */}
      <div
        onPointerDown={(e) => handleResizePointerDown(e, "right")}
        {...resizePointerProps}
        style={{
          position: "absolute",
          top: 0,
          right: -HANDLE_SIZE / 2,
          width: HANDLE_SIZE,
          height: "100%",
          cursor: "ew-resize",
          opacity: showHandles ? 1 : 0,
          transition: "opacity 0.15s",
          pointerEvents: "auto",
        }}
      >
        <div style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 5,
          height: 32,
          borderRadius: 3,
          background: "var(--th-text)",
          opacity: 0.55,
        }} />
      </div>

      {/* Bottom edge */}
      <div
        onPointerDown={(e) => handleResizePointerDown(e, "bottom")}
        {...resizePointerProps}
        style={{
          position: "absolute",
          bottom: -HANDLE_SIZE / 2,
          left: 0,
          width: "100%",
          height: HANDLE_SIZE,
          cursor: "ns-resize",
          opacity: showHandles ? 1 : 0,
          transition: "opacity 0.15s",
          pointerEvents: "auto",
        }}
      >
        <div style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 32,
          height: 5,
          borderRadius: 3,
          background: "var(--th-text)",
          opacity: 0.55,
        }} />
      </div>

      {/* Corner handle (bottom-right) */}
      <div
        onPointerDown={(e) => handleResizePointerDown(e, "corner")}
        {...resizePointerProps}
        style={{
          position: "absolute",
          bottom: -HANDLE_SIZE / 2,
          right: -HANDLE_SIZE / 2,
          width: HANDLE_SIZE * 2,
          height: HANDLE_SIZE * 2,
          cursor: "nwse-resize",
          opacity: showHandles ? 1 : 0,
          transition: "opacity 0.15s",
          pointerEvents: "auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: "var(--th-text)",
          opacity: 0.55,
        }} />
      </div>
    </div>
  );
}

export default memo(ChatContainer);
