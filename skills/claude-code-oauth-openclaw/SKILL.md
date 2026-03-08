---
name: claude-code-oauth-openclaw
description: Complete Claude Code OAuth login on headless or remote machines when `claude auth login` cannot finish the localhost callback flow, then persist the resulting credentials in `~/.claude/.credentials.json` and refresh `~/.claude.json` account metadata. Use when debugging Claude Code OAuth, manual PKCE exchange, local credential repair, or OpenClaw and Anthropic compatibility issues that depend on a real Claude OAuth bearer token.
metadata: { "openclaw": { "emoji": "🔐", "requires": { "bins": ["python3", "curl", "claude"] } } }
---

# Claude Code OAuth OpenClaw

Use this skill when Claude Code OAuth needs to be repaired or repeated without relying on the built-in browser callback flow.

## Quick start

1. Run `python3 scripts/claude_oauth_manual.py start`.
2. Open the printed URL in a browser and finish sign-in.
3. Copy the returned `code#state` value.
4. Run `python3 scripts/claude_oauth_manual.py finish '<code#state>'`.
5. Verify with `env -u ANTHROPIC_API_KEY claude auth status --json`.

## Workflow

### Start a manual PKCE flow

Run the bundled script:

```bash
python3 scripts/claude_oauth_manual.py start
```

The script:

- generates a PKCE verifier and challenge
- stores the flow state in `~/.claude/oauth-manual/*.json`
- prints the authorize URL

Default mode is the Claude Code / Claude.ai login flow. Use `--authorize-source console` when you need the Platform authorize URL instead.

Useful options:

- `--scope-set cli`: `user:profile user:inference user:sessions:claude_code user:mcp_servers`
- `--scope-set all`: add `org:create_api_key`
- `--scope-set inference-only`: request only `user:inference`

### Finish the flow and write credentials

After browser sign-in, pass the returned `code#state`:

```bash
python3 scripts/claude_oauth_manual.py finish '<code#state>'
```

The script exchanges the code with the exact JSON request shape used by Claude Code, then:

- writes `~/.claude/.credentials.json`
- updates `~/.claude.json` `oauthAccount`
- best-effort fetches `/api/oauth/profile`
- best-effort fetches `/api/oauth/claude_cli/roles`

If there are multiple saved state files, pass `--state-file <path>`.

### Inspect local state

Run:

```bash
python3 scripts/claude_oauth_manual.py status
```

Use this before or after repair work to confirm:

- whether credentials exist
- whether they are expired
- which scopes are stored
- which account and organization are cached locally

## Important findings

Read `references/findings.md` when you need the raw request and file details.

The short version:

- On remote or headless hosts, `claude auth login` can fail because the localhost callback never cleanly completes.
- Manual PKCE works if the token exchange uses JSON, not form-urlencoded.
- Claude Code stores OAuth state in `~/.claude/.credentials.json` under `claudeAiOauth`.
- `~/.claude.json` also matters because `oauthAccount` holds the email and organization metadata shown by Claude Code.
- `GET /api/oauth/claude_cli/roles` requires `anthropic-beta: oauth-2025-04-20`.

## OpenClaw and Anthropic notes

Keep these compatibility facts in mind:

- Official Anthropic Messages accepts the Anthropic custom-tool shape.
- Official Anthropic Messages rejects the literal OpenAI `type:"function"` tool envelope.
- If OpenClaw emits OpenAI-style function tools, a proxy layer must rewrite them to Anthropic explicit custom tools before forwarding upstream.

Read `references/findings.md` for the exact summary and endpoint details.
