import type { ModelAuthMode } from "./model-auth.js";
import { normalizeToolName } from "./tool-policy-shared.js";

export type ProviderCompatibilityMode = "default" | "anthropic-oauth-strict";

const ANTHROPIC_OAUTH_COMPAT_ALLOWED_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "exec",
  "grep",
  "find",
  "web_search",
  "web_fetch",
]);

const ANTHROPIC_OAUTH_COMPAT_TOOL_NAME_MAP: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  exec: "Bash",
  grep: "Grep",
  find: "Glob",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
};

export function resolveProviderCompatibilityMode(params: {
  modelProvider?: string;
  modelAuthMode?: ModelAuthMode;
}): ProviderCompatibilityMode {
  const provider = params.modelProvider?.trim().toLowerCase();
  return provider === "anthropic" && params.modelAuthMode === "oauth"
    ? "anthropic-oauth-strict"
    : "default";
}

export function isAnthropicOAuthStrictCompatibilityMode(mode?: ProviderCompatibilityMode): boolean {
  return mode === "anthropic-oauth-strict";
}

export function isAnthropicOAuthCompatibleToolName(name: string): boolean {
  return ANTHROPIC_OAUTH_COMPAT_ALLOWED_TOOLS.has(normalizeToolName(name));
}

export function getAnthropicOAuthCompatibleToolName(name: string): string {
  const normalized = normalizeToolName(name);
  return ANTHROPIC_OAUTH_COMPAT_TOOL_NAME_MAP[normalized] ?? name;
}

export function applyAnthropicOAuthCompatibilityToTools<
  T extends {
    name: string;
    label?: string;
  },
>(tools: T[]): T[] {
  return tools
    .filter((tool) => isAnthropicOAuthCompatibleToolName(tool.name))
    .map((tool) => {
      const compatName = getAnthropicOAuthCompatibleToolName(tool.name);
      const compatLabel = compatName;
      if (compatName === tool.name && compatLabel === tool.label) {
        return tool;
      }
      return {
        ...tool,
        name: compatName,
        label: compatLabel,
      };
    });
}
