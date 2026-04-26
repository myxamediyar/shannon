import Anthropic from "@anthropic-ai/sdk";

export function createAnthropic(apiKey: string): Anthropic {
  return new Anthropic({ apiKey });
}
