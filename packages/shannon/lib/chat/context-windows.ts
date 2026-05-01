// Best-effort max context window per model id. Null when unknown; callers
// show "—" in that case. Matching is prefix/substring so variants line up
// (e.g. "anthropic/claude-sonnet-4-6" on OpenRouter hits the same row as
// "claude-sonnet-4-6" direct on Anthropic).

export function contextWindowFor(model: string | null | undefined): number | null {
  if (!model) return null;
  const m = model.toLowerCase();

  if (m.includes("claude-opus-4") || m.includes("claude-sonnet-4")) return 200_000;
  if (m.includes("claude-haiku-4")) return 200_000;
  if (m.includes("claude-3-7") || m.includes("claude-3-5")) return 200_000;

  if (m.startsWith("gpt-4o") || m.startsWith("openai/gpt-4o")) return 128_000;
  if (m.startsWith("gpt-4-turbo")) return 128_000;
  if (m.startsWith("gpt-4")) return 8_192;
  if (m.startsWith("gpt-3.5")) return 16_385;
  if (m.startsWith("o1") || m.startsWith("o3")) return 200_000;

  if (m === "sonar") return 127_000;
  if (m === "sonar-pro") return 200_000;
  if (m === "sonar-reasoning") return 127_000;

  if (m.includes("llama-3.3-70b")) return 131_072;
  if (m.includes("llama-3.1-8b")) return 131_072;
  if (m.includes("meta-llama-3.1-70b") || m.includes("meta-llama-3.1-8b")) return 131_072;

  if (m.startsWith("qwen2.5")) return 32_768;
  if (m.startsWith("mistral")) return 32_768;

  return null;
}
