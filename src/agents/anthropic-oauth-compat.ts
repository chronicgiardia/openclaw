import type { ModelAuthMode } from "./model-auth.js";
import { normalizeToolName } from "./tool-policy-shared.js";

export type ProviderCompatibilityMode = "default" | "anthropic-oauth-strict";

const ANTHROPIC_OAUTH_COMPAT_TOOL_NAME_MAP: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  apply_patch: "MultiEdit",
  ls: "LS",
  exec: "Bash",
  process: "Process",
  grep: "Grep",
  find: "Glob",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
  browser: "Browser",
  canvas: "Notebook",
  nodes: "Computer",
  cron: "Schedule",
  message: "Message",
  gateway: "Runtime",
  agents_list: "Agents",
  sessions_list: "TaskList",
  sessions_history: "TaskHistory",
  sessions_send: "TaskSend",
  sessions_spawn: "Task",
  subagents: "TaskManager",
  session_status: "Status",
  image: "ViewImage",
  pdf: "Document",
  tts: "Speak",
};

const ANTHROPIC_OAUTH_COMPAT_TOOL_DESCRIPTION_MAP: Partial<Record<string, string>> = {
  read: "Read file contents.",
  write: "Create or overwrite files.",
  edit: "Make precise edits to files.",
  apply_patch: "Apply structured multi-file patches.",
  ls: "List directory contents.",
  exec: "Run shell commands.",
  process: "Inspect or poll background shell commands.",
  grep: "Search file contents for patterns.",
  find: "Find files by glob pattern.",
  web_search: "Search the web.",
  web_fetch: "Fetch and extract readable content from a URL.",
  browser: "Control the browser, tabs, snapshots, screenshots, and actions.",
  canvas: "Work with notebook-style artifacts and evaluations.",
  nodes: "Discover and control paired devices and remote runtime surfaces.",
  cron: "Schedule reminders, recurring tasks, and wake events.",
  message: "Send messages and supported channel actions.",
  gateway: "Inspect runtime state, adjust configuration, restart, or update the local runtime.",
  agents_list: 'List agent ids you can target with `Task` when `runtime="subagent"`.',
  sessions_list: "List available tasks and related runs.",
  sessions_history: "Fetch history for another task or run.",
  sessions_send: "Send a message to another task or run.",
  sessions_spawn:
    'Start an isolated task or coding session. `runtime="subagent"` stays local and `runtime="acp"` uses an ACP coding agent.',
  subagents: "List, steer, or stop spawned tasks for this requester.",
  session_status: "Show runtime status, usage, time, and model details for a task.",
  image: "Analyze an image from a path or URL.",
  pdf: "Analyze a PDF from a path or URL.",
  tts: "Convert text to speech and return audio output.",
};

const OPENCLAW_BRANDING_RE = /(^|[^A-Za-z0-9_./@-])OpenClaw(?![./@_-][A-Za-z0-9_])/g;
const openclawBrandingRe = /(^|[^A-Za-z0-9_./@-])openclaw(?![./@_-][A-Za-z0-9_])/g;
const ANTHROPIC_OAUTH_COMPAT_SURFACE_TEXT_REPLACEMENTS: Array<[RegExp, string]> = [
  [/Gateway/g, "Runtime"],
  [/gateway/g, "runtime"],
  [/\bagents_list\b/g, "Agents"],
  [/\bsessions_list\b/g, "TaskList"],
  [/\bsessions_history\b/g, "TaskHistory"],
  [/\bsessions_send\b/g, "TaskSend"],
  [/\bsessions_spawn\b/g, "Task"],
  [/\bsub-agents\b/g, "tasks"],
  [/\bsub-agent\b/g, "task"],
  [/\bsubagents\b/g, "TaskManager"],
  [/\bsession_status\b/g, "Status"],
];

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

export function getAnthropicOAuthCompatibleToolName(name: string): string {
  const normalized = normalizeToolName(name);
  return ANTHROPIC_OAUTH_COMPAT_TOOL_NAME_MAP[normalized] ?? name;
}

function rewriteAnthropicOAuthCompatibilitySurfaceText(text: string): string {
  let rewritten = rewriteAnthropicOAuthCompatibilityText(text, "anthropic-oauth-strict");
  for (const [pattern, replacement] of ANTHROPIC_OAUTH_COMPAT_SURFACE_TEXT_REPLACEMENTS) {
    rewritten = rewritten.replace(pattern, replacement);
  }
  return rewritten;
}

function rewriteAnthropicOAuthCompatibilitySchema(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((value) => rewriteAnthropicOAuthCompatibilitySchema(value));
  }
  if (!node || typeof node !== "object") {
    return node;
  }
  const input = node as Record<string, unknown>;
  const rewritten: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if ((key === "description" || key === "title") && typeof value === "string") {
      rewritten[key] = rewriteAnthropicOAuthCompatibilitySurfaceText(value);
      continue;
    }
    rewritten[key] = rewriteAnthropicOAuthCompatibilitySchema(value);
  }
  return rewritten;
}

export function applyAnthropicOAuthCompatibilityToTools<
  T extends {
    name: string;
    label?: string;
    description?: string;
    parameters?: unknown;
  },
>(tools: T[]): T[] {
  return tools.map((tool) => {
    const normalized = normalizeToolName(tool.name);
    const compatName = getAnthropicOAuthCompatibleToolName(tool.name);
    const compatLabel = compatName;
    const compatDescription =
      ANTHROPIC_OAUTH_COMPAT_TOOL_DESCRIPTION_MAP[normalized] ??
      (typeof tool.description === "string"
        ? rewriteAnthropicOAuthCompatibilitySurfaceText(tool.description)
        : tool.description);
    const compatParameters = rewriteAnthropicOAuthCompatibilitySchema(tool.parameters);
    return {
      ...tool,
      name: compatName,
      label: compatLabel,
      description: compatDescription,
      parameters: compatParameters,
    };
  });
}

export function rewriteAnthropicOAuthCompatibilityText(
  text: string,
  mode?: ProviderCompatibilityMode,
): string {
  if (!text || !isAnthropicOAuthStrictCompatibilityMode(mode)) {
    return text;
  }
  return text
    .replace(OPENCLAW_BRANDING_RE, (_match, prefix: string) => `${prefix}Claude Code`)
    .replace(openclawBrandingRe, (_match, prefix: string) => `${prefix}claudecode`);
}
