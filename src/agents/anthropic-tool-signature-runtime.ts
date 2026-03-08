import {
  ANTHROPIC_TOOL_SIGNATURE_EXPERIMENTS,
  type AnthropicToolSignatureExperiment,
} from "./anthropic-tool-signature-experiments.js";

type AnthropicToolSignatureTarget = {
  api?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
};

export type ParsedAnthropicToolSignatureExperimentConfig = {
  configured: "auto" | "off" | AnthropicToolSignatureExperiment["id"];
  ignored?: { kind: "non-string"; value: unknown } | { kind: "unknown"; value: string };
};

export type AnthropicToolSignatureRuntimeStatus = {
  configured: ParsedAnthropicToolSignatureExperimentConfig["configured"];
  active: AnthropicToolSignatureExperiment["id"] | null;
  source: "configured" | "auto:kimi-coding" | "auto:official-anthropic" | "auto:none";
  api?: string;
  provider?: string;
  baseUrl?: string;
  ignored?: ParsedAnthropicToolSignatureExperimentConfig["ignored"];
};

export function parseAnthropicToolSignatureExperimentConfig(
  value: unknown,
): ParsedAnthropicToolSignatureExperimentConfig {
  if (value === undefined) {
    return { configured: "auto" };
  }
  if (typeof value !== "string") {
    return {
      configured: "auto",
      ignored: { kind: "non-string", value },
    };
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed === "auto") {
    return { configured: "auto" };
  }
  if (trimmed === "off") {
    return { configured: "off" };
  }

  const match = ANTHROPIC_TOOL_SIGNATURE_EXPERIMENTS.find(
    (experiment) => experiment.id === trimmed,
  );
  if (match) {
    return { configured: match.id };
  }

  return {
    configured: "auto",
    ignored: { kind: "unknown", value: trimmed },
  };
}

export function isKimiCodingAnthropicEndpoint(model: AnthropicToolSignatureTarget): boolean {
  if (model.api !== "anthropic-messages") {
    return false;
  }

  if (typeof model.provider === "string" && model.provider.trim().toLowerCase() === "kimi-coding") {
    return true;
  }

  if (typeof model.baseUrl !== "string" || !model.baseUrl.trim()) {
    return false;
  }

  try {
    const parsed = new URL(model.baseUrl);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    return host.endsWith("kimi.com") && pathname.startsWith("/coding");
  } catch {
    const normalized = model.baseUrl.toLowerCase();
    return normalized.includes("kimi.com/coding");
  }
}

export function isOfficialAnthropicMessagesEndpoint(model: AnthropicToolSignatureTarget): boolean {
  if (model.api !== "anthropic-messages") {
    return false;
  }

  if (typeof model.baseUrl === "string" && model.baseUrl.trim()) {
    try {
      const parsed = new URL(model.baseUrl);
      const host = parsed.hostname.toLowerCase();
      return host === "anthropic.com" || host.endsWith(".anthropic.com");
    } catch {
      const normalized = model.baseUrl.toLowerCase();
      return normalized.includes("anthropic.com");
    }
  }

  return typeof model.provider === "string" && model.provider.trim().toLowerCase() === "anthropic";
}

export function resolveAnthropicToolSignatureRuntimeStatus(
  params: AnthropicToolSignatureTarget & {
    configuredExperiment?: unknown;
  },
): AnthropicToolSignatureRuntimeStatus {
  const parsed = parseAnthropicToolSignatureExperimentConfig(params.configuredExperiment);
  const statusBase = {
    configured: parsed.configured,
    api: typeof params.api === "string" ? params.api : undefined,
    provider: typeof params.provider === "string" ? params.provider : undefined,
    baseUrl: typeof params.baseUrl === "string" ? params.baseUrl : undefined,
    ...(parsed.ignored ? { ignored: parsed.ignored } : {}),
  } satisfies Omit<AnthropicToolSignatureRuntimeStatus, "active" | "source">;

  if (parsed.configured === "off") {
    return {
      ...statusBase,
      active: null,
      source: "configured",
    };
  }
  if (parsed.configured !== "auto") {
    return {
      ...statusBase,
      active: parsed.configured,
      source: "configured",
    };
  }
  if (isKimiCodingAnthropicEndpoint(params)) {
    return {
      ...statusBase,
      active: "openai-functions",
      source: "auto:kimi-coding",
    };
  }
  if (isOfficialAnthropicMessagesEndpoint(params)) {
    return {
      ...statusBase,
      active: "anthropic-explicit-custom",
      source: "auto:official-anthropic",
    };
  }
  return {
    ...statusBase,
    active: null,
    source: "auto:none",
  };
}

export function resolveConfiguredAnthropicToolSignatureExperiment(
  value: unknown,
): AnthropicToolSignatureExperiment["id"] | null | undefined {
  const parsed = parseAnthropicToolSignatureExperimentConfig(value);
  if (parsed.configured === "auto") {
    return undefined;
  }
  if (parsed.configured === "off") {
    return null;
  }
  return parsed.configured;
}

export function resolveAnthropicToolSignatureExperimentId(
  params: AnthropicToolSignatureTarget & {
    configuredExperiment?: unknown;
  },
): AnthropicToolSignatureExperiment["id"] | undefined {
  return resolveAnthropicToolSignatureRuntimeStatus(params).active ?? undefined;
}
