import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  readClaudeCliCredentialsCachedMock,
  readMiniMaxCliCredentialsCachedMock,
  readQwenCliCredentialsCachedMock,
} = vi.hoisted(() => ({
  readClaudeCliCredentialsCachedMock: vi.fn(),
  readMiniMaxCliCredentialsCachedMock: vi.fn(),
  readQwenCliCredentialsCachedMock: vi.fn(),
}));

vi.mock("../cli-credentials.js", async () => {
  const actual =
    await vi.importActual<typeof import("../cli-credentials.js")>("../cli-credentials.js");
  return {
    ...actual,
    readClaudeCliCredentialsCached: readClaudeCliCredentialsCachedMock,
    readMiniMaxCliCredentialsCached: readMiniMaxCliCredentialsCachedMock,
    readQwenCliCredentialsCached: readQwenCliCredentialsCachedMock,
  };
});

import { CLAUDE_CLI_PROFILE_ID } from "./constants.js";
import { syncExternalCliCredentials } from "./external-cli-sync.js";
import type { AuthProfileStore } from "./types.js";

describe("syncExternalCliCredentials", () => {
  beforeEach(() => {
    readClaudeCliCredentialsCachedMock.mockReset();
    readMiniMaxCliCredentialsCachedMock.mockReset();
    readQwenCliCredentialsCachedMock.mockReset();
    readMiniMaxCliCredentialsCachedMock.mockReturnValue(null);
    readQwenCliCredentialsCachedMock.mockReturnValue(null);
  });

  it("imports anthropic oauth credentials from Claude CLI into the auth store", () => {
    readClaudeCliCredentialsCachedMock.mockReturnValue({
      type: "oauth",
      provider: "anthropic",
      access: "claude-access",
      refresh: "claude-refresh",
      expires: Date.now() + 60 * 60_000,
    });
    const store: AuthProfileStore = {
      version: 1,
      profiles: {},
    };

    const mutated = syncExternalCliCredentials(store);

    expect(mutated).toBe(true);
    expect(readClaudeCliCredentialsCachedMock).toHaveBeenCalledTimes(1);
    expect(store.profiles[CLAUDE_CLI_PROFILE_ID]).toMatchObject({
      type: "oauth",
      provider: "anthropic",
      access: "claude-access",
      refresh: "claude-refresh",
    });
    expect(store.profiles["anthropic:default"]).toMatchObject({
      type: "oauth",
      provider: "anthropic",
      access: "claude-access",
      refresh: "claude-refresh",
    });
  });

  it("replaces a stale anthropic default profile with the fresh Claude CLI oauth credential", () => {
    const freshExpiry = Date.now() + 60 * 60_000;
    readClaudeCliCredentialsCachedMock.mockReturnValue({
      type: "oauth",
      provider: "anthropic",
      access: "fresh-access",
      refresh: "fresh-refresh",
      expires: freshExpiry,
    });
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "oauth",
          provider: "anthropic",
          access: "stale-access",
          refresh: "stale-refresh",
          expires: Date.now() - 60_000,
        },
      },
    };

    const mutated = syncExternalCliCredentials(store);

    expect(mutated).toBe(true);
    expect(store.profiles["anthropic:default"]).toMatchObject({
      type: "oauth",
      provider: "anthropic",
      access: "fresh-access",
      refresh: "fresh-refresh",
      expires: freshExpiry,
    });
  });
});
