import {
  ANTHROPIC_TOOL_SIGNATURE_EXPERIMENTS,
  applyAnthropicToolSignatureExperiment,
  buildAnthropicToolExperimentPayload,
  type AnthropicToolSignatureExperiment,
} from "../../src/agents/anthropic-tool-signature-experiments.js";
import { splitSdkTools } from "../../src/agents/pi-embedded-runner.js";
import { createOpenClawCodingTools } from "../../src/agents/pi-tools.js";
import { createArgReader } from "./gateway-ws-client.js";

function parseToolNames(raw: string | undefined): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  const items = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return items.length > 0 ? items : undefined;
}

function resolveVariantId(
  raw: string | undefined,
): AnthropicToolSignatureExperiment["id"] | undefined {
  if (!raw) {
    return undefined;
  }
  const match = ANTHROPIC_TOOL_SIGNATURE_EXPERIMENTS.find((experiment) => experiment.id === raw);
  if (!match) {
    const supported = ANTHROPIC_TOOL_SIGNATURE_EXPERIMENTS.map((experiment) => experiment.id).join(
      ", ",
    );
    throw new Error(`Unknown --variant "${raw}". Supported values: ${supported}`);
  }
  return match.id;
}

function resolveSelectedTools(rawNames?: string[]) {
  const requested = new Set(rawNames ?? ["read", "write", "edit", "exec"]);
  const tools = createOpenClawCodingTools({
    workspaceDir: process.cwd(),
    senderIsOwner: true,
    modelProvider: "anthropic",
    modelId: "local-lab",
  });
  const { customTools } = splitSdkTools({
    tools,
    sandboxEnabled: false,
  });
  const selected = customTools.filter((tool) => requested.has(tool.name));
  if (selected.length === 0) {
    throw new Error(`No tools matched: ${Array.from(requested).join(", ")}`);
  }
  return selected;
}

type ToolChoiceCase = {
  label: string;
  value: unknown;
};

function createToolChoiceCase(raw: string, firstToolName: string | undefined): ToolChoiceCase {
  switch (raw) {
    case "auto":
      return { label: "auto", value: { type: "auto" } };
    case "none":
      return { label: "none", value: { type: "none" } };
    case "any":
      return { label: "any", value: { type: "any" } };
    case "required":
      return { label: "required", value: "required" };
    case "tool":
      if (!firstToolName) {
        throw new Error('tool_choice "tool" requires at least one selected tool');
      }
      return { label: "tool", value: { type: "tool", name: firstToolName } };
    case "raw-function":
      if (!firstToolName) {
        throw new Error('tool_choice "raw-function" requires at least one selected tool');
      }
      return {
        label: "raw-function",
        value: { type: "function", function: { name: firstToolName } },
      };
    default:
      throw new Error(
        `Unknown --tool-choice "${raw}". Supported values: auto, none, any, required, tool, raw-function`,
      );
  }
}

function resolveToolChoiceCases(params: {
  raw?: string;
  matrix: boolean;
  firstToolName?: string;
}): ToolChoiceCase[] {
  if (params.matrix) {
    return ["tool", "auto", "none", "any", "required", "raw-function"].map((choice) =>
      createToolChoiceCase(choice, params.firstToolName),
    );
  }
  if (!params.raw) {
    return [createToolChoiceCase("tool", params.firstToolName)];
  }
  return params.raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => createToolChoiceCase(entry, params.firstToolName));
}

function printExperiment(params: {
  label: string;
  description: string;
  payload: Record<string, unknown>;
}) {
  console.log(`## ${params.label}`);
  console.log(params.description);
  console.log(JSON.stringify(params.payload, null, 2));
  console.log("");
}

function main() {
  const args = createArgReader();
  if (args.has("--help")) {
    console.log(
      "Usage: bun scripts/dev/anthropic-tool-signature-experiments.ts " +
        "[--variant <id>] [--tools read,write,edit,exec] " +
        "[--tool-choice tool|auto|none|any|required|raw-function[,..]] [--tool-choice-matrix] [--list]",
    );
    return;
  }
  if (args.has("--list")) {
    for (const experiment of ANTHROPIC_TOOL_SIGNATURE_EXPERIMENTS) {
      console.log(`${experiment.id}  ${experiment.description}`);
    }
    return;
  }

  const toolNames = parseToolNames(args.get("--tools"));
  const variantId = resolveVariantId(args.get("--variant"));
  const selectedTools = resolveSelectedTools(toolNames);
  const firstTool = selectedTools[0];
  const toolChoiceCases = resolveToolChoiceCases({
    raw: args.get("--tool-choice"),
    matrix: args.has("--tool-choice-matrix"),
    firstToolName: firstTool?.name,
  });

  if (variantId) {
    const experiment = ANTHROPIC_TOOL_SIGNATURE_EXPERIMENTS.find((entry) => entry.id === variantId);
    if (!experiment) {
      throw new Error(`Unknown variant: ${variantId}`);
    }
    for (const toolChoiceCase of toolChoiceCases) {
      const basePayload = buildAnthropicToolExperimentPayload({
        tools: selectedTools,
        toolChoice: toolChoiceCase.value,
      });
      const payloadTemplate: Record<string, unknown> = {
        model: "local-lab",
        max_tokens: 256,
        messages: [{ role: "user", content: "Inspect the tool signature variants." }],
        ...basePayload,
      };
      printExperiment({
        label: `${experiment.id} / ${toolChoiceCase.label}`,
        description: experiment.description,
        payload: applyAnthropicToolSignatureExperiment(payloadTemplate, experiment.id),
      });
    }
    return;
  }

  for (const experiment of ANTHROPIC_TOOL_SIGNATURE_EXPERIMENTS) {
    for (const toolChoiceCase of toolChoiceCases) {
      const basePayload = buildAnthropicToolExperimentPayload({
        tools: selectedTools,
        toolChoice: toolChoiceCase.value,
      });
      const payloadTemplate: Record<string, unknown> = {
        model: "local-lab",
        max_tokens: 256,
        messages: [{ role: "user", content: "Inspect the tool signature variants." }],
        ...basePayload,
      };
      printExperiment({
        label: `${experiment.id} / ${toolChoiceCase.label}`,
        description: experiment.description,
        payload: applyAnthropicToolSignatureExperiment(payloadTemplate, experiment.id),
      });
    }
  }
}

main();
