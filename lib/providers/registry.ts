export type ProviderKind =
  | "anthropic"
  | "openai-compatible"
  | "search-perplexity"
  | "search-tavily"
  | "search-brave";

export const SEARCH_KINDS: ProviderKind[] = [
  "search-perplexity",
  "search-tavily",
  "search-brave",
];

export type ProviderTemplate = {
  id: string;
  label: string;
  kind: ProviderKind;
  defaultBaseUrl?: string;
  suggestedModels: string[];
  docsUrl: string;
};

export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    kind: "anthropic",
    suggestedModels: [
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
      "claude-sonnet-4-20250514",
      "claude-opus-4-6",
    ],
    docsUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai-compatible",
    defaultBaseUrl: "https://api.openai.com/v1",
    suggestedModels: ["gpt-4o", "gpt-4o-mini", "o1", "o1-mini"],
    docsUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "perplexity",
    label: "Perplexity (chat)",
    kind: "openai-compatible",
    defaultBaseUrl: "https://api.perplexity.ai",
    suggestedModels: ["sonar", "sonar-pro", "sonar-reasoning"],
    docsUrl: "https://docs.perplexity.ai/guides/getting-started",
  },
  {
    id: "perplexity-search",
    label: "Perplexity (search)",
    kind: "search-perplexity",
    defaultBaseUrl: "https://api.perplexity.ai",
    suggestedModels: ["sonar", "sonar-pro", "sonar-reasoning"],
    docsUrl: "https://docs.perplexity.ai/guides/getting-started",
  },
  {
    id: "tavily",
    label: "Tavily Search",
    kind: "search-tavily",
    defaultBaseUrl: "https://api.tavily.com",
    suggestedModels: ["basic", "advanced"],
    docsUrl: "https://docs.tavily.com/welcome",
  },
  {
    id: "brave",
    label: "Brave Search",
    kind: "search-brave",
    defaultBaseUrl: "https://api.search.brave.com/res/v1",
    suggestedModels: ["web"],
    docsUrl: "https://brave.com/search/api/",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai-compatible",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    suggestedModels: [
      "anthropic/claude-opus-4-7",
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-4o",
      "meta-llama/llama-3.3-70b-instruct",
    ],
    docsUrl: "https://openrouter.ai/keys",
  },
  {
    id: "groq",
    label: "Groq",
    kind: "openai-compatible",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    suggestedModels: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
    docsUrl: "https://console.groq.com/keys",
  },
  {
    id: "together",
    label: "Together",
    kind: "openai-compatible",
    defaultBaseUrl: "https://api.together.xyz/v1",
    suggestedModels: ["meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo"],
    docsUrl: "https://api.together.ai/settings/api-keys",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    kind: "openai-compatible",
    defaultBaseUrl: "http://localhost:11434/v1",
    suggestedModels: ["llama3.1", "qwen2.5", "mistral"],
    docsUrl: "https://ollama.com/download",
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    kind: "openai-compatible",
    suggestedModels: [],
    docsUrl: "https://platform.openai.com/docs/api-reference/chat",
  },
];

export function findTemplate(id: string): ProviderTemplate | undefined {
  return PROVIDER_TEMPLATES.find((t) => t.id === id);
}

export const ROLES = ["chat", "websearch"] as const;
export type RoleName = (typeof ROLES)[number];

export const ROLE_LABELS: Record<RoleName, string> = {
  chat: "Chat",
  websearch: "Web search",
};

export const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
  chat: "Main tutor conversation. Uses tool calls to draw on the whiteboard.",
  websearch: "Invoked by chat as a tool when answers need live web results.",
};

export const ROLE_COMPATIBLE_KINDS: Record<RoleName, ProviderKind[]> = {
  chat: ["anthropic", "openai-compatible"],
  websearch: SEARCH_KINDS,
};
