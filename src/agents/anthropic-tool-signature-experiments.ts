import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

type ToolLike = Pick<ToolDefinition, "name" | "description" | "parameters">;

export type AnthropicToolSignatureExperiment = {
  id:
    | "anthropic-native"
    | "anthropic-native-compact"
    | "anthropic-explicit-custom"
    | "anthropic-explicit-custom-compact"
    | "openai-functions"
    | "openai-functions-compact"
    | "openai-functions-strict";
  description: string;
  envelope: "anthropic" | "openai-function";
  schemaStyle: "preserve" | "compact";
  explicitCustomType?: boolean;
  strict?: boolean;
};

export const ANTHROPIC_TOOL_SIGNATURE_EXPERIMENTS = [
  {
    id: "anthropic-native",
    description: "Anthropic-native tools using name + input_schema.",
    envelope: "anthropic",
    schemaStyle: "preserve",
  },
  {
    id: "anthropic-native-compact",
    description: "Anthropic-native tools with schema titles stripped recursively.",
    envelope: "anthropic",
    schemaStyle: "compact",
  },
  {
    id: "anthropic-explicit-custom",
    description: 'Anthropic custom tools with an explicit type: "custom".',
    envelope: "anthropic",
    schemaStyle: "preserve",
    explicitCustomType: true,
  },
  {
    id: "anthropic-explicit-custom-compact",
    description: 'Anthropic custom tools with an explicit type: "custom" and compact schemas.',
    envelope: "anthropic",
    schemaStyle: "compact",
    explicitCustomType: true,
  },
  {
    id: "openai-functions",
    description: "OpenAI function envelope with function.parameters.",
    envelope: "openai-function",
    schemaStyle: "preserve",
  },
  {
    id: "openai-functions-compact",
    description: "OpenAI function envelope with schema titles stripped recursively.",
    envelope: "openai-function",
    schemaStyle: "compact",
  },
  {
    id: "openai-functions-strict",
    description: "OpenAI function envelope with an explicit strict=false flag.",
    envelope: "openai-function",
    schemaStyle: "preserve",
    strict: false,
  },
] as const satisfies readonly AnthropicToolSignatureExperiment[];

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function compactSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => compactSchema(entry));
  }
  if (!isRecord(value)) {
    return value;
  }

  const compacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "title") {
      continue;
    }
    compacted[key] = compactSchema(entry);
  }
  return compacted;
}

function normalizeSchema(
  schema: unknown,
  style: AnthropicToolSignatureExperiment["schemaStyle"],
): Record<string, unknown> {
  const base = isRecord(schema)
    ? cloneValue(schema)
    : ({ type: "object", properties: {} } as Record<string, unknown>);
  return style === "compact" ? (compactSchema(base) as Record<string, unknown>) : base;
}

function toAnthropicToolShape(
  tool: ToolLike | Record<string, unknown>,
  experiment: Pick<AnthropicToolSignatureExperiment, "schemaStyle" | "explicitCustomType">,
): Record<string, unknown> {
  const record = tool as Record<string, unknown>;
  if (isRecord(record.function)) {
    const functionSpec = record.function;
    const next: Record<string, unknown> = {
      name: typeof functionSpec.name === "string" ? functionSpec.name : record.name,
      input_schema: normalizeSchema(functionSpec.parameters, experiment.schemaStyle),
    };
    if (typeof functionSpec.description === "string" && functionSpec.description.trim()) {
      next.description = functionSpec.description;
    }
    if (experiment.explicitCustomType) {
      next.type = "custom";
    }
    return next;
  }

  if (typeof record.type === "string" && record.type.trim()) {
    const next = cloneValue(record);
    if (isRecord(next.input_schema)) {
      next.input_schema = normalizeSchema(next.input_schema, experiment.schemaStyle);
    }
    return next;
  }

  const next: Record<string, unknown> = {
    name: tool.name,
    input_schema: normalizeSchema(tool.parameters ?? record.input_schema, experiment.schemaStyle),
  };
  if (typeof tool.description === "string" && tool.description.trim()) {
    next.description = tool.description;
  }
  if (experiment.explicitCustomType) {
    next.type = "custom";
  }
  return next;
}

function toOpenAiFunctionToolShape(
  tool: ToolLike | Record<string, unknown>,
  experiment: AnthropicToolSignatureExperiment,
): Record<string, unknown> {
  const record = tool as Record<string, unknown>;
  if (record.type === "function" && isRecord(record.function)) {
    const next = cloneValue(record);
    const functionSpec = next.function as Record<string, unknown>;
    functionSpec.parameters = normalizeSchema(functionSpec.parameters, experiment.schemaStyle);
    if (typeof experiment.strict === "boolean") {
      functionSpec.strict = experiment.strict;
    } else {
      delete functionSpec.strict;
    }
    return next;
  }

  const functionSpec: Record<string, unknown> = {
    name: tool.name,
    parameters: normalizeSchema(tool.parameters ?? record.input_schema, experiment.schemaStyle),
  };
  if (typeof tool.description === "string" && tool.description.trim()) {
    functionSpec.description = tool.description;
  }
  if (typeof experiment.strict === "boolean") {
    functionSpec.strict = experiment.strict;
  }
  return {
    type: "function",
    function: functionSpec,
  };
}

function normalizeToolChoiceForAnthropic(toolChoice: unknown): unknown {
  if (!isRecord(toolChoice)) {
    return toolChoice === "required" ? { type: "any" } : toolChoice;
  }
  if (toolChoice.type === "function" && isRecord(toolChoice.function)) {
    const functionName = toolChoice.function.name;
    if (typeof functionName === "string" && functionName.trim()) {
      return {
        type: "tool",
        name: functionName.trim(),
      };
    }
  }
  if (toolChoice.type === "required") {
    return { type: "any" };
  }
  return cloneValue(toolChoice);
}

function normalizeToolChoiceForOpenAi(toolChoice: unknown): unknown {
  if (toolChoice === "required") {
    return toolChoice;
  }
  if (!isRecord(toolChoice)) {
    return toolChoice;
  }
  if (toolChoice.type === "any") {
    return "required";
  }
  if (toolChoice.type === "tool" && typeof toolChoice.name === "string" && toolChoice.name.trim()) {
    return {
      type: "function",
      function: { name: toolChoice.name.trim() },
    };
  }
  if (
    (toolChoice.type === "auto" || toolChoice.type === "none") &&
    typeof toolChoice.type === "string"
  ) {
    return toolChoice.type;
  }
  return cloneValue(toolChoice);
}

export function buildAnthropicToolExperimentPayload(params: {
  tools: ToolLike[];
  toolChoice?: unknown;
}): Record<string, unknown> {
  return {
    tools: params.tools.map((tool) =>
      toAnthropicToolShape(tool, {
        schemaStyle: "preserve",
      }),
    ),
    ...(params.toolChoice !== undefined ? { tool_choice: cloneValue(params.toolChoice) } : {}),
  };
}

export function resolveAnthropicToolSignatureExperiment(
  id: AnthropicToolSignatureExperiment["id"],
): AnthropicToolSignatureExperiment {
  const found = ANTHROPIC_TOOL_SIGNATURE_EXPERIMENTS.find((experiment) => experiment.id === id);
  if (!found) {
    throw new Error(`Unknown Anthropic tool signature experiment: ${id}`);
  }
  return found;
}

export function applyAnthropicToolSignatureExperiment(
  payload: Record<string, unknown>,
  experimentId: AnthropicToolSignatureExperiment["id"],
): Record<string, unknown> {
  const experiment = resolveAnthropicToolSignatureExperiment(experimentId);
  const next = cloneValue(payload);

  if (Array.isArray(next.tools)) {
    next.tools =
      experiment.envelope === "anthropic"
        ? next.tools
            .map((tool) =>
              isRecord(tool)
                ? toAnthropicToolShape(tool, {
                    schemaStyle: experiment.schemaStyle,
                    explicitCustomType: experiment.explicitCustomType,
                  })
                : undefined,
            )
            .filter((tool): tool is Record<string, unknown> => !!tool)
        : next.tools
            .map((tool) =>
              isRecord(tool) ? toOpenAiFunctionToolShape(tool, experiment) : undefined,
            )
            .filter((tool): tool is Record<string, unknown> => !!tool);
  }

  if ("tool_choice" in next) {
    next.tool_choice =
      experiment.envelope === "anthropic"
        ? normalizeToolChoiceForAnthropic(next.tool_choice)
        : normalizeToolChoiceForOpenAi(next.tool_choice);
  }

  return next;
}
