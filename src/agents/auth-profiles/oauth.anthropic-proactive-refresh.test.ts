import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../test-utils/env.js";

const { fetchMock, getOAuthApiKeyMock, writeClaudeCliCredentialsMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  getOAuthApiKeyMock: vi.fn(),
  writeClaudeCliCredentialsMock: vi.fn(() => true),
}));

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
  return {
    ...actual,
    getOAuthApiKey: getOAuthApiKeyMock,
    getOAuthProviders: () => [
      { id: "anthropic", envApiKey: "ANTHROPIC_API_KEY", oauthTokenEnv: "ANTHROPIC_OAUTH_TOKEN" }, // pragma: allowlist secret
      { id: "openai-codex", envApiKey: "OPENAI_API_KEY", oauthTokenEnv: "OPENAI_OAUTH_TOKEN" }, // pragma: allowlist secret
    ],
  };
});

vi.mock("../cli-credentials.js", async () => {
  const actual =
    await vi.importActual<typeof import("../cli-credentials.js")>("../cli-credentials.js");
  return {
    ...actual,
    writeClaudeCliCredentials: writeClaudeCliCredentialsMock,
  };
});

import { resolveApiKeyForProfile } from "./oauth.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore } from "./types.js";

function createOauthStore(params: {
  profileId: string;
  access: string;
  refresh: string;
  expires: number;
}): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [params.profileId]: {
        type: "oauth",
        provider: "anthropic",
        access: params.access,
        refresh: params.refresh,
        expires: params.expires,
      },
    },
  };
}

describe("resolveApiKeyForProfile anthropic proactive refresh", () => {
  const envSnapshot = captureEnv([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
  ]);
  let tempRoot = "";
  let agentDir = "";

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T00:00:00Z"));
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    getOAuthApiKeyMock.mockReset();
    writeClaudeCliCredentialsMock.mockClear();
    clearRuntimeAuthProfileStoreSnapshots();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-anthropic-refresh-"));
    agentDir = path.join(tempRoot, "agents", "main", "agent");
    await fs.mkdir(agentDir, { recursive: true });
    process.env.OPENCLAW_STATE_DIR = tempRoot;
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearRuntimeAuthProfileStoreSnapshots();
    envSnapshot.restore();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("refreshes near-expiry anthropic oauth tokens before they expire and mirrors them to Claude CLI", async () => {
    const profileId = "anthropic:default";
    const oldExpires = Date.now() + 10 * 60_000;
    const newExpires = Date.now() + 2 * 60 * 60_000 - 5 * 60_000;
    saveAuthProfileStore(
      createOauthStore({
        profileId,
        access: "stale-access",
        refresh: "stale-refresh",
        expires: oldExpires,
      }),
      agentDir,
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_in: 2 * 60 * 60,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(agentDir),
      profileId,
      agentDir,
    });

    expect(result).toEqual({
      apiKey: "fresh-access", // pragma: allowlist secret
      provider: "anthropic",
      email: undefined,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getOAuthApiKeyMock).not.toHaveBeenCalled();
    expect(writeClaudeCliCredentialsMock).toHaveBeenCalledTimes(1);
    expect(writeClaudeCliCredentialsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        access: "fresh-access",
        refresh: "fresh-refresh",
        expires: newExpires,
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://platform.claude.com/v1/oauth/token",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const request = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      grant_type: "refresh_token",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      refresh_token: "stale-refresh",
    });
    const updated = ensureAuthProfileStore(agentDir).profiles[profileId];
    expect(updated).toMatchObject({
      type: "oauth",
      provider: "anthropic",
      access: "fresh-access",
      refresh: "fresh-refresh",
      expires: newExpires,
    });
  });

  it("uses the still-valid cached anthropic token when proactive refresh fails", async () => {
    const profileId = "anthropic:default";
    const expires = Date.now() + 10 * 60_000;
    saveAuthProfileStore(
      createOauthStore({
        profileId,
        access: "cached-access",
        refresh: "cached-refresh",
        expires,
      }),
      agentDir,
    );
    fetchMock.mockResolvedValueOnce(new Response("invalid_grant", { status: 400 }));

    const result = await resolveApiKeyForProfile({
      store: ensureAuthProfileStore(agentDir),
      profileId,
      agentDir,
    });

    expect(result).toEqual({
      apiKey: "cached-access", // pragma: allowlist secret
      provider: "anthropic",
      email: undefined,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getOAuthApiKeyMock).not.toHaveBeenCalled();
    expect(writeClaudeCliCredentialsMock).not.toHaveBeenCalled();
  });

  it("keeps throwing once the anthropic oauth token has already expired", async () => {
    const profileId = "anthropic:default";
    saveAuthProfileStore(
      createOauthStore({
        profileId,
        access: "expired-access",
        refresh: "expired-refresh",
        expires: Date.now() - 60_000,
      }),
      agentDir,
    );
    fetchMock.mockResolvedValueOnce(new Response("invalid_grant", { status: 400 }));

    await expect(
      resolveApiKeyForProfile({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      }),
    ).rejects.toThrow(/OAuth token refresh failed for anthropic/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getOAuthApiKeyMock).not.toHaveBeenCalled();
    expect(writeClaudeCliCredentialsMock).not.toHaveBeenCalled();
  });
});
