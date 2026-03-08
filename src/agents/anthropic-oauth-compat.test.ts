import { describe, expect, it } from "vitest";
import {
  applyAnthropicOAuthCompatibilityToTools,
  rewriteAnthropicOAuthCompatibilityText,
} from "./anthropic-oauth-compat.js";

describe("rewriteAnthropicOAuthCompatibilityText", () => {
  it("rewrites OpenClaw branding in strict compatibility mode", () => {
    expect(
      rewriteAnthropicOAuthCompatibilityText(
        "You are OpenClaw. The package name is `openclaw`.",
        "anthropic-oauth-strict",
      ),
    ).toBe("You are Claude Code. The package name is `claudecode`.");
  });

  it("preserves path-like OpenClaw tokens", () => {
    expect(
      rewriteAnthropicOAuthCompatibilityText(
        "Config lives in ~/.openclaw/openclaw.json and openclaw-proxy stays separate.",
        "anthropic-oauth-strict",
      ),
    ).toBe("Config lives in ~/.openclaw/openclaw.json and openclaw-proxy stays separate.");
  });
});

describe("applyAnthropicOAuthCompatibilityToTools", () => {
  it("keeps the full tool surface while rewriting names, descriptions, and schema text", () => {
    const tools = applyAnthropicOAuthCompatibilityToTools([
      {
        name: "gateway",
        label: "Gateway",
        description: "Restart or inspect the OpenClaw Gateway service.",
        parameters: {
          type: "object",
          title: "GatewayTool",
          properties: {
            action: {
              type: "string",
              description: "Gateway action. Use sessions_spawn after restart.",
            },
            note: {
              type: "string",
              title: "OpenClaw note",
            },
          },
        },
      },
      {
        name: "sessions_spawn",
        description: "Spawn an OpenClaw sub-agent session.",
        parameters: {
          type: "object",
          properties: {
            task: {
              type: "string",
              description: "Task for the sub-agent.",
            },
          },
        },
      },
    ]);

    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({
      name: "Runtime",
      label: "Runtime",
      description:
        "Inspect runtime state, adjust configuration, restart, or update the local runtime.",
    });
    expect(tools[1]).toMatchObject({
      name: "Task",
      label: "Task",
      description:
        'Start an isolated task or coding session. `runtime="subagent"` stays local and `runtime="acp"` uses an ACP coding agent.',
    });
    expect(tools[0]?.parameters).toEqual({
      type: "object",
      title: "RuntimeTool",
      properties: {
        action: {
          type: "string",
          description: "Runtime action. Use Task after restart.",
        },
        note: {
          type: "string",
          title: "Claude Code note",
        },
      },
    });
    expect(tools[1]?.parameters).toEqual({
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Task for the task.",
        },
      },
    });
  });
});
