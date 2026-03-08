import { describe, expect, it } from "vitest";
import { rewriteAnthropicOAuthCompatibilityText } from "./anthropic-oauth-compat.js";

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
