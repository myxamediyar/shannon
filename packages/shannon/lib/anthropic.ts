import { resolveRole } from "./providers/resolve";
import { createAnthropic } from "./providers/anthropic-client";

// ── Constants ────────────────────────────────────────────────────────────────

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

// ── pingAnthropic (from main.py) ─────────────────────────────────────────────

export async function pingAnthropic(userIn: string): Promise<string> {
  const role = await resolveRole("chat");
  if (role.kind !== "anthropic") {
    throw new Error(`pingAnthropic requires an Anthropic provider; chat role is "${role.kind}".`);
  }
  const client = createAnthropic(role.apiKey);
  const message = await client.messages.create({
    max_tokens: 1024,
    model: role.model,
    messages: [
      {
        role: "user",
        content: `Hello, Claude. Respond to the following user input: ${userIn}`,
      },
    ],
  });
  const block = message.content[0];
  const text = block.type === "text" ? block.text : JSON.stringify(block);
  return "\n--- processed by main_loop method ---\n " + text;
}

