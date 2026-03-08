import {
  ANTHROPIC_TOOL_SIGNATURE_EXPERIMENTS,
  applyAnthropicToolSignatureExperiment,
  buildAnthropicToolExperimentPayload,
  type AnthropicToolSignatureExperiment,
} from "../../src/agents/anthropic-tool-signature-experiments.js";
import { splitSdkTools } from "../../src/agents/pi-embedded-runner.js";
import { createOpenClawCodingTools } from "../../src/agents/pi-tools.js";
import { createArgReader } from "./gateway-ws-client.js";

type ToolChoiceCase = {
  label: string;
  value: unknown;
};

type HarnessResult = {
  variant: AnthropicToolSignatureExperiment["id"];
  toolChoice: string;
  status: number;
  ok: boolean;
  stopReason?: string;
  contentType?: string;
  contentName?: string;
  errorType?: string;
  errorMessage?: string;
  requestId?: string;
  payload?: Record<string, unknown>;
};

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

function resolveVariantIds(raw: string | undefined): AnthropicToolSignatureExperiment["id"][] {
  if (!raw || raw.trim() === "all") {
    return ANTHROPIC_TOOL_SIGNATURE_EXPERIMENTS.map((experiment) => experiment.id);
  }

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const experiment = ANTHROPIC_TOOL_SIGNATURE_EXPERIMENTS.find((item) => item.id === entry);
      if (!experiment) {
        const supported = ANTHROPIC_TOOL_SIGNATURE_EXPERIMENTS.map((item) => item.id).join(", ");
        throw new Error(`Unknown --variants entry "${entry}". Supported values: ${supported}`);
      }
      return experiment.id;
    });
}

function resolveSelectedTools(rawNames?: string[]) {
  const requested = new Set(rawNames ?? ["read"]);
  const tools = createOpenClawCodingTools({
    workspaceDir: process.cwd(),
    senderIsOwner: true,
    modelProvider: "anthropic",
    modelId: "live-lab",
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
        `Unknown tool-choice "${raw}". Supported values: auto, none, any, required, tool, raw-function`,
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

function resolveAuth(params: { mode: string; authEnv?: string }): {
  mode: "none" | "api-key" | "bearer";
  value?: string;
} {
  const mode = (params.mode || "api-key").trim();
  if (mode === "none") {
    return { mode: "none" };
  }

  if (mode !== "api-key" && mode !== "bearer") {
    throw new Error("Unknown --auth-mode. Supported values: none, api-key, bearer");
  }

  const envName =
    params.authEnv?.trim() || (mode === "bearer" ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY");
  const value = process.env[envName]?.trim();
  if (!value) {
    throw new Error(`Missing required auth env var ${envName}`);
  }
  return { mode, value };
}

function joinUrl(baseRaw: string, path: string): URL {
  const base = new URL(baseRaw);
  const normalized = new URL(base.toString());
  if (!normalized.pathname.endsWith("/")) {
    normalized.pathname = `${normalized.pathname}/`;
  }
  return new URL(path.replace(/^\//, ""), normalized);
}

async function runCase(params: {
  requestUrl: URL;
  headers: Record<string, string>;
  variant: AnthropicToolSignatureExperiment["id"];
  toolChoiceCase: ToolChoiceCase;
  tools: ReturnType<typeof resolveSelectedTools>;
  model: string;
  maxTokens: number;
  message: string;
  showPayload: boolean;
}): Promise<HarnessResult> {
  const basePayload = buildAnthropicToolExperimentPayload({
    tools: params.tools,
    toolChoice: params.toolChoiceCase.value,
  });
  const payload = applyAnthropicToolSignatureExperiment(
    {
      model: params.model,
      max_tokens: params.maxTokens,
      messages: [{ role: "user", content: params.message }],
      ...basePayload,
    },
    params.variant,
  );

  const response = await fetch(params.requestUrl, {
    method: "POST",
    headers: params.headers,
    body: JSON.stringify(payload),
  });
  const responseText = await response.text();

  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(responseText) as Record<string, unknown>;
  } catch {
    parsed = undefined;
  }

  const content = Array.isArray(parsed?.content)
    ? (parsed?.content[0] as Record<string, unknown> | undefined)
    : undefined;
  const error = parsed?.error as Record<string, unknown> | undefined;

  return {
    variant: params.variant,
    toolChoice: params.toolChoiceCase.label,
    status: response.status,
    ok: response.ok,
    stopReason: typeof parsed?.stop_reason === "string" ? parsed.stop_reason : undefined,
    contentType: typeof content?.type === "string" ? content.type : undefined,
    contentName: typeof content?.name === "string" ? content.name : undefined,
    errorType: typeof error?.type === "string" ? error.type : undefined,
    errorMessage: typeof error?.message === "string" ? error.message : undefined,
    requestId:
      typeof parsed?.request_id === "string"
        ? parsed.request_id
        : typeof response.headers.get("request-id") === "string"
          ? response.headers.get("request-id") || undefined
          : undefined,
    payload: params.showPayload ? payload : undefined,
  };
}

function printTextResults(results: HarnessResult[]) {
  for (const result of results) {
    const summary = [
      result.ok ? "OK" : "ERR",
      String(result.status),
      result.variant,
      `tool_choice=${result.toolChoice}`,
      result.stopReason ? `stop=${result.stopReason}` : undefined,
      result.contentType ? `content=${result.contentType}` : undefined,
      result.contentName ? `name=${result.contentName}` : undefined,
      result.errorType ? `error=${result.errorType}` : undefined,
      result.errorMessage ? `message=${result.errorMessage}` : undefined,
    ]
      .filter(Boolean)
      .join(" | ");
    console.log(summary);
    if (result.payload) {
      console.log(JSON.stringify(result.payload, null, 2));
    }
  }
}

async function main() {
  const args = createArgReader();
  if (args.has("--help")) {
    console.log(
      "Usage: bun scripts/dev/anthropic-tool-signature-live.ts " +
        "--base-url <url> [--variants all|id[,..]] [--tools read] " +
        "[--tool-choice tool|auto|none|any|required|raw-function[,..]] [--tool-choice-matrix] " +
        "[--auth-mode none|api-key|bearer] [--auth-env NAME] [--model claude-sonnet-4-5] " +
        "[--anthropic-version 2023-06-01] [--anthropic-beta <value>] [--message 'Say ok'] " +
        "[--max-tokens 64] [--json] [--show-payload] [--list]",
    );
    return;
  }
  if (args.has("--list")) {
    for (const experiment of ANTHROPIC_TOOL_SIGNATURE_EXPERIMENTS) {
      console.log(`${experiment.id}  ${experiment.description}`);
    }
    return;
  }

  const baseUrl = args.get("--base-url");
  if (!baseUrl) {
    throw new Error("Missing required --base-url");
  }

  const auth = resolveAuth({
    mode: args.get("--auth-mode") || "api-key",
    authEnv: args.get("--auth-env"),
  });
  const model = args.get("--model") || "claude-sonnet-4-5";
  const maxTokens = Number(args.get("--max-tokens") || "64");
  if (!Number.isFinite(maxTokens) || maxTokens < 1) {
    throw new Error("Invalid --max-tokens");
  }

  const selectedTools = resolveSelectedTools(parseToolNames(args.get("--tools")));
  const variants = resolveVariantIds(args.get("--variants"));
  const toolChoiceCases = resolveToolChoiceCases({
    raw: args.get("--tool-choice"),
    matrix: args.has("--tool-choice-matrix"),
    firstToolName: selectedTools[0]?.name,
  });

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": args.get("--anthropic-version") || "2023-06-01",
  };
  const anthropicBeta = args.get("--anthropic-beta")?.trim();
  if (anthropicBeta) {
    headers["anthropic-beta"] = anthropicBeta;
  }
  if (auth.mode === "api-key" && auth.value) {
    headers["x-api-key"] = auth.value;
  }
  if (auth.mode === "bearer" && auth.value) {
    headers.authorization = `Bearer ${auth.value}`;
  }

  const requestUrl = joinUrl(baseUrl, "/v1/messages");
  const results: HarnessResult[] = [];
  for (const variant of variants) {
    for (const toolChoiceCase of toolChoiceCases) {
      results.push(
        await runCase({
          requestUrl,
          headers,
          variant,
          toolChoiceCase,
          tools: selectedTools,
          model,
          maxTokens,
          message: args.get("--message") || "Say ok",
          showPayload: args.has("--show-payload"),
        }),
      );
    }
  }

  if (args.has("--json")) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  printTextResults(results);
}

await main();
