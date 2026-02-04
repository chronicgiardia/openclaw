import type { RuntimeEnv } from "../../runtime.js";
import { resolveApiKeyForProvider } from "../../agents/model-auth.js";
import { loadConfig } from "../../config/config.js";

type RemoteModelEntry = {
  id: string;
  name?: string;
};

type RemoteModelsResult = {
  provider: string;
  baseUrl: string;
  models: RemoteModelEntry[];
};

const DEFAULT_OPENGATEWAY_BASE_URL = "https://apis.opengateway.sionic.im/v1";

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return trimmed;
  }
  return trimmed.replace(/\/+$/, "");
}

async function fetchRemoteModels(params: {
  provider: string;
  baseUrl: string;
  apiKey?: string;
}): Promise<RemoteModelsResult> {
  const endpoint = `${normalizeBaseUrl(params.baseUrl)}/models`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (params.apiKey) {
    headers.Authorization = `Bearer ${params.apiKey}`;
  }

  const res = await fetch(endpoint, { headers });
  if (!res.ok) {
    throw new Error(`${params.provider} /models failed: HTTP ${res.status}`);
  }
  const payload = (await res.json()) as { data?: unknown };
  const entries = Array.isArray(payload?.data) ? payload.data : [];
  const models = entries
    .map((entry): RemoteModelEntry | null => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const obj = entry as Record<string, unknown>;
      const id = typeof obj.id === "string" ? obj.id.trim() : "";
      if (!id) {
        return null;
      }
      const name = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : undefined;
      return { id, name };
    })
    .filter((entry): entry is RemoteModelEntry => Boolean(entry));

  return {
    provider: params.provider,
    baseUrl: normalizeBaseUrl(params.baseUrl),
    models,
  };
}

export async function modelsRemoteCommand(
  opts: {
    provider?: string;
    json?: boolean;
  },
  runtime: RuntimeEnv,
) {
  const provider = opts.provider?.trim() || "opengateway";
  const cfg = loadConfig();
  const providerCfg = cfg.models?.providers?.[provider];
  const baseUrl = providerCfg?.baseUrl?.trim() || DEFAULT_OPENGATEWAY_BASE_URL;

  let apiKey: string | undefined;
  try {
    const resolved = await resolveApiKeyForProvider({ provider, cfg });
    apiKey = resolved.apiKey;
  } catch {
    apiKey = undefined;
  }

  const result = await fetchRemoteModels({ provider, baseUrl, apiKey });

  if (opts.json) {
    runtime.log(JSON.stringify(result, null, 2));
    return;
  }

  runtime.log(`${result.provider} models (${result.models.length})`);
  for (const entry of result.models) {
    runtime.log(entry.name ? `${entry.id} - ${entry.name}` : entry.id);
  }
}
