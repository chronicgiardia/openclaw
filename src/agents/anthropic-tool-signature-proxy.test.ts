import { describe, expect, it } from "vitest";
import {
  buildAnthropicProxyForwardHeaders,
  normalizeAnthropicProxyMountPath,
  resolveAnthropicProxyUpstreamPath,
  rewriteAnthropicProxyRequestBody,
} from "./anthropic-tool-signature-proxy.js";

describe("anthropic tool signature proxy", () => {
  it("normalizes proxy mount paths", () => {
    expect(normalizeAnthropicProxyMountPath()).toBe("/");
    expect(normalizeAnthropicProxyMountPath("anthropic")).toBe("/anthropic");
    expect(normalizeAnthropicProxyMountPath("/anthropic/")).toBe("/anthropic");
  });

  it("resolves upstream paths for mounted and direct routes", () => {
    expect(
      resolveAnthropicProxyUpstreamPath({
        pathname: "/anthropic/v1/messages",
        mountPath: "/anthropic",
      }),
    ).toBe("/v1/messages");
    expect(
      resolveAnthropicProxyUpstreamPath({
        pathname: "/v1/messages/count_tokens",
        mountPath: "/anthropic",
      }),
    ).toBe("/v1/messages/count_tokens");
    expect(
      resolveAnthropicProxyUpstreamPath({
        pathname: "/anthropic/healthz",
        mountPath: "/anthropic",
      }),
    ).toBeNull();
  });

  it("rewrites request bodies using the selected experiment variant", () => {
    const rewritten = JSON.parse(
      rewriteAnthropicProxyRequestBody({
        upstreamPath: "/v1/messages",
        variantId: "openai-functions",
        bodyText: JSON.stringify({
          tools: [
            {
              name: "read",
              description: "Read file",
              input_schema: { type: "object", properties: { path: { type: "string" } } },
            },
          ],
          tool_choice: { type: "tool", name: "read" },
        }),
      }),
    ) as {
      tools: Array<{ type?: string; function?: { name?: string } }>;
      tool_choice?: { type?: string; function?: { name?: string } };
    };

    expect(rewritten.tools[0]?.type).toBe("function");
    expect(rewritten.tools[0]?.function?.name).toBe("read");
    expect(rewritten.tool_choice?.type).toBe("function");
    expect(rewritten.tool_choice?.function?.name).toBe("read");
  });

  it("replaces incoming auth headers when an upstream API key is configured", () => {
    const headers = buildAnthropicProxyForwardHeaders({
      incomingHeaders: {
        "content-type": "application/json",
        "x-api-key": "incoming",
        authorization: "Bearer incoming",
        "anthropic-version": "2023-06-01",
      },
      upstreamApiKey: "upstream-key",
    });

    expect(headers).toEqual({
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": "upstream-key",
    });
  });
});
