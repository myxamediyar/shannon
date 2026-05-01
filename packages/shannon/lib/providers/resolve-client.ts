// Client-side role resolver. Mirrors lib/providers/resolve.ts (server) but
// reads the config via lib/platform/config — works in both Tauri (fs plugin)
// and web (fetch /api/config) modes.

import { readConfig } from "@/lib/platform/config";
import type { ProviderKind, RoleName } from "./registry";

type ShannonProvider = { kind: ProviderKind; apiKey: string; baseUrl?: string };
type ShannonRole = { provider: string; model: string };
type ShannonConfigShape = {
  providers: Record<string, ShannonProvider>;
  roles: Partial<Record<RoleName, ShannonRole>>;
};

export type ResolvedRole = {
  kind: ProviderKind;
  apiKey: string;
  baseUrl?: string;
  model: string;
};

export async function resolveClientRole(name: RoleName): Promise<ResolvedRole> {
  const cfg = await readConfig<ShannonConfigShape>();
  if (!cfg) {
    throw new Error(
      `No config found. Open /model in the sidebar to set up the "${name}" role.`,
    );
  }
  const role = cfg.roles[name];
  if (!role) {
    throw new Error(
      `No provider configured for role "${name}". Open /model in the sidebar to set one up.`,
    );
  }
  const provider = cfg.providers[role.provider];
  if (!provider) {
    throw new Error(
      `Role "${name}" points to provider "${role.provider}" which isn't configured. Open /model to fix.`,
    );
  }
  if (!provider.apiKey) {
    throw new Error(
      `Provider "${role.provider}" has no API key. Open /model to add one.`,
    );
  }
  return {
    kind: provider.kind,
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    model: role.model,
  };
}
