import type { AnyAgentTool } from "./tools/common.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { deriveSessionChatType } from "../sessions/session-key-utils.js";
import { normalizeToolName } from "./tool-policy.js";

type HookContext = {
  agentId?: string;
  sessionKey?: string;
};

type HookOutcome = { blocked: true; reason: string } | { blocked: false; params: unknown };

const log = createSubsystemLogger("agents/tools");
const SHELL_SEGMENT_SPLIT_RE = /&&|\|\||;|\||\n/;
const LEADING_EXEC_PREFIX_PATTERNS = [
  /^(?:sudo|command|builtin|exec|nohup)\s+/,
  /^timeout\s+\S+\s+/,
  /^env\s+(?:[a-z_][a-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/i,
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractExecCommand(params: unknown): string | undefined {
  if (!isPlainObject(params)) {
    return undefined;
  }
  const command =
    typeof params.command === "string"
      ? params.command
      : typeof params.cmd === "string"
        ? params.cmd
        : undefined;
  const trimmed = command?.trim();
  return trimmed || undefined;
}

function normalizeShellSegment(segment: string): string {
  let normalized = segment.trim().toLowerCase();
  let changed = true;
  while (changed && normalized) {
    changed = false;
    for (const pattern of LEADING_EXEC_PREFIX_PATTERNS) {
      const next = normalized.replace(pattern, "");
      if (next !== normalized) {
        normalized = next.trimStart();
        changed = true;
      }
    }
  }
  return normalized;
}

function isGatewayLifecycleSegment(segment: string): boolean {
  const normalized = normalizeShellSegment(segment);
  if (!normalized) {
    return false;
  }
  return (
    /^(?:pnpm\s+openclaw|npx\s+openclaw|openclaw)\s+gateway\s+(?:restart|run|start|stop)\b/.test(
      normalized,
    ) ||
    /^node\s+\S+\s+gateway\s+(?:restart|run|start|stop)\b/.test(normalized) ||
    /^(?:pkill|killall)\b[\s\S]*\bopenclaw-gateway\b/.test(normalized)
  );
}

function resolveGatewayLifecycleExecBlockReason(args: {
  toolName: string;
  params: unknown;
  ctx?: HookContext;
}): string | undefined {
  if (normalizeToolName(args.toolName || "tool") !== "exec") {
    return undefined;
  }
  const sessionKey = args.ctx?.sessionKey?.trim();
  if (!sessionKey || deriveSessionChatType(sessionKey) === "unknown") {
    return undefined;
  }
  const command = extractExecCommand(args.params);
  if (!command) {
    return undefined;
  }
  const blocksGatewayLifecycle = command
    .split(SHELL_SEGMENT_SPLIT_RE)
    .some((segment) => isGatewayLifecycleSegment(segment));
  if (!blocksGatewayLifecycle) {
    return undefined;
  }
  return (
    "Do not manage the OpenClaw gateway from a live chat session via exec. " +
    "It can interrupt the current reply mid-turn. Use a control shell or a non-chat session instead."
  );
}

export async function runBeforeToolCallHook(args: {
  toolName: string;
  params: unknown;
  toolCallId?: string;
  ctx?: HookContext;
}): Promise<HookOutcome> {
  const toolName = normalizeToolName(args.toolName || "tool");
  const params = args.params;
  const gatewayLifecycleBlockReason = resolveGatewayLifecycleExecBlockReason({
    toolName,
    params,
    ctx: args.ctx,
  });
  if (gatewayLifecycleBlockReason) {
    return {
      blocked: true,
      reason: gatewayLifecycleBlockReason,
    };
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_tool_call")) {
    return { blocked: false, params: args.params };
  }

  try {
    const normalizedParams = isPlainObject(params) ? params : {};
    const hookResult = await hookRunner.runBeforeToolCall(
      {
        toolName,
        params: normalizedParams,
      },
      {
        toolName,
        agentId: args.ctx?.agentId,
        sessionKey: args.ctx?.sessionKey,
      },
    );

    if (hookResult?.block) {
      return {
        blocked: true,
        reason: hookResult.blockReason || "Tool call blocked by plugin hook",
      };
    }

    if (hookResult?.params && isPlainObject(hookResult.params)) {
      if (isPlainObject(params)) {
        return { blocked: false, params: { ...params, ...hookResult.params } };
      }
      return { blocked: false, params: hookResult.params };
    }
  } catch (err) {
    const toolCallId = args.toolCallId ? ` toolCallId=${args.toolCallId}` : "";
    log.warn(`before_tool_call hook failed: tool=${toolName}${toolCallId} error=${String(err)}`);
  }

  return { blocked: false, params };
}

export function wrapToolWithBeforeToolCallHook(
  tool: AnyAgentTool,
  ctx?: HookContext,
): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const toolName = tool.name || "tool";
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const outcome = await runBeforeToolCallHook({
        toolName,
        params,
        toolCallId,
        ctx,
      });
      if (outcome.blocked) {
        throw new Error(outcome.reason);
      }
      return await execute(toolCallId, outcome.params, signal, onUpdate);
    },
  };
}

export const __testing = {
  runBeforeToolCallHook,
  isPlainObject,
};
