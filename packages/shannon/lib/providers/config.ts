import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ProviderKind, RoleName } from "./registry";
import { ROLES } from "./registry";

export const CONFIG_DIR = path.join(homedir(), ".shannon");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

export type ProviderConfig = {
  kind: ProviderKind;
  apiKey: string;
  baseUrl?: string;
};

export type RoleConfig = {
  provider: string;
  model: string;
};

export type ShannonConfig = {
  providers: Record<string, ProviderConfig>;
  roles: Partial<Record<RoleName, RoleConfig>>;
};

const EMPTY: ShannonConfig = { providers: {}, roles: {} };

export async function readConfig(): Promise<ShannonConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    // Handle partially-written/empty files gracefully so users can recover by
    // saving again instead of getting a low-level JSON parser error.
    if (raw.trim().length === 0) return EMPTY;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e: unknown) {
      if (e instanceof SyntaxError) {
        throw new Error(
          `Config file at ${CONFIG_PATH} is invalid JSON. Fix or delete it, then save again.`,
        );
      }
      throw e;
    }
    return validateConfig(parsed);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { providers: {}, roles: {} };
    throw e;
  }
}

export async function writeConfig(cfg: ShannonConfig): Promise<void> {
  const validated = validateConfig(cfg);
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${CONFIG_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(validated, null, 2), { mode: 0o600 });
  await fs.rename(tmp, CONFIG_PATH);
}

export function validateConfig(input: unknown): ShannonConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Config must be a JSON object");
  }
  const obj = input as Record<string, unknown>;
  const providersIn = (obj.providers ?? {}) as unknown;
  const rolesIn = (obj.roles ?? {}) as unknown;

  if (!providersIn || typeof providersIn !== "object" || Array.isArray(providersIn)) {
    throw new Error("providers must be an object");
  }
  if (!rolesIn || typeof rolesIn !== "object" || Array.isArray(rolesIn)) {
    throw new Error("roles must be an object");
  }

  const providers: Record<string, ProviderConfig> = {};
  for (const [id, raw] of Object.entries(providersIn as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`providers.${id} must be an object`);
    }
    const pr = raw as Record<string, unknown>;
    const kind = pr.kind;
    const validKinds: ProviderKind[] = [
      "anthropic",
      "openai-compatible",
      "search-perplexity",
      "search-tavily",
      "search-brave",
    ];
    if (typeof kind !== "string" || !(validKinds as string[]).includes(kind)) {
      throw new Error(
        `providers.${id}.kind must be one of: ${validKinds.join(", ")}`,
      );
    }
    if (typeof pr.apiKey !== "string") {
      throw new Error(`providers.${id}.apiKey must be a string`);
    }
    if (pr.baseUrl !== undefined && pr.baseUrl !== null && typeof pr.baseUrl !== "string") {
      throw new Error(`providers.${id}.baseUrl must be a string if provided`);
    }
    const baseUrl = typeof pr.baseUrl === "string" && pr.baseUrl.length > 0 ? pr.baseUrl : undefined;
    providers[id] = { kind: kind as ProviderKind, apiKey: pr.apiKey, baseUrl };
  }

  const roles: Partial<Record<RoleName, RoleConfig>> = {};
  for (const [name, raw] of Object.entries(rolesIn as Record<string, unknown>)) {
    if (!(ROLES as readonly string[]).includes(name)) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`roles.${name} must be an object`);
    }
    const rr = raw as Record<string, unknown>;
    if (typeof rr.provider !== "string" || typeof rr.model !== "string") {
      throw new Error(`roles.${name} requires string "provider" and "model" fields`);
    }
    if (rr.provider.length === 0 || rr.model.length === 0) continue;
    roles[name as RoleName] = { provider: rr.provider, model: rr.model };
  }

  return { providers, roles };
}

export function redactConfig(cfg: ShannonConfig): ShannonConfig {
  const out: ShannonConfig = { providers: {}, roles: { ...cfg.roles } };
  for (const [id, p] of Object.entries(cfg.providers)) {
    out.providers[id] = { kind: p.kind, apiKey: maskKey(p.apiKey), baseUrl: p.baseUrl };
  }
  return out;
}

function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "***";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

// Incoming POSTs send apiKey="" as the "leave existing key alone" sentinel —
// the UI shows the masked form as a placeholder and only fills the value when
// the user actively types a new key. We also still tolerate the legacy form
// where the masked string itself comes back unchanged, so a cached client
// from before the placeholder refactor doesn't wipe its keys.
export function mergeKeepingExistingKeys(
  incoming: ShannonConfig,
  existing: ShannonConfig,
): ShannonConfig {
  const out: ShannonConfig = { providers: {}, roles: incoming.roles };
  for (const [id, p] of Object.entries(incoming.providers)) {
    const ex = existing.providers[id];
    const keepExistingKey =
      !!ex && (p.apiKey === "" || p.apiKey === maskKey(ex.apiKey));
    out.providers[id] = {
      kind: p.kind,
      apiKey: keepExistingKey ? ex.apiKey : p.apiKey,
      baseUrl: p.baseUrl,
    };
  }
  return out;
}

// Utility used by the UI to know whether a visible key field is a mask placeholder.
export function isMaskedKey(key: string): boolean {
  return /^.{4}\.\.\..{4}$/.test(key) || key === "***";
}

// Re-export for clients that just want to check the mask format.
export { maskKey };
