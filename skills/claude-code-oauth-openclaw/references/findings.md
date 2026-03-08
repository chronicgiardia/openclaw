# Findings

## OAuth exchange that actually works

Claude Code uses:

- authorize URL: `https://claude.ai/oauth/authorize` for Claude.ai login
- token URL: `https://platform.claude.com/v1/oauth/token`
- manual redirect URI: `https://platform.claude.com/oauth/code/callback`
- client ID: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`

The token exchange request must be JSON:

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

Sending this as `application/x-www-form-urlencoded` produced `400 Invalid request format`. Sending it as JSON succeeded.

## Local files Claude Code reads

`~/.claude/.credentials.json`:

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

`~/.claude.json` also needs current account metadata. The useful keys are:

```json
{
  "oauthAccount": {
    "accountUuid": "<account-uuid>",
    "emailAddress": "user@example.com",
    "organizationUuid": "<org-uuid>",
    "organizationName": "Example Organization",
    "billingType": "stripe_subscription",
    "accountCreatedAt": "2025-01-01T00:00:00Z",
    "subscriptionCreatedAt": "2025-01-02T00:00:00Z"
  }
}
```

## Helpful OAuth endpoints

Profile:

```bash
curl -H "authorization: Bearer <access-token>" \
  -H "content-type: application/json" \
  https://api.anthropic.com/api/oauth/profile
```

Roles:

```bash
curl -H "authorization: Bearer <access-token>" \
  -H "anthropic-beta: oauth-2025-04-20" \
  -H "content-type: application/json" \
  https://api.anthropic.com/api/oauth/claude_cli/roles
```

The roles endpoint needs the OAuth beta header. The profile endpoint does not.

## Why manual PKCE is needed on headless machines

`claude auth login` expects a localhost callback like:

```text
http://127.0.0.1:<port>/callback?code=...&state=...
```

On remote TTY sessions that callback flow can stall or fail even after the browser completes sign-in. Manual PKCE avoids the callback dependency by saving the verifier and state locally, then exchanging `code#state` directly.

## OpenClaw and Anthropic tool signatures

Official Anthropic Messages:

- accepts Anthropic custom tools such as `name + input_schema` and explicit `type:"custom"`
- rejects literal OpenAI function envelopes such as `type:"function"`

So if OpenClaw emits OpenAI-style function tools, the working pattern is:

1. OpenClaw sends function-style tool definitions.
2. A proxy rewrites them to Anthropic explicit custom-tool payloads.
3. Anthropic receives only the rewritten custom-tool shape.

That means the compatibility layer is a rewrite, not a server-side bypass.
