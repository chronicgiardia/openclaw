import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_TOOL_SIGNATURE_EXPERIMENTS,
  applyAnthropicToolSignatureExperiment,
  buildAnthropicToolExperimentPayload,
} from "./anthropic-tool-signature-experiments.js";

describe("anthropic tool signature experiments", () => {
  function buildPayload() {
    return buildAnthropicToolExperimentPayload({
      tools: [
        {
          name: "read",
          description: "Read a file",
          parameters: Type.Object({
            path: Type.String({ description: "Path", title: "Path" }),
            offset: Type.Optional(Type.Number({ title: "Offset" })),
          }),
        },
      ],
      toolChoice: { type: "tool", name: "read" },
    });
  }

  it("builds an Anthropic-native payload from tool definitions", () => {
    expect(buildPayload()).toEqual({
      tools: [
        {
          name: "read",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path", title: "Path" },
              offset: { type: "number", title: "Offset" },
            },
            required: ["path"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "read" },
    });
  });

  it("converts Anthropic-native payloads to OpenAI function envelopes", () => {
    const payload = applyAnthropicToolSignatureExperiment(buildPayload(), "openai-functions");

    expect(payload).toEqual({
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "Path", title: "Path" },
                offset: { type: "number", title: "Offset" },
              },
              required: ["path"],
            },
          },
        },
      ],
      tool_choice: {
        type: "function",
        function: { name: "read" },
      },
    });
  });

  it("compacts schemas by stripping title fields recursively", () => {
    const payload = applyAnthropicToolSignatureExperiment(
      buildPayload(),
      "anthropic-native-compact",
    );

    expect(payload).toEqual({
      tools: [
        {
          name: "read",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path" },
              offset: { type: "number" },
            },
            required: ["path"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "read" },
    });
  });

  it("can emit Anthropic custom tools with an explicit type", () => {
    const payload = applyAnthropicToolSignatureExperiment(
      buildPayload(),
      "anthropic-explicit-custom",
    );

    expect(payload).toEqual({
      tools: [
        {
          type: "custom",
          name: "read",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path", title: "Path" },
              offset: { type: "number", title: "Offset" },
            },
            required: ["path"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "read" },
    });
  });

  it("preserves already-typed Anthropic tools while compacting their schemas", () => {
    const payload = applyAnthropicToolSignatureExperiment(
      {
        tools: [
          {
            type: "custom",
            name: "read",
            description: "Read a file",
            input_schema: {
              type: "object",
              properties: {
                path: { type: "string", title: "Path" },
              },
            },
          },
        ],
        tool_choice: { type: "tool", name: "read" },
      },
      "anthropic-explicit-custom-compact",
    );

    expect(payload).toEqual({
      tools: [
        {
          name: "read",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
          },
          type: "custom",
        },
      ],
      tool_choice: { type: "tool", name: "read" },
    });
  });

  it("adds the strict flag when requested for OpenAI-style experiments", () => {
    const payload = applyAnthropicToolSignatureExperiment(
      buildPayload(),
      "openai-functions-strict",
    );

    expect(payload).toEqual({
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "Path", title: "Path" },
                offset: { type: "number", title: "Offset" },
              },
              required: ["path"],
            },
            strict: false,
          },
        },
      ],
      tool_choice: {
        type: "function",
        function: { name: "read" },
      },
    });
  });

  it("maps required back to Anthropic any tool choice", () => {
    const payload = applyAnthropicToolSignatureExperiment(
      {
        tools: [],
        tool_choice: "required",
      },
      "anthropic-native",
    );

    expect(payload.tool_choice).toEqual({ type: "any" });
  });

  it("covers every declared experiment id with a runnable transform", () => {
    const basePayload = buildPayload();
    const outputs = ANTHROPIC_TOOL_SIGNATURE_EXPERIMENTS.map((experiment) =>
      applyAnthropicToolSignatureExperiment(basePayload, experiment.id),
    );

    expect(outputs).toHaveLength(ANTHROPIC_TOOL_SIGNATURE_EXPERIMENTS.length);
    expect(basePayload).toEqual(buildPayload());
  });
});
