import {
  getOAuthApiKey,
  getOAuthProviders,
  type OAuthCredentials,
  type OAuthProvider,
} from "@mariozechner/pi-ai";
import { loadConfig, type OpenClawConfig } from "../../config/config.js";
import { coerceSecretRef } from "../../config/types.secrets.js";
import { withFileLock } from "../../infra/file-lock.js";
import { refreshQwenPortalCredentials } from "../../providers/qwen-portal-oauth.js";
import { resolveSecretRefString, type SecretRefResolveCache } from "../../secrets/resolve.js";
import { refreshChutesTokens } from "../chutes-oauth.js";
import {
  clearClaudeCliCredentialsCache,
  readClaudeCliCredentials,
  writeClaudeCliCredentials,
} from "../cli-credentials.js";
import { normalizeProviderId } from "../model-selection.js";
import {
  ANTHROPIC_OAUTH_PROACTIVE_REFRESH_MS,
  AUTH_STORE_LOCK_OPTIONS,
  CLAUDE_CLI_PROFILE_ID,
  log,
} from "./constants.js";
import { resolveTokenExpiryState } from "./credential-state.js";
import { formatAuthDoctorHint } from "./doctor.js";
import { ensureAuthStoreFile, resolveAuthStorePath } from "./paths.js";
import { suggestOAuthProfileIdForLegacyDefault } from "./repair.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./store.js";
import type { AuthProfileStore } from "./types.js";

const OAUTH_PROVIDER_IDS = new Set<string>(getOAuthProviders().map((provider) => provider.id));
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const ANTHROPIC_OAUTH_EARLY_EXPIRY_GRACE_MS = 5 * 60 * 1000;

const isOAuthProvider = (provider: string): provider is OAuthProvider =>
  OAUTH_PROVIDER_IDS.has(provider);

const resolveOAuthProvider = (provider: string): OAuthProvider | null =>
  isOAuthProvider(provider) ? provider : null;

/** Bearer-token auth modes that are interchangeable (oauth tokens and raw tokens). */
const BEARER_AUTH_MODES = new Set(["oauth", "token"]);
const ANTHROPIC_DEFAULT_PROFILE_ID = "anthropic:default";

const isCompatibleModeType = (mode: string | undefined, type: string | undefined): boolean => {
  if (!mode || !type) {
    return false;
  }
  if (mode === type) {
    return true;
  }
  // Both token and oauth represent bearer-token auth paths — allow bidirectional compat.
  return BEARER_AUTH_MODES.has(mode) && BEARER_AUTH_MODES.has(type);
};

function isProfileConfigCompatible(params: {
  cfg?: OpenClawConfig;
  profileId: string;
  provider: string;
  mode: "api_key" | "token" | "oauth";
  allowOAuthTokenCompatibility?: boolean;
}): boolean {
  const profileConfig = params.cfg?.auth?.profiles?.[params.profileId];
  if (profileConfig && profileConfig.provider !== params.provider) {
    return false;
  }
  if (profileConfig && !isCompatibleModeType(profileConfig.mode, params.mode)) {
    return false;
  }
  return true;
}

function buildOAuthApiKey(provider: string, credentials: OAuthCredentials): string {
  const needsProjectId = provider === "google-gemini-cli";
  return needsProjectId
    ? JSON.stringify({
        token: credentials.access,
        projectId: credentials.projectId,
      })
    : credentials.access;
}

function buildApiKeyProfileResult(params: { apiKey: string; provider: string; email?: string }) {
  return {
    apiKey: params.apiKey,
    provider: params.provider,
    email: params.email,
  };
}

function buildOAuthProfileResult(params: {
  provider: string;
  credentials: OAuthCredentials;
  email?: string;
}) {
  return buildApiKeyProfileResult({
    apiKey: buildOAuthApiKey(params.provider, params.credentials),
    provider: params.provider,
    email: params.email,
  });
}

function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shouldUseOpenaiCodexRefreshFallback(params: {
  provider: string;
  credentials: OAuthCredentials;
  error: unknown;
}): boolean {
  if (normalizeProviderId(params.provider) !== "openai-codex") {
    return false;
  }
  const message = extractErrorMessage(params.error);
  if (!/extract\s+accountid\s+from\s+token/i.test(message)) {
    return false;
  }
  return (
    typeof params.credentials.access === "string" && params.credentials.access.trim().length > 0
  );
}

function shouldUseAnthropicCachedAccessFallback(params: {
  provider: string;
  credentials: OAuthCredentials;
  now?: number;
}): boolean {
  if (normalizeProviderId(params.provider) !== "anthropic") {
    return false;
  }
  if (
    typeof params.credentials.access !== "string" ||
    params.credentials.access.trim().length === 0 ||
    !Number.isFinite(params.credentials.expires)
  ) {
    return false;
  }

  // Anthropic refreshes are stored 5 minutes early in this branch. If refresh fails inside that
  // window, the cached access token may still be valid and matches CLIProxyAPI's exact-expiry
  // behavior more closely.
  const now = params.now ?? Date.now();
  return now < params.credentials.expires + ANTHROPIC_OAUTH_EARLY_EXPIRY_GRACE_MS;
}

function isValidOAuthExpiry(expires: number): boolean {
  return Number.isFinite(expires) && expires > 0;
}

function isOAuthStillValid(credentials: OAuthCredentials, now = Date.now()): boolean {
  return isValidOAuthExpiry(credentials.expires) && now < credentials.expires;
}

function isOAuthFreshEnough(
  credentials: OAuthCredentials,
  refreshLeadMs = 0,
  now = Date.now(),
): boolean {
  const leadMs = Math.max(0, refreshLeadMs);
  return isValidOAuthExpiry(credentials.expires) && now + leadMs < credentials.expires;
}

function resolveOAuthProactiveRefreshWindowMs(provider: string): number {
  return normalizeProviderId(provider) === "anthropic" ? ANTHROPIC_OAUTH_PROACTIVE_REFRESH_MS : 0;
}

function mirrorAnthropicOAuthToClaudeCli(provider: string, credentials: OAuthCredentials): void {
  if (normalizeProviderId(provider) !== "anthropic") {
    return;
  }
  writeClaudeCliCredentials(credentials);
}

function isAnthropicInvalidGrantError(provider: string, error: unknown): boolean {
  if (normalizeProviderId(provider) !== "anthropic") {
    return false;
  }
  return /invalid_grant|refresh token not found or invalid/i.test(extractErrorMessage(error));
}

function recoverAnthropicProfileFromClaudeCli(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
  email?: string;
}): { apiKey: string; provider: string; email?: string } | null {
  const freshCliCred = readClaudeCliCredentials({ allowKeychainPrompt: false });
  if (!freshCliCred || freshCliCred.provider !== "anthropic") {
    return null;
  }

  const recoveredCred = params.email ? { ...freshCliCred, email: params.email } : freshCliCred;
  const recoveredEmail = "email" in recoveredCred ? recoveredCred.email : params.email;
  params.store.profiles[CLAUDE_CLI_PROFILE_ID] = { ...recoveredCred };
  params.store.profiles[ANTHROPIC_DEFAULT_PROFILE_ID] = { ...recoveredCred };
  params.store.profiles[params.profileId] = { ...recoveredCred };
  saveAuthProfileStore(params.store, params.agentDir);
  // The gateway can keep a long-lived cached Claude CLI snapshot in memory.
  // Clear it so the retry path re-reads the fresh credential we just adopted.
  clearClaudeCliCredentialsCache();

  log.info("recovered anthropic credentials from fresh claude cli login", {
    profileId: params.profileId,
    agentDir: params.agentDir,
    expires:
      typeof recoveredCred.expires === "number" && Number.isFinite(recoveredCred.expires)
        ? new Date(recoveredCred.expires).toISOString()
        : undefined,
    type: recoveredCred.type,
  });

  if (recoveredCred.type === "oauth") {
    if (!isOAuthStillValid(recoveredCred)) {
      return null;
    }
    return buildOAuthProfileResult({
      provider: recoveredCred.provider,
      credentials: recoveredCred,
      email: recoveredEmail,
    });
  }

  const expiryState = resolveTokenExpiryState(recoveredCred.expires);
  if (expiryState === "expired" || expiryState === "invalid_expires") {
    return null;
  }
  return buildApiKeyProfileResult({
    apiKey: recoveredCred.token,
    provider: recoveredCred.provider,
    email: recoveredEmail,
  });
}

async function refreshAnthropicClaudeToken(refreshToken: string): Promise<OAuthCredentials> {
  const response = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic token refresh failed: ${error}`);
  }
  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!data.access_token || typeof data.expires_in !== "number") {
    throw new Error("Anthropic token refresh response missing required fields");
  }
  return {
    access: data.access_token,
    refresh: data.refresh_token || refreshToken,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

type ResolveApiKeyForProfileParams = {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
};

type SecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];

function adoptNewerMainOAuthCredential(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
  cred: OAuthCredentials & { type: "oauth"; provider: string; email?: string };
}): (OAuthCredentials & { type: "oauth"; provider: string; email?: string }) | null {
  if (!params.agentDir) {
    return null;
  }
  try {
    const mainStore = ensureAuthProfileStore(undefined);
    const mainCred = mainStore.profiles[params.profileId];
    if (
      mainCred?.type === "oauth" &&
      mainCred.provider === params.cred.provider &&
      Number.isFinite(mainCred.expires) &&
      (!Number.isFinite(params.cred.expires) || mainCred.expires > params.cred.expires)
    ) {
      params.store.profiles[params.profileId] = { ...mainCred };
      saveAuthProfileStore(params.store, params.agentDir);
      log.info("adopted newer OAuth credentials from main agent", {
        profileId: params.profileId,
        agentDir: params.agentDir,
        expires: new Date(mainCred.expires).toISOString(),
      });
      return mainCred;
    }
  } catch (err) {
    // Best-effort: don't crash if main agent store is missing or unreadable.
    log.debug("adoptNewerMainOAuthCredential failed", {
      profileId: params.profileId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}

async function refreshOAuthTokenWithLock(params: {
  profileId: string;
  agentDir?: string;
  refreshIfExpiresWithinMs?: number;
  force?: boolean;
}): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
  const authPath = resolveAuthStorePath(params.agentDir);
  ensureAuthStoreFile(authPath);

  return await withFileLock(authPath, AUTH_STORE_LOCK_OPTIONS, async () => {
    const store = ensureAuthProfileStore(params.agentDir);
    const cred = store.profiles[params.profileId];
    if (!cred || cred.type !== "oauth") {
      return null;
    }

    const refreshLeadMs = Math.max(0, params.refreshIfExpiresWithinMs ?? 0);
    if (!params.force && isOAuthFreshEnough(cred, refreshLeadMs)) {
      return {
        apiKey: buildOAuthApiKey(cred.provider, cred),
        newCredentials: cred,
      };
    }

    const oauthCreds: Record<string, OAuthCredentials> = {
      [cred.provider]: cred,
    };

    const result =
      String(cred.provider) === "chutes"
        ? await (async () => {
            const newCredentials = await refreshChutesTokens({
              credential: cred,
            });
            return { apiKey: newCredentials.access, newCredentials };
          })()
        : String(cred.provider) === "anthropic"
          ? await (async () => {
              const newCredentials = await refreshAnthropicClaudeToken(cred.refresh);
              return { apiKey: newCredentials.access, newCredentials };
            })()
          : String(cred.provider) === "qwen-portal"
            ? await (async () => {
                const newCredentials = await refreshQwenPortalCredentials(cred);
                return { apiKey: newCredentials.access, newCredentials };
              })()
            : await (async () => {
                const oauthProvider = resolveOAuthProvider(cred.provider);
                if (!oauthProvider) {
                  return null;
                }
                return await getOAuthApiKey(oauthProvider, oauthCreds);
              })();
    if (!result) {
      return null;
    }
    const updatedCredentials: OAuthCredentials & {
      type: "oauth";
      provider: string;
      email?: string;
    } = {
      ...cred,
      ...result.newCredentials,
      type: "oauth",
    };
    store.profiles[params.profileId] = updatedCredentials;
    saveAuthProfileStore(store, params.agentDir);
    mirrorAnthropicOAuthToClaudeCli(updatedCredentials.provider, updatedCredentials);

    return {
      apiKey: result.apiKey,
      newCredentials: updatedCredentials,
    };
  });
}

export async function forceRefreshOAuthProfile(params: {
  cfg?: OpenClawConfig;
  profileId: string;
  agentDir?: string;
  provider?: string;
}): Promise<{ apiKey: string; provider: string; email?: string } | null> {
  const store = ensureAuthProfileStore(params.agentDir);
  const cred = store.profiles[params.profileId];
  if (!cred || cred.type !== "oauth") {
    return null;
  }
  if (
    params.provider &&
    normalizeProviderId(cred.provider) !== normalizeProviderId(params.provider)
  ) {
    return null;
  }
  if (
    !isProfileConfigCompatible({
      cfg: params.cfg,
      profileId: params.profileId,
      provider: cred.provider,
      mode: cred.type,
    })
  ) {
    return null;
  }

  try {
    const refreshed = await refreshOAuthTokenWithLock({
      profileId: params.profileId,
      agentDir: params.agentDir,
      force: true,
    });
    if (!refreshed) {
      return null;
    }
    return buildApiKeyProfileResult({
      apiKey: refreshed.apiKey,
      provider: cred.provider,
      email: cred.email,
    });
  } catch (error) {
    const refreshedStore = ensureAuthProfileStore(params.agentDir);
    const refreshed = refreshedStore.profiles[params.profileId];
    if (
      refreshed?.type === "oauth" &&
      isOAuthStillValid(refreshed) &&
      (!params.provider ||
        normalizeProviderId(refreshed.provider) === normalizeProviderId(params.provider))
    ) {
      return buildOAuthProfileResult({
        provider: refreshed.provider,
        credentials: refreshed,
        email: refreshed.email ?? cred.email,
      });
    }
    if (isAnthropicInvalidGrantError(cred.provider, error)) {
      const recovered = recoverAnthropicProfileFromClaudeCli({
        store: refreshedStore,
        profileId: params.profileId,
        agentDir: params.agentDir,
        email: cred.email,
      });
      if (recovered) {
        return recovered;
      }
    }
    throw error;
  }
}

async function tryResolveOAuthProfile(
  params: ResolveApiKeyForProfileParams,
): Promise<{ apiKey: string; provider: string; email?: string } | null> {
  const { cfg, store, profileId } = params;
  const cred = store.profiles[profileId];
  if (!cred || cred.type !== "oauth") {
    return null;
  }
  if (
    !isProfileConfigCompatible({
      cfg,
      profileId,
      provider: cred.provider,
      mode: cred.type,
    })
  ) {
    return null;
  }

  const refreshLeadMs = resolveOAuthProactiveRefreshWindowMs(cred.provider);
  if (isOAuthFreshEnough(cred, refreshLeadMs)) {
    return buildOAuthProfileResult({
      provider: cred.provider,
      credentials: cred,
      email: cred.email,
    });
  }

  try {
    const refreshed = await refreshOAuthTokenWithLock({
      profileId,
      agentDir: params.agentDir,
      refreshIfExpiresWithinMs: refreshLeadMs,
    });
    if (!refreshed) {
      if (isOAuthStillValid(cred)) {
        return buildOAuthProfileResult({
          provider: cred.provider,
          credentials: cred,
          email: cred.email,
        });
      }
      return null;
    }
    return buildApiKeyProfileResult({
      apiKey: refreshed.apiKey,
      provider: cred.provider,
      email: cred.email,
    });
  } catch (error) {
    if (
      shouldUseAnthropicCachedAccessFallback({
        provider: cred.provider,
        credentials: cred,
      })
    ) {
      log.warn(
        "anthropic oauth refresh failed inside early-expiry window; using cached access token fallback",
        {
          profileId,
          provider: cred.provider,
          error: extractErrorMessage(error),
        },
      );
      return buildApiKeyProfileResult({
        apiKey: cred.access,
        provider: cred.provider,
        email: cred.email,
      });
    }
    if (isOAuthStillValid(cred)) {
      log.warn("oauth proactive refresh failed; using still-valid cached token", {
        profileId,
        provider: cred.provider,
        error: extractErrorMessage(error),
        expires: new Date(cred.expires).toISOString(),
      });
      return buildOAuthProfileResult({
        provider: cred.provider,
        credentials: cred,
        email: cred.email,
      });
    }
    throw error;
  }
}

async function resolveProfileSecretString(params: {
  profileId: string;
  provider: string;
  value: string | undefined;
  valueRef: unknown;
  refDefaults: SecretDefaults | undefined;
  configForRefResolution: OpenClawConfig;
  cache: SecretRefResolveCache;
  inlineFailureMessage: string;
  refFailureMessage: string;
}): Promise<string | undefined> {
  let resolvedValue = params.value?.trim();
  if (resolvedValue) {
    const inlineRef = coerceSecretRef(resolvedValue, params.refDefaults);
    if (inlineRef) {
      try {
        resolvedValue = await resolveSecretRefString(inlineRef, {
          config: params.configForRefResolution,
          env: process.env,
          cache: params.cache,
        });
      } catch (err) {
        log.debug(params.inlineFailureMessage, {
          profileId: params.profileId,
          provider: params.provider,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const explicitRef = coerceSecretRef(params.valueRef, params.refDefaults);
  if (!resolvedValue && explicitRef) {
    try {
      resolvedValue = await resolveSecretRefString(explicitRef, {
        config: params.configForRefResolution,
        env: process.env,
        cache: params.cache,
      });
    } catch (err) {
      log.debug(params.refFailureMessage, {
        profileId: params.profileId,
        provider: params.provider,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return resolvedValue;
}

export async function resolveApiKeyForProfile(
  params: ResolveApiKeyForProfileParams,
): Promise<{ apiKey: string; provider: string; email?: string } | null> {
  const { cfg, store, profileId } = params;
  const cred = store.profiles[profileId];
  if (!cred) {
    return null;
  }
  if (
    !isProfileConfigCompatible({
      cfg,
      profileId,
      provider: cred.provider,
      mode: cred.type,
      // Compatibility: treat "oauth" config as compatible with stored token profiles.
      allowOAuthTokenCompatibility: true,
    })
  ) {
    return null;
  }

  const refResolveCache: SecretRefResolveCache = {};
  const configForRefResolution = cfg ?? loadConfig();
  const refDefaults = configForRefResolution.secrets?.defaults;

  if (cred.type === "api_key") {
    const key = await resolveProfileSecretString({
      profileId,
      provider: cred.provider,
      value: cred.key,
      valueRef: cred.keyRef,
      refDefaults,
      configForRefResolution,
      cache: refResolveCache,
      inlineFailureMessage: "failed to resolve inline auth profile api_key ref",
      refFailureMessage: "failed to resolve auth profile api_key ref",
    });
    if (!key) {
      return null;
    }
    return buildApiKeyProfileResult({ apiKey: key, provider: cred.provider, email: cred.email });
  }
  if (cred.type === "token") {
    const expiryState = resolveTokenExpiryState(cred.expires);
    if (expiryState === "expired" || expiryState === "invalid_expires") {
      return null;
    }
    const token = await resolveProfileSecretString({
      profileId,
      provider: cred.provider,
      value: cred.token,
      valueRef: cred.tokenRef,
      refDefaults,
      configForRefResolution,
      cache: refResolveCache,
      inlineFailureMessage: "failed to resolve inline auth profile token ref",
      refFailureMessage: "failed to resolve auth profile token ref",
    });
    if (!token) {
      return null;
    }
    return buildApiKeyProfileResult({ apiKey: token, provider: cred.provider, email: cred.email });
  }

  const oauthCred =
    adoptNewerMainOAuthCredential({
      store,
      profileId,
      agentDir: params.agentDir,
      cred,
    }) ?? cred;

  const refreshLeadMs = resolveOAuthProactiveRefreshWindowMs(oauthCred.provider);
  if (isOAuthFreshEnough(oauthCred, refreshLeadMs)) {
    return buildOAuthProfileResult({
      provider: oauthCred.provider,
      credentials: oauthCred,
      email: oauthCred.email,
    });
  }

  try {
    const result = await refreshOAuthTokenWithLock({
      profileId,
      agentDir: params.agentDir,
      refreshIfExpiresWithinMs: refreshLeadMs,
    });
    if (!result) {
      if (isOAuthStillValid(oauthCred)) {
        return buildOAuthProfileResult({
          provider: oauthCred.provider,
          credentials: oauthCred,
          email: oauthCred.email,
        });
      }
      return null;
    }
    return buildApiKeyProfileResult({
      apiKey: result.apiKey,
      provider: cred.provider,
      email: cred.email,
    });
  } catch (error) {
    const refreshedStore = ensureAuthProfileStore(params.agentDir);
    const refreshed = refreshedStore.profiles[profileId];
    if (refreshed?.type === "oauth" && isOAuthStillValid(refreshed)) {
      return buildOAuthProfileResult({
        provider: refreshed.provider,
        credentials: refreshed,
        email: refreshed.email ?? cred.email,
      });
    }
    if (isAnthropicInvalidGrantError(cred.provider, error)) {
      const recovered = recoverAnthropicProfileFromClaudeCli({
        store: refreshedStore,
        profileId,
        agentDir: params.agentDir,
        email: cred.email,
      });
      if (recovered) {
        return recovered;
      }
    }
    if (isOAuthStillValid(oauthCred)) {
      log.warn("oauth proactive refresh failed; using still-valid cached token", {
        profileId,
        provider: cred.provider,
        error: extractErrorMessage(error),
        expires: new Date(oauthCred.expires).toISOString(),
      });
      return buildOAuthProfileResult({
        provider: oauthCred.provider,
        credentials: oauthCred,
        email: oauthCred.email,
      });
    }
    const fallbackProfileId = suggestOAuthProfileIdForLegacyDefault({
      cfg,
      store: refreshedStore,
      provider: cred.provider,
      legacyProfileId: profileId,
    });
    if (fallbackProfileId && fallbackProfileId !== profileId) {
      try {
        const fallbackResolved = await tryResolveOAuthProfile({
          cfg,
          store: refreshedStore,
          profileId: fallbackProfileId,
          agentDir: params.agentDir,
        });
        if (fallbackResolved) {
          return fallbackResolved;
        }
      } catch {
        // keep original error
      }
    }

    // Fallback: if this is a secondary agent, try using the main agent's credentials
    if (params.agentDir) {
      try {
        const mainStore = ensureAuthProfileStore(undefined); // main agent (no agentDir)
        const mainCred = mainStore.profiles[profileId];
        if (mainCred?.type === "oauth" && Date.now() < mainCred.expires) {
          // Main agent has fresh credentials - copy them to this agent and use them
          refreshedStore.profiles[profileId] = { ...mainCred };
          saveAuthProfileStore(refreshedStore, params.agentDir);
          log.info("inherited fresh OAuth credentials from main agent", {
            profileId,
            agentDir: params.agentDir,
            expires: new Date(mainCred.expires).toISOString(),
          });
          return buildOAuthProfileResult({
            provider: mainCred.provider,
            credentials: mainCred,
            email: mainCred.email,
          });
        }
      } catch {
        // keep original error if main agent fallback also fails
      }
    }

    if (
      shouldUseOpenaiCodexRefreshFallback({
        provider: cred.provider,
        credentials: cred,
        error,
      })
    ) {
      log.warn("openai-codex oauth refresh failed; using cached access token fallback", {
        profileId,
        provider: cred.provider,
      });
      return buildApiKeyProfileResult({
        apiKey: cred.access,
        provider: cred.provider,
        email: cred.email,
      });
    }

    if (
      shouldUseAnthropicCachedAccessFallback({
        provider: cred.provider,
        credentials: cred,
      })
    ) {
      log.warn(
        "anthropic oauth refresh failed inside early-expiry window; using cached access token fallback",
        {
          profileId,
          provider: cred.provider,
          error: extractErrorMessage(error),
        },
      );
      return buildApiKeyProfileResult({
        apiKey: cred.access,
        provider: cred.provider,
        email: cred.email,
      });
    }

    const message = extractErrorMessage(error);
    const hint = formatAuthDoctorHint({
      cfg,
      store: refreshedStore,
      provider: cred.provider,
      profileId,
    });
    throw new Error(
      `OAuth token refresh failed for ${cred.provider}: ${message}. ` +
        "Please try again or re-authenticate." +
        (hint ? `\n\n${hint}` : ""),
      { cause: error },
    );
  }
}
