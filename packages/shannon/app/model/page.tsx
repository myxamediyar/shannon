"use client";

import { useEffect, useMemo, useState } from "react";
import {
  PROVIDER_TEMPLATES,
  ROLES,
  ROLE_LABELS,
  ROLE_DESCRIPTIONS,
  ROLE_COMPATIBLE_KINDS,
  findTemplate,
  type ProviderKind,
  type RoleName,
} from "../../lib/providers/registry";
import { listProviderModelsClient } from "../../lib/providers/list-models-client";

// Module-level model-list cache: avoids re-fetching when the same provider is
// referenced by multiple role rows or revisited within a session. 5-minute
// TTL is short enough that newly-released models surface quickly without
// turning every keystroke into an upstream call.
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const modelCache = new Map<string, { models: string[]; fetchedAt: number }>();

type ModelListState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; models: string[] }
  | { kind: "error"; message: string };

function getCachedModels(providerId: string): string[] | null {
  const entry = modelCache.get(providerId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > MODEL_CACHE_TTL_MS) {
    modelCache.delete(providerId);
    return null;
  }
  return entry.models;
}

type ProviderState = {
  kind: ProviderKind;
  /** Draft value the user types. Empty string means "leave existing key alone"
   *  on save (server's mergeKeepingExistingKeys honors the empty sentinel). */
  apiKey: string;
  /** Masked form of the currently-saved key (e.g. "sk-a...xyz"). Shown as the
   *  input's placeholder so the user can see *which* key is configured without
   *  it ever entering the editable value. Empty if no key has been saved. */
  apiKeyHint?: string;
  baseUrl?: string;
};

type RoleState = {
  provider: string;
  model: string;
};

type ConfigState = {
  providers: Record<string, ProviderState>;
  roles: Partial<Record<RoleName, RoleState>>;
};

const EMPTY: ConfigState = { providers: {}, roles: {} };

export default function ModelPage() {
  const [config, setConfig] = useState<ConfigState>(EMPTY);
  /** Snapshot of the last-loaded (or last-saved) config. We diff `config`
   *  against this on every render to decide whether the Save button enables —
   *  so typing-then-deleting a key cancels out and the button goes back idle. */
  const [loadedSnapshot, setLoadedSnapshot] = useState<ConfigState>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: "idle" | "ok" | "error"; message: string }>({
    kind: "idle",
    message: "",
  });
  const [addingProvider, setAddingProvider] = useState(false);

  const dirty = useMemo(
    () => JSON.stringify(config) !== JSON.stringify(loadedSnapshot),
    [config, loadedSnapshot],
  );

  /** Convert server-shape providers (where apiKey is the masked form) into the
   *  client's draft-shape (apiKey="" and apiKeyHint=masked). The input then
   *  shows the mask as a placeholder rather than as an editable value. */
  const fromServerProviders = (
    incoming: Record<string, { kind: ProviderKind; apiKey?: string; baseUrl?: string }>,
  ): Record<string, ProviderState> => {
    const out: Record<string, ProviderState> = {};
    for (const [id, p] of Object.entries(incoming)) {
      out[id] = {
        kind: p.kind,
        apiKey: "",
        apiKeyHint: p.apiKey ?? "",
        baseUrl: p.baseUrl,
      };
    }
    return out;
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/config");
        const json = await res.json();
        if (cancelled) return;
        if (json.status === "ok" && json.config) {
          const next: ConfigState = {
            providers: fromServerProviders(json.config.providers ?? {}),
            roles: json.config.roles ?? {},
          };
          setConfig(next);
          setLoadedSnapshot(next);
        } else if (json.status === "error") {
          setStatus({ kind: "error", message: json.message ?? "Failed to load config" });
        }
      } catch (e) {
        if (!cancelled) {
          setStatus({
            kind: "error",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const providerIds = useMemo(() => Object.keys(config.providers), [config.providers]);

  /** Clear any "Saved"/"Error" status banner the moment the user starts
   *  editing again. Dirty itself is derived from config vs loadedSnapshot. */
  const markDirty = () => {
    setStatus({ kind: "idle", message: "" });
  };

  const addProviderFromTemplate = (templateId: string) => {
    const template = findTemplate(templateId);
    if (!template) return;
    let id = template.id;
    let n = 2;
    while (config.providers[id]) {
      id = `${template.id}-${n++}`;
    }
    setConfig((prev) => ({
      ...prev,
      providers: {
        ...prev.providers,
        [id]: {
          kind: template.kind,
          apiKey: "",
          apiKeyHint: "",
          baseUrl: template.defaultBaseUrl,
        },
      },
    }));
    setAddingProvider(false);
    markDirty();
  };

  const removeProvider = (id: string) => {
    setConfig((prev) => {
      const nextProviders = { ...prev.providers };
      delete nextProviders[id];
      const nextRoles: Partial<Record<RoleName, RoleState>> = {};
      for (const [k, v] of Object.entries(prev.roles)) {
        if (v && v.provider !== id) nextRoles[k as RoleName] = v;
      }
      return { providers: nextProviders, roles: nextRoles };
    });
    markDirty();
  };

  const updateProvider = (id: string, patch: Partial<ProviderState>) => {
    setConfig((prev) => ({
      ...prev,
      providers: { ...prev.providers, [id]: { ...prev.providers[id], ...patch } },
    }));
    markDirty();
  };

  const renameProvider = (oldId: string, newId: string) => {
    if (!newId || newId === oldId || config.providers[newId]) return;
    setConfig((prev) => {
      const nextProviders: Record<string, ProviderState> = {};
      for (const [k, v] of Object.entries(prev.providers)) {
        nextProviders[k === oldId ? newId : k] = v;
      }
      const nextRoles: Partial<Record<RoleName, RoleState>> = {};
      for (const [k, v] of Object.entries(prev.roles)) {
        if (!v) continue;
        nextRoles[k as RoleName] = v.provider === oldId ? { ...v, provider: newId } : v;
      }
      return { providers: nextProviders, roles: nextRoles };
    });
    markDirty();
  };

  const updateRole = (role: RoleName, patch: Partial<RoleState>) => {
    setConfig((prev) => {
      const current = prev.roles[role] ?? { provider: "", model: "" };
      const next = { ...current, ...patch };
      if (!next.provider || !next.model) {
        const copy = { ...prev.roles };
        copy[role] = next;
        return { ...prev, roles: copy };
      }
      return { ...prev, roles: { ...prev.roles, [role]: next } };
    });
    markDirty();
  };

  const clearRole = (role: RoleName) => {
    setConfig((prev) => {
      const copy = { ...prev.roles };
      delete copy[role];
      return { ...prev, roles: copy };
    });
    markDirty();
  };

  const save = async () => {
    setSaving(true);
    setStatus({ kind: "idle", message: "" });
    try {
      // Strip apiKeyHint before sending — it's a UI-only field. apiKey="" is
      // the wire signal for "leave existing key alone".
      const wireProviders: Record<string, { kind: ProviderKind; apiKey: string; baseUrl?: string }> = {};
      for (const [id, p] of Object.entries(config.providers)) {
        wireProviders[id] = { kind: p.kind, apiKey: p.apiKey, baseUrl: p.baseUrl };
      }
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: { providers: wireProviders, roles: config.roles } }),
      });
      const json = await res.json();
      if (json.status === "ok" && json.config) {
        const next: ConfigState = {
          providers: fromServerProviders(json.config.providers ?? {}),
          roles: json.config.roles ?? {},
        };
        setConfig(next);
        setLoadedSnapshot(next);
        setStatus({ kind: "ok", message: "Saved to ~/.shannon/config.json" });
      } else {
        setStatus({ kind: "error", message: json.message ?? "Save failed" });
      }
    } catch (e) {
      setStatus({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto py-16 px-6 font-lexend">
      <h1 className="font-extrabold text-3xl text-[var(--th-text)] tracking-tighter mb-1">Model</h1>
      <p className="text-sm text-[var(--th-text-muted)] mb-10">
        Configure API keys and pick which model runs each role. Keys are stored on your machine at{" "}
        <code className="font-mono text-[var(--th-text)]">~/.shannon/config.json</code>.
      </p>

      {loading ? (
        <p className="text-sm text-[var(--th-text-muted)]">Loading…</p>
      ) : (
        <>
          <div className="mb-10 flex items-center gap-4">
            <button
              onClick={save}
              disabled={!dirty || saving}
              className="px-4 py-1.5 rounded-md text-xs font-bold bg-[#6c63ff] text-white transition-opacity disabled:opacity-40"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => {
                setConfig(loadedSnapshot);
                setStatus({ kind: "idle", message: "" });
              }}
              disabled={!dirty || saving}
              className="px-4 py-1.5 rounded-md text-xs font-bold text-[var(--th-text-muted)] border border-[var(--th-border-10)] hover:border-[var(--th-border-20)] hover:text-[var(--th-text)] transition-colors disabled:opacity-40 disabled:hover:border-[var(--th-border-10)] disabled:hover:text-[var(--th-text-muted)]"
            >
              Cancel
            </button>
            {status.kind === "ok" && (
              <span className="text-xs text-[var(--th-text-muted)]">{status.message}</span>
            )}
            {status.kind === "error" && (
              <span className="text-xs text-red-500">{status.message}</span>
            )}
            {dirty && status.kind === "idle" && (
              <span className="text-xs text-[var(--th-text-faint)]">Unsaved changes</span>
            )}
          </div>

          <section>
            <h2 className="text-[0.625rem] font-bold uppercase tracking-[0.18em] text-[var(--th-text-faint)] mb-4">
              Roles
            </h2>

            <div className="space-y-4">
              {ROLES.map((role) => (
                <RoleRow
                  key={role}
                  role={role}
                  state={config.roles[role]}
                  providers={config.providers}
                  onChange={(patch) => updateRole(role, patch)}
                  onClear={() => clearRole(role)}
                />
              ))}
            </div>
          </section>

          <section className="mt-12">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[0.625rem] font-bold uppercase tracking-[0.18em] text-[var(--th-text-faint)]">
                Providers
              </h2>
              <button
                onClick={() => setAddingProvider(true)}
                className="text-xs font-bold text-[#6c63ff] hover:underline"
              >
                + Add provider
              </button>
            </div>

            {addingProvider && (
              <div className="mb-4 p-4 rounded-lg border border-[var(--th-border-10)] bg-[var(--th-surface-hover)]">
                <div className="text-xs font-bold uppercase tracking-wider text-[var(--th-text-muted)] mb-3">
                  Pick a template
                </div>
                <div className="flex flex-wrap gap-2">
                  {PROVIDER_TEMPLATES.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => addProviderFromTemplate(t.id)}
                      className="px-3 py-1 rounded-md text-xs font-bold bg-[var(--th-divider)] text-[var(--th-text-muted)] hover:text-[var(--th-text)] hover:bg-[#6c63ff] hover:text-white transition-colors"
                    >
                      {t.label}
                    </button>
                  ))}
                  <button
                    onClick={() => setAddingProvider(false)}
                    className="px-3 py-1 rounded-md text-xs font-bold text-[var(--th-text-faint)] hover:text-[var(--th-text)]"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {providerIds.length === 0 ? (
              <p className="text-sm text-[var(--th-text-muted)] py-4">
                No providers yet. Click <b>+ Add provider</b> above to add one.
              </p>
            ) : (
              <div className="space-y-3">
                {providerIds.map((id) => (
                  <ProviderCard
                    key={id}
                    id={id}
                    state={config.providers[id]}
                    onRename={(newId) => renameProvider(id, newId)}
                    onChange={(patch) => updateProvider(id, patch)}
                    onRemove={() => removeProvider(id)}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function ProviderCard({
  id,
  state,
  onRename,
  onChange,
  onRemove,
}: {
  id: string;
  state: ProviderState;
  onRename: (newId: string) => void;
  onChange: (patch: Partial<ProviderState>) => void;
  onRemove: () => void;
}) {
  const [idDraft, setIdDraft] = useState(id);
  useEffect(() => setIdDraft(id), [id]);
  const template = findTemplate(id.replace(/-\d+$/, ""));
  const docsUrl = template?.docsUrl;

  return (
    <div className="p-4 rounded-lg border border-[var(--th-border-10)] bg-[var(--th-surface)]">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <input
              value={idDraft}
              onChange={(e) => setIdDraft(e.target.value)}
              onBlur={() => onRename(idDraft.trim())}
              className="text-sm font-bold text-[var(--th-text)] bg-transparent border-b border-transparent focus:border-[var(--th-border-10)] focus:outline-none py-0.5"
            />
            <span className="text-[0.6rem] font-mono uppercase text-[var(--th-text-faint)] px-1.5 py-0.5 rounded bg-[var(--th-divider)]">
              {state.kind}
            </span>
          </div>
          {docsUrl && (
            <a
              href={docsUrl}
              target="_blank"
              rel="noreferrer"
              className="text-[0.65rem] text-[var(--th-text-faint)] hover:text-[#6c63ff] underline"
            >
              Get a key →
            </a>
          )}
        </div>
        <button
          onClick={onRemove}
          className="text-xs text-[var(--th-text-faint)] hover:text-red-500"
        >
          Remove
        </button>
      </div>

      <div className="space-y-2">
        <LabeledField label="API key">
          <input
            type="text"
            value={state.apiKey}
            onChange={(e) => onChange({ apiKey: e.target.value })}
            placeholder={state.apiKeyHint && state.apiKeyHint.length > 0 ? state.apiKeyHint : "sk-..."}
            spellCheck={false}
            autoComplete="off"
            className="w-full px-2 py-1 rounded text-xs font-mono bg-[var(--th-divider)] text-[var(--th-text)] border border-transparent focus:border-[#6c63ff] focus:outline-none placeholder:text-[var(--th-text-faint)]"
          />
          {state.apiKeyHint && state.apiKeyHint.length > 0 && (
            <p className="text-[0.6rem] text-[var(--th-text-faint)] mt-1">
              Leave blank to keep the saved key.
            </p>
          )}
        </LabeledField>

        {state.kind === "openai-compatible" && (
          <LabeledField label="Base URL">
            <input
              type="text"
              value={state.baseUrl ?? ""}
              onChange={(e) => onChange({ baseUrl: e.target.value })}
              placeholder="https://api.openai.com/v1"
              spellCheck={false}
              autoComplete="off"
              className="w-full px-2 py-1 rounded text-xs font-mono bg-[var(--th-divider)] text-[var(--th-text)] border border-transparent focus:border-[#6c63ff] focus:outline-none"
            />
          </LabeledField>
        )}
      </div>
    </div>
  );
}

function RoleRow({
  role,
  state,
  providers,
  onChange,
  onClear,
}: {
  role: RoleName;
  state: RoleState | undefined;
  providers: Record<string, ProviderState>;
  onChange: (patch: Partial<RoleState>) => void;
  onClear: () => void;
}) {
  const allowedKinds = ROLE_COMPATIBLE_KINDS[role];
  const compatibleIds = Object.entries(providers)
    .filter(([, p]) => allowedKinds.includes(p.kind))
    .map(([id]) => id);
  const selectedProviderId = state?.provider ?? "";
  const listId = `role-${role}-models`;

  // Live-fetched model list for the selected provider. Falls back to a clear
  // error message — there's no static suggestion list anymore.
  const selectedHasSavedKey = !!providers[selectedProviderId]?.apiKeyHint;
  const [modelList, setModelList] = useState<ModelListState>({ kind: "idle" });

  useEffect(() => {
    if (!selectedProviderId) {
      setModelList({ kind: "idle" });
      return;
    }
    if (!selectedHasSavedKey) {
      setModelList({
        kind: "error",
        message: "Save provider with an API key first to fetch its model list.",
      });
      return;
    }
    const cached = getCachedModels(selectedProviderId);
    if (cached) {
      setModelList({ kind: "ok", models: cached });
      return;
    }
    setModelList({ kind: "loading" });
    let cancelled = false;
    listProviderModelsClient(selectedProviderId)
      .then((models) => {
        if (cancelled) return;
        modelCache.set(selectedProviderId, { models, fetchedAt: Date.now() });
        setModelList({ kind: "ok", models });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setModelList({
          kind: "error",
          message: `Unable to fetch model list: ${e instanceof Error ? e.message : String(e)}`,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProviderId, selectedHasSavedKey]);

  const suggestions = modelList.kind === "ok" ? modelList.models : [];

  return (
    <div className="p-4 rounded-lg border border-[var(--th-border-10)] bg-[var(--th-surface)]">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-sm font-bold text-[var(--th-text)]">{ROLE_LABELS[role]}</span>
        {state && (
          <button
            onClick={onClear}
            className="text-[0.65rem] text-[var(--th-text-faint)] hover:text-red-500"
          >
            Clear
          </button>
        )}
      </div>
      <p className="text-[0.65rem] text-[var(--th-text-faint)] mb-3">{ROLE_DESCRIPTIONS[role]}</p>

      <div className="grid grid-cols-2 gap-2">
        <LabeledField label="Provider">
          <select
            value={selectedProviderId}
            onChange={(e) => onChange({ provider: e.target.value })}
            className="w-full px-2 py-1 rounded text-xs bg-[var(--th-divider)] text-[var(--th-text)] border border-transparent focus:border-[#6c63ff] focus:outline-none"
          >
            <option value="">— none —</option>
            {compatibleIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          {compatibleIds.length === 0 && (
            <p className="text-[0.6rem] text-[var(--th-text-faint)] mt-1">
              No compatible providers. This role needs a {allowedKinds.join(" or ")} provider.
            </p>
          )}
        </LabeledField>

        <LabeledField label="Model">
          <input
            type="text"
            list={listId}
            value={state?.model ?? ""}
            onChange={(e) => onChange({ model: e.target.value })}
            placeholder="model id"
            spellCheck={false}
            autoComplete="off"
            disabled={!selectedProviderId}
            className="w-full px-2 py-1 rounded text-xs font-mono bg-[var(--th-divider)] text-[var(--th-text)] border border-transparent focus:border-[#6c63ff] focus:outline-none disabled:opacity-40"
          />
          <datalist id={listId}>
            {suggestions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {selectedProviderId && modelList.kind === "loading" && (
            <p className="text-[0.6rem] text-[var(--th-text-faint)] mt-1">Fetching model list…</p>
          )}
          {selectedProviderId && modelList.kind === "error" && (
            <p className="text-[0.6rem] text-[var(--th-text-faint)] mt-1" title={modelList.message}>
              {modelList.message}
            </p>
          )}
        </LabeledField>
      </div>
    </div>
  );
}

function LabeledField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[0.6rem] font-bold uppercase tracking-wider text-[var(--th-text-faint)] mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}
