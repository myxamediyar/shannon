import { readConfig } from "./config";
import type { ProviderKind, RoleName } from "./registry";

export type ResolvedRole = {
  kind: ProviderKind;
  apiKey: string;
  baseUrl?: string;
  model: string;
};

export async function resolveRole(name: RoleName): Promise<ResolvedRole> {
  const cfg = await readConfig();
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
