import {
  readClaudeCliCredentialsCached,
  readQwenCliCredentialsCached,
  readMiniMaxCliCredentialsCached,
} from "../cli-credentials.js";
import {
  CLAUDE_CLI_PROFILE_ID,
  EXTERNAL_CLI_NEAR_EXPIRY_MS,
  EXTERNAL_CLI_SYNC_TTL_MS,
  MINIMAX_CLI_PROFILE_ID,
  QWEN_CLI_PROFILE_ID,
  log,
} from "./constants.js";
import type {
  AuthProfileCredential,
  AuthProfileStore,
  OAuthCredential,
  TokenCredential,
} from "./types.js";

type ExternalCliCredential = OAuthCredential | TokenCredential;
const ANTHROPIC_DEFAULT_PROFILE_ID = "anthropic:default";

function shallowEqualOAuthCredentials(a: OAuthCredential | undefined, b: OAuthCredential): boolean {
  if (!a) {
    return false;
  }
  if (a.type !== "oauth") {
    return false;
  }
  return (
    a.provider === b.provider &&
    a.access === b.access &&
    a.refresh === b.refresh &&
    a.expires === b.expires &&
    a.email === b.email &&
    a.enterpriseUrl === b.enterpriseUrl &&
    a.projectId === b.projectId &&
    a.accountId === b.accountId
  );
}

function shallowEqualCliCredential(
  a: AuthProfileCredential | undefined,
  b: AuthProfileCredential,
): boolean {
  if (!a || a.provider !== b.provider) {
    return false;
  }
  if (b.type === "token") {
    if (a.type !== "token") {
      return false;
    }
    return a.token === b.token && a.expires === b.expires && a.email === b.email;
  }
  if (b.type === "oauth") {
    if (a.type !== "oauth") {
      return false;
    }
    return shallowEqualOAuthCredentials(a, b);
  }
  return false;
}

function resolveExternalCredentialExpiry(
  cred: AuthProfileCredential | undefined,
): number | undefined {
  if (!cred || (cred.type !== "oauth" && cred.type !== "token")) {
    return undefined;
  }
  return cred.expires;
}

function shouldReplaceExternalCredential(params: {
  existing: AuthProfileCredential | undefined;
  incoming: ExternalCliCredential;
  provider: string;
  now: number;
}): boolean {
  return (
    !params.existing ||
    params.existing.type !== params.incoming.type ||
    params.existing.provider !== params.provider ||
    !isExternalProfileFresh(params.existing, params.now) ||
    !shallowEqualCliCredential(params.existing, params.incoming) ||
    (typeof params.incoming.expires === "number" &&
      (typeof resolveExternalCredentialExpiry(params.existing) !== "number" ||
        params.incoming.expires > (resolveExternalCredentialExpiry(params.existing) ?? 0)))
  );
}

function syncAnthropicDefaultFromClaudeCli(
  store: AuthProfileStore,
  creds: ExternalCliCredential,
  now: number,
): boolean {
  const existing = store.profiles[ANTHROPIC_DEFAULT_PROFILE_ID];
  if (existing && existing.provider !== "anthropic") {
    return false;
  }
  if (existing && existing.type !== "oauth" && existing.type !== "token") {
    return false;
  }
  if (
    !shouldReplaceExternalCredential({
      existing,
      incoming: creds,
      provider: "anthropic",
      now,
    })
  ) {
    return false;
  }
  store.profiles[ANTHROPIC_DEFAULT_PROFILE_ID] = { ...creds, provider: "anthropic" };
  log.info("synced anthropic default credentials from claude cli", {
    profileId: ANTHROPIC_DEFAULT_PROFILE_ID,
    expires:
      typeof creds.expires === "number" && Number.isFinite(creds.expires)
        ? new Date(creds.expires).toISOString()
        : undefined,
  });
  return true;
}

function isExternalCliManagedProvider(provider: string): boolean {
  return provider === "anthropic" || provider === "qwen-portal" || provider === "minimax-portal";
}

function isExternalProfileFresh(cred: AuthProfileCredential | undefined, now: number): boolean {
  if (!cred) {
    return false;
  }
  if (cred.type !== "oauth" && cred.type !== "token") {
    return false;
  }
  if (!isExternalCliManagedProvider(cred.provider)) {
    return false;
  }
  if (typeof cred.expires !== "number") {
    return true;
  }
  return cred.expires > now + EXTERNAL_CLI_NEAR_EXPIRY_MS;
}

/** Sync external CLI credentials into the store for a given provider. */
function syncExternalCliCredentialsForProvider(
  store: AuthProfileStore,
  profileId: string,
  provider: string,
  readCredentials: () => ExternalCliCredential | null,
  now: number,
): boolean {
  const existing = store.profiles[profileId];
  const creds = readCredentials();
  if (!creds) {
    return false;
  }

  const shouldUpdate = shouldReplaceExternalCredential({
    existing,
    incoming: creds,
    provider,
    now,
  });

  if (shouldUpdate) {
    store.profiles[profileId] = creds;
    log.info(`synced ${provider} credentials from external cli`, {
      profileId,
      expires:
        typeof creds.expires === "number" && Number.isFinite(creds.expires)
          ? new Date(creds.expires).toISOString()
          : undefined,
    });
    return true;
  }

  return false;
}

/**
 * Sync OAuth credentials from external CLI tools (Qwen Code CLI, MiniMax CLI) into the store.
 *
 * Returns true if any credentials were updated.
 */
export function syncExternalCliCredentials(store: AuthProfileStore): boolean {
  let mutated = false;
  const now = Date.now();

  if (
    syncExternalCliCredentialsForProvider(
      store,
      CLAUDE_CLI_PROFILE_ID,
      "anthropic",
      () =>
        readClaudeCliCredentialsCached({
          ttlMs: EXTERNAL_CLI_SYNC_TTL_MS,
          allowKeychainPrompt: false,
        }),
      now,
    )
  ) {
    mutated = true;
  }
  const anthropicCliCreds = store.profiles[CLAUDE_CLI_PROFILE_ID];
  if (
    anthropicCliCreds &&
    (anthropicCliCreds.type === "oauth" || anthropicCliCreds.type === "token") &&
    anthropicCliCreds.provider === "anthropic" &&
    syncAnthropicDefaultFromClaudeCli(store, anthropicCliCreds, now)
  ) {
    mutated = true;
  }

  // Sync from Qwen Code CLI
  const existingQwen = store.profiles[QWEN_CLI_PROFILE_ID];
  const shouldSyncQwen =
    !existingQwen ||
    existingQwen.provider !== "qwen-portal" ||
    !isExternalProfileFresh(existingQwen, now);
  const qwenCreds = shouldSyncQwen
    ? readQwenCliCredentialsCached({ ttlMs: EXTERNAL_CLI_SYNC_TTL_MS })
    : null;
  if (qwenCreds) {
    const existing = store.profiles[QWEN_CLI_PROFILE_ID];
    const existingOAuth = existing?.type === "oauth" ? existing : undefined;
    const shouldUpdate =
      !existingOAuth ||
      existingOAuth.provider !== "qwen-portal" ||
      existingOAuth.expires <= now ||
      qwenCreds.expires > existingOAuth.expires;

    if (shouldUpdate && !shallowEqualOAuthCredentials(existingOAuth, qwenCreds)) {
      store.profiles[QWEN_CLI_PROFILE_ID] = qwenCreds;
      mutated = true;
      log.info("synced qwen credentials from qwen cli", {
        profileId: QWEN_CLI_PROFILE_ID,
        expires: new Date(qwenCreds.expires).toISOString(),
      });
    }
  }

  // Sync from MiniMax Portal CLI
  if (
    syncExternalCliCredentialsForProvider(
      store,
      MINIMAX_CLI_PROFILE_ID,
      "minimax-portal",
      () => readMiniMaxCliCredentialsCached({ ttlMs: EXTERNAL_CLI_SYNC_TTL_MS }),
      now,
    )
  ) {
    mutated = true;
  }

  return mutated;
}
