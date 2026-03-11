---
summary: "A deep technical walkthrough of Claude Code OAuth login, local credential storage, refresh, and how OpenClaw imports and repairs those credentials"
read_when:
  - You are debugging Claude Code login on a gateway host
  - You need to understand the PKCE flow behind `claude auth login`
  - You hit `invalid_grant`, stale refresh tokens, or headless callback failures
  - You want to know how OpenClaw reads Claude Code credentials
title: "Claude Code OAuth Login"
---

# Claude Code OAuth Login

This page is a technical deep dive into how Claude Code login works in practice, how the resulting OAuth credentials are stored locally, and how OpenClaw consumes and refreshes them.

It focuses on the mechanics:

- the PKCE browser flow
- the token exchange payload
- the local files and keychain entries
- refresh behavior
- the failure modes we have actually observed while running OpenClaw against Anthropic

If you only want the higher-level OpenClaw auth model, start with [OAuth](/concepts/oauth).

## The big picture

Claude Code login is a normal OAuth 2.0 authorization-code flow with PKCE.

At a high level, the flow is:

1. Generate a PKCE verifier, challenge, and random `state`.
2. Open a browser to Claude's authorize URL.
3. Sign in on Claude.ai.
4. Receive an authorization `code`.
5. Exchange that `code` plus the PKCE verifier for an access token and refresh token.
6. Store those tokens locally.
7. Use the access token for Anthropic-authenticated requests.
8. Use the refresh token later to mint fresh access tokens.

OpenClaw adds one more step:

9. Import Claude Code's local credential state into OpenClaw's auth-profile store so agents can reuse the same Anthropic identity.

## Step 1: PKCE setup before the browser opens

Before the browser opens, the client must create:

- a random PKCE verifier
- a SHA-256-based PKCE challenge
- a random OAuth `state`

OpenClaw's manual repair flow does exactly that in `skills/claude-code-oauth-openclaw/scripts/claude_oauth_manual.py:51-64`.

The authorize URL parameters are assembled in `skills/claude-code-oauth-openclaw/scripts/claude_oauth_manual.py:124-152`. The important fields are:

- `client_id`
- `response_type=code`
- `redirect_uri`
- `scope`
- `code_challenge`
- `code_challenge_method=S256`
- `state`

For Claude Code / Claude.ai login, the observed values are:

- authorize URL: `https://claude.ai/oauth/authorize`
- token URL: `https://platform.claude.com/v1/oauth/token`
- client ID: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- default manual redirect URI: `https://platform.claude.com/oauth/code/callback`

These values are recorded in `skills/claude-code-oauth-openclaw/references/findings.md:5-10`.

## Step 2: Browser login and callback

After the authorize URL opens, the browser session handles the human login step:

- account selection
- authentication
- consent, if required

At the end of that browser flow, the OAuth server returns:

- an authorization `code`
- the original `state`

In a fully interactive local flow, `claude auth login` expects to receive that via a localhost callback. The expected shape is documented in `skills/claude-code-oauth-openclaw/references/findings.md:81-89`:

```text
http://127.0.0.1:<port>/callback?code=...&state=...
```

That works well on a normal desktop session, but it can fail on:

- headless servers
- SSH sessions
- remote TTYs where the local callback cannot bind or complete cleanly

That is why the manual PKCE flow exists: it stores the verifier and state locally first, then lets you paste back the final `code#state` string.

## Step 3: Token exchange

Once the client has the authorization code, it exchanges it for tokens.

The important implementation detail is that Claude's token endpoint expects JSON for this exchange, not form-urlencoded data.

The observed successful request shape is documented in `skills/claude-code-oauth-openclaw/references/findings.md:12-25` and implemented in `skills/claude-code-oauth-openclaw/scripts/claude_oauth_manual.py:246-257`:

```json
{
  "grant_type": "authorization_code",
  "code": "<authorization-code>",
  "redirect_uri": "https://platform.claude.com/oauth/code/callback",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "code_verifier": "<pkce-verifier>",
  "state": "<oauth-state>"
}
```

The token endpoint then returns some combination of:

- `access_token`
- `refresh_token`
- `expires_in`
- `scope`

That is the moment where the flow becomes a reusable machine credential instead of a one-time browser login.

## Step 4: What gets stored locally

There are two pieces of local state that matter:

1. `~/.claude/.credentials.json`
2. `~/.claude.json`

### `~/.claude/.credentials.json`

This is the main token file. The important object is `claudeAiOauth`.

The observed shape is documented in `skills/claude-code-oauth-openclaw/references/findings.md:27-42`:

```json
{
  "claudeAiOauth": {
    "accessToken": "<bearer-token>",
    "refreshToken": "<refresh-token>",
    "expiresAt": 1760000000000,
    "scopes": ["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers"],
    "subscriptionType": "max",
    "rateLimitTier": "default_claude_max_20x"
  }
}
```

OpenClaw's Claude credential parser reads exactly those fields in `src/agents/cli-credentials.ts:96-124`.

### `~/.claude.json`

This file holds account and organization metadata that Claude Code uses for status and context. OpenClaw's manual repair helper updates `oauthAccount` here in `skills/claude-code-oauth-openclaw/scripts/claude_oauth_manual.py:260-301`.

That metadata includes fields such as:

- account UUID
- email address
- organization UUID
- organization name
- billing type

The observed example is in `skills/claude-code-oauth-openclaw/references/findings.md:44-58`.

## Step 5: macOS keychain versus file storage

When OpenClaw imports Claude Code credentials, it does not just read the JSON file.

On macOS, OpenClaw first tries the keychain service named `Claude Code-credentials`, then falls back to `~/.claude/.credentials.json`.

You can see that in `src/agents/cli-credentials.ts:17-18` and `src/agents/cli-credentials.ts:261-302`.

That distinction matters because:

- on macOS, the freshest credential may live in the keychain
- on Linux and most headless hosts, the file is usually the real source of truth

When OpenClaw refreshes Anthropic OAuth successfully, it mirrors the new token set back into the Claude Code storage path in `src/agents/auth-profiles/oauth.ts:142-147` and `src/agents/auth-profiles/oauth.ts:348-350`, using the write helpers in `src/agents/cli-credentials.ts:334-450`.

## Step 6: How OpenClaw imports Claude Code credentials

OpenClaw treats Claude Code as an external CLI credential source.

That sync logic lives in `src/agents/auth-profiles/external-cli-sync.ts:195-222`.

The imported credentials are mapped into two Anthropic auth-profile IDs:

- `anthropic:claude-cli`
- `anthropic:default`

The profile ID constant is defined in `src/agents/auth-profiles/constants.ts:7`.

The practical meaning is:

- Claude Code owns the login flow
- OpenClaw reads the resulting token state
- OpenClaw stores it in its own auth-profile store
- agents then resolve Anthropic credentials from that store at runtime

## Step 7: How refresh works

Access tokens expire. That is normal.

So later, instead of sending the user back through the browser again, the client uses the refresh token to ask for new tokens.

For Anthropic, OpenClaw performs that refresh in `src/agents/auth-profiles/oauth.ts:206-234`.

The refresh request shape is:

```json
{
  "grant_type": "refresh_token",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "refresh_token": "<refresh-token>"
}
```

If refresh succeeds:

- a new access token is returned
- a new refresh token may also be returned
- the auth store is overwritten with the fresh values
- Claude Code local storage is updated too

The store update and mirror-back behavior happen in `src/agents/auth-profiles/oauth.ts:340-350`.

## Step 8: Why stale refresh tokens happen

The hard part of OAuth is not the initial browser login. It is keeping multiple consumers of the same identity in sync.

The common failure mode is:

1. Claude Code logs in and stores refresh token A.
2. Another login or refresh issues refresh token B.
3. Refresh token A is revoked.
4. Some long-running process still tries to use A.
5. The provider responds with `invalid_grant`.

This is exactly the class of problem OpenClaw has to defend against when it shares Anthropic identity with Claude Code.

OpenClaw caches external CLI credentials for a short period. The current TTL is 15 minutes in `src/agents/auth-profiles/constants.ts:23`.

That cache exists for performance, but it means a long-lived runtime can temporarily keep a stale view of the Claude credential set.

## Step 9: The `invalid_grant` recovery path

OpenClaw now has an explicit recovery path for the Anthropic `invalid_grant` case.

The guard is in `src/agents/auth-profiles/oauth.ts:149-153`.

If Anthropic refresh fails with an error matching:

- `invalid_grant`
- `Refresh token not found or invalid`

then OpenClaw does not just give up.

Instead, it:

1. performs a fresh, uncached read of Claude Code credentials via `readClaudeCliCredentials(...)`
2. writes that fresh credential into:
   - `anthropic:claude-cli`
   - `anthropic:default`
   - the current profile being resolved
3. saves the auth store
4. continues with the recovered credential

That recovery helper is implemented in `src/agents/auth-profiles/oauth.ts:156-204`.

It is invoked from both:

- forced refresh paths in `src/agents/auth-profiles/oauth.ts:401-427`
- normal auth-profile resolution in `src/agents/auth-profiles/oauth.ts:651-671`

In practice, this means that if a running gateway process gets stuck with a revoked refresh token, but Claude Code has already logged in again successfully, OpenClaw can now recover from the fresh Claude credential state instead of requiring a restart or manual file surgery.

## Step 10: Protecting fresher credentials from older cached state

There is a second subtle bug class: even if a fresh credential exists, a slightly older cached credential should not overwrite it.

OpenClaw now guards against that in `src/agents/auth-profiles/external-cli-sync.ts:74-99`.

The rule is simple:

- if the existing external-CLI-managed profile is still fresh
- and the incoming cached credential expires earlier
- do not replace the existing one

That keeps a stale cache snapshot from downgrading the auth store.

## Step 11: Helpful Anthropic OAuth endpoints

When debugging a login, two Anthropic OAuth endpoints are especially useful:

### Profile

Documented in `skills/claude-code-oauth-openclaw/references/findings.md:60-68`

```bash
curl -H "authorization: Bearer <access-token>" \
  -H "content-type: application/json" \
  https://api.anthropic.com/api/oauth/profile
```

### Claude CLI roles

Documented in `skills/claude-code-oauth-openclaw/references/findings.md:70-79`

```bash
curl -H "authorization: Bearer <access-token>" \
  -H "anthropic-beta: oauth-2025-04-20" \
  -H "content-type: application/json" \
  https://api.anthropic.com/api/oauth/claude_cli/roles
```

The second endpoint requires the `anthropic-beta: oauth-2025-04-20` header.

## Step 12: What this means operationally

If you are running OpenClaw on a gateway host and want Claude Code auth to stay healthy, the practical rules are:

- treat Claude login as the source of truth for Anthropic OAuth identity
- expect refresh tokens to rotate
- assume older refresh tokens can be revoked
- prefer a single consistent login source per machine when possible
- if you re-authenticate in Claude Code, make sure long-running processes can see the fresh credential set

With the current OpenClaw recovery logic, the runtime can now recover from the most common Anthropic `invalid_grant` case automatically, as long as the fresh Claude login state is already present locally.

## Step 13: A debugging checklist

When Claude Code or OpenClaw Anthropic auth is acting strangely, check these in order:

1. Is Claude Code itself logged in
   - `claude auth status --json`
2. Does `~/.claude/.credentials.json` contain a valid `claudeAiOauth` object
3. On macOS, is the keychain entry fresher than the file
4. Does OpenClaw show Anthropic OAuth profiles in `openclaw models status --json`
5. Is the current failure an auth failure or a queue/runtime failure
6. If the error is `invalid_grant`, did the process reload fresh Claude credentials after the last login

For headless or remote repair, use the manual PKCE helper documented in `skills/claude-code-oauth-openclaw/SKILL.md:11-66`.

## Related docs

- [OAuth](/concepts/oauth)
- [Model Failover](/concepts/model-failover)
- [Models](/concepts/models)
- [FAQ](/help/faq)
