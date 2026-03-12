import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { forceRefreshOAuthProfile } from "./auth-profiles/oauth.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  replaceRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "./auth-profiles/store.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  readClaudeCliCredentialsCached,
  resetCliCredentialCachesForTest,
} from "./cli-credentials.js";

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

describe("anthropic oauth refresh with runtime snapshot", () => {
  const envSnapshot = captureEnv([
    "HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
  ]);
  let tempRoot = "";
  let tempHome = "";
  let agentDir = "";

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T00:00:00Z"));
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-runtime-refresh-"));
    tempHome = path.join(tempRoot, "home");
    agentDir = path.join(tempRoot, "agents", "magiclabs", "agent");
    await fs.mkdir(path.join(tempHome, ".claude"), { recursive: true });
    await fs.mkdir(agentDir, { recursive: true });
    process.env.HOME = tempHome;
    process.env.OPENCLAW_STATE_DIR = tempRoot;
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    resetCliCredentialCachesForTest();
    clearRuntimeAuthProfileStoreSnapshots();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetCliCredentialCachesForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    envSnapshot.restore();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("re-reads fresh Claude credentials after force refresh even when a stale runtime snapshot was active", async () => {
    const profileId = "anthropic:default";
    const staleExpires = Date.now() + 30 * 60_000;
    await fs.writeFile(
      path.join(tempHome, ".claude", ".credentials.json"),
      `${JSON.stringify(
        {
          claudeAiOauth: {
            accessToken: "stale-cli-access",
            refreshToken: "stale-cli-refresh",
            expiresAt: staleExpires,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const staleStore = createOauthStore({
      profileId,
      access: "stale-store-access",
      refresh: "stale-store-refresh",
      expires: staleExpires,
    });
    saveAuthProfileStore(staleStore, agentDir);
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: staleStore }]);

    const primed = readClaudeCliCredentialsCached({
      ttlMs: 15 * 60 * 1000,
      platform: "linux",
      homeDir: tempHome,
    });
    expect(primed).toMatchObject({ type: "oauth", access: "stale-cli-access" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
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
      ),
    );

    const refreshed = await forceRefreshOAuthProfile({
      profileId,
      agentDir,
      provider: "anthropic",
    });

    expect(refreshed).toEqual({
      apiKey: "fresh-access", // pragma: allowlist secret
      provider: "anthropic",
      email: undefined,
    });

    const loaded = ensureAuthProfileStore(agentDir).profiles[profileId];
    expect(loaded).toMatchObject({
      type: "oauth",
      provider: "anthropic",
      access: "fresh-access",
      refresh: "fresh-refresh",
    });
  });
});
