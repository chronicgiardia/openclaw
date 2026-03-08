import type { IncomingHttpHeaders } from "node:http";
import {
  applyAnthropicToolSignatureExperiment,
  type AnthropicToolSignatureExperiment,
} from "./anthropic-tool-signature-experiments.js";

const SUPPORTED_ANTHROPIC_PROXY_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeAnthropicProxyMountPath(raw?: string): string {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return prefixed.endsWith("/") ? prefixed.slice(0, -1) : prefixed;
}

export function resolveAnthropicProxyUpstreamPath(params: {
  pathname: string;
  mountPath?: string;
}): string | null {
  const mountPath = normalizeAnthropicProxyMountPath(params.mountPath);
  const pathname = params.pathname || "/";

  if (SUPPORTED_ANTHROPIC_PROXY_PATHS.has(pathname)) {
    return pathname;
  }

  if (mountPath !== "/" && pathname.startsWith(`${mountPath}/`)) {
    const stripped = pathname.slice(mountPath.length);
    return SUPPORTED_ANTHROPIC_PROXY_PATHS.has(stripped) ? stripped : null;
  }

  return null;
}

export function rewriteAnthropicProxyRequestBody(params: {
  bodyText: string;
  upstreamPath: string;
  variantId: AnthropicToolSignatureExperiment["id"];
}): string {
  if (!SUPPORTED_ANTHROPIC_PROXY_PATHS.has(params.upstreamPath)) {
    return params.bodyText;
  }
  if (!params.bodyText.trim()) {
    return params.bodyText;
  }

  const parsed = JSON.parse(params.bodyText) as unknown;
  if (!isRecord(parsed)) {
    return params.bodyText;
  }

  const rewritten = applyAnthropicToolSignatureExperiment(parsed, params.variantId);
  return JSON.stringify(rewritten);
}

export function buildAnthropicProxyForwardHeaders(params: {
  incomingHeaders: IncomingHttpHeaders;
  upstreamApiKey?: string;
}): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(params.incomingHeaders)) {
    if (!value) {
      continue;
    }
    const normalized = key.toLowerCase();
    if (
      normalized === "host" ||
      normalized === "content-length" ||
      normalized === "connection" ||
      normalized === "x-forwarded-for"
    ) {
      continue;
    }
    if (params.upstreamApiKey && (normalized === "x-api-key" || normalized === "authorization")) {
      continue;
    }
    next[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  if (params.upstreamApiKey) {
    next["x-api-key"] = params.upstreamApiKey;
  }
  return next;
}
