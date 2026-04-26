import Anthropic from "@anthropic-ai/sdk";
import type { ChatContextMessage } from "../canvas-types";

export type CompactionResult = {
  /** The synthesized summary placed as the first message in the new context. */
  summary: string;
  /** Replacement context for the chat (compacted slice + kept tail). */
  newContext: ChatContextMessage[];
  /** How many original messages were folded into the summary. */
  summarizedCount: number;
};

const COMPACTION_PROMPT = `You will be given the start of a conversation between a user and an assistant. \
Compact it into a concise prose summary so the assistant can keep going without losing context.

Preserve, in this order of priority:
1. Key facts the user established (names, numbers, decisions, preferences, constraints).
2. Findings and conclusions the assistant reached, including from any tools it used.
3. "Aha moments" — insights, corrections, surprises, things the user explicitly cared about.
4. Open questions / unresolved tasks the assistant should still attend to.
5. References to specific canvas elements, PDFs, notes, or chats mentioned by name or number.

Drop: pleasantries, restated questions, generic acknowledgments, step-by-step process narration, \
verbatim copy from documents that were already summarized, image/figure descriptions that don't \
carry forward into decisions.

Output ONLY the summary as prose. No preface, no headers, no bullet checklists unless a numbered \
list is genuinely the most compact form. Aim for ~10-30% of the original length.`;

/**
 * Compact a slice of chat history into a single synthesized "summary" entry,
 * keeping the most recent `keepLastN` messages verbatim.
 *
 * The returned `newContext` is the full replacement: [synthSummary, ...recentTail].
 * Caller is responsible for persisting it onto the chat's contextMessages and
 * resetting the runtime chatHistoriesRef.
 */
export async function compactContext(args: {
  client: Anthropic;
  model: string;
  history: ChatContextMessage[];
  /** Number of trailing messages to keep verbatim. Default 4. */
  keepLastN?: number;
}): Promise<CompactionResult> {
  const { client, model, history } = args;
  const keepLastN = args.keepLastN ?? 4;

  if (history.length <= keepLastN) {
    return { summary: "", newContext: [...history], summarizedCount: 0 };
  }

  const compactSlice = history.slice(0, history.length - keepLastN);
  const tail = history.slice(history.length - keepLastN);

  const conversationText = compactSlice
    .map((m, i) => `[${i + 1}] ${m.role.toUpperCase()}:\n${m.content}`)
    .join("\n\n");

  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: `${COMPACTION_PROMPT}\n\n--- CONVERSATION TO COMPACT (${compactSlice.length} messages) ---\n\n${conversationText}`,
      },
    ],
  });

  const summary = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  if (!summary) {
    // Compaction returned nothing useful — leave history untouched rather than
    // dropping content into a void.
    return { summary: "", newContext: [...history], summarizedCount: 0 };
  }

  const synthSummary: ChatContextMessage = {
    role: "user",
    content: `[Compacted summary of ${compactSlice.length} earlier messages]\n\n${summary}`,
  };

  return {
    summary,
    newContext: [synthSummary, ...tail],
    summarizedCount: compactSlice.length,
  };
}
