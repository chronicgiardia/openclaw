import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import {
  ANTHROPIC_TOOL_SIGNATURE_EXPERIMENTS,
  type AnthropicToolSignatureExperiment,
} from "../../src/agents/anthropic-tool-signature-experiments.js";
import {
  buildAnthropicProxyForwardHeaders,
  normalizeAnthropicProxyMountPath,
  resolveAnthropicProxyUpstreamPath,
  rewriteAnthropicProxyRequestBody,
} from "../../src/agents/anthropic-tool-signature-proxy.js";
import { createArgReader } from "./gateway-ws-client.js";

type ProxyConfig = {
  host: string;
  port: number;
  mountPath: string;
  upstreamBaseUrl: URL;
  variantId: AnthropicToolSignatureExperiment["id"];
  upstreamApiKeyEnv?: string;
  verbose: boolean;
};

function parseListen(raw: string | undefined): { host: string; port: number } {
  const input = raw?.trim() || "127.0.0.1:8787";
  const lastColon = input.lastIndexOf(":");
  if (lastColon === -1) {
    throw new Error(`Invalid --listen value "${input}". Expected host:port`);
  }
  const host = input.slice(0, lastColon).trim();
  const portRaw = input.slice(lastColon + 1).trim();
  const port = Number(portRaw);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --listen value "${input}". Expected host:port`);
  }
  return { host, port };
}

function resolveVariantId(raw: string | undefined): AnthropicToolSignatureExperiment["id"] {
  const variant = raw?.trim() || "anthropic-native";
  const found = ANTHROPIC_TOOL_SIGNATURE_EXPERIMENTS.find((entry) => entry.id === variant);
  if (!found) {
    const supported = ANTHROPIC_TOOL_SIGNATURE_EXPERIMENTS.map((entry) => entry.id).join(", ");
    throw new Error(`Unknown --variant "${variant}". Supported values: ${supported}`);
  }
  return found.id;
}

function parseConfig(): ProxyConfig {
  const args = createArgReader();
  if (args.has("--help")) {
    console.log(
      "Usage: node --import tsx scripts/dev/anthropic-tool-signature-proxy.ts " +
        "--upstream-base-url <url> [--listen 127.0.0.1:8787] [--mount-path /anthropic] " +
        "[--variant anthropic-native] [--upstream-api-key-env ANTHROPIC_API_KEY] [--verbose]",
    );
    process.exit(0);
  }

  const upstreamBaseUrlRaw = args.get("--upstream-base-url");
  if (!upstreamBaseUrlRaw) {
    throw new Error("Missing required --upstream-base-url");
  }

  const { host, port } = parseListen(args.get("--listen"));
  const mountPath = normalizeAnthropicProxyMountPath(args.get("--mount-path") || "/anthropic");
  return {
    host,
    port,
    mountPath,
    upstreamBaseUrl: new URL(upstreamBaseUrlRaw),
    variantId: resolveVariantId(args.get("--variant")),
    upstreamApiKeyEnv: args.get("--upstream-api-key-env")?.trim() || undefined,
    verbose: args.has("--verbose"),
  };
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function copyResponseHeaders(headers: Headers, res: ServerResponse): void {
  for (const [key, value] of headers.entries()) {
    if (key.toLowerCase() === "connection" || key.toLowerCase() === "transfer-encoding") {
      continue;
    }
    res.setHeader(key, value);
  }
}

async function main() {
  const config = parseConfig();
  const server = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

      if (req.method === "GET" && requestUrl.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            mountPath: config.mountPath,
            upstreamBaseUrl: config.upstreamBaseUrl.toString(),
            variantId: config.variantId,
          }),
        );
        return;
      }

      const upstreamPath = resolveAnthropicProxyUpstreamPath({
        pathname: requestUrl.pathname,
        mountPath: config.mountPath,
      });
      if (!upstreamPath) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Unsupported path" }));
        return;
      }

      const bodyText = await readRequestBody(req);
      const rewrittenBody = rewriteAnthropicProxyRequestBody({
        bodyText,
        upstreamPath,
        variantId: config.variantId,
      });
      const upstreamApiKey = config.upstreamApiKeyEnv
        ? process.env[config.upstreamApiKeyEnv]?.trim()
        : undefined;
      const upstreamUrl = new URL(upstreamPath + requestUrl.search, config.upstreamBaseUrl);
      const headers = buildAnthropicProxyForwardHeaders({
        incomingHeaders: req.headers,
        upstreamApiKey,
      });

      if (config.verbose) {
        console.error(
          `[anthropic-proxy] ${req.method} ${requestUrl.pathname} -> ${upstreamUrl.toString()} variant=${config.variantId}`,
        );
      }

      const upstreamResponse = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : rewrittenBody,
      });
      const responseBuffer = Buffer.from(await upstreamResponse.arrayBuffer());

      res.statusCode = upstreamResponse.status;
      copyResponseHeaders(upstreamResponse.headers, res);
      res.end(responseBuffer);
    } catch (error) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });

  server.listen(config.port, config.host, () => {
    const baseUrl = `http://${config.host}:${config.port}${config.mountPath}`;
    console.error(
      `[anthropic-proxy] listening on ${baseUrl} -> ${config.upstreamBaseUrl.toString()} variant=${config.variantId}`,
    );
  });
}

await main();
