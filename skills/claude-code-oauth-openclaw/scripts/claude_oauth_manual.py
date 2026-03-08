#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
MANUAL_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback"
CLAUDE_AI_AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
CONSOLE_AUTHORIZE_URL = "https://platform.claude.com/oauth/authorize"
TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
PROFILE_URL = "https://api.anthropic.com/api/oauth/profile"
ROLES_URL = "https://api.anthropic.com/api/oauth/claude_cli/roles"
ROLES_BETA = "oauth-2025-04-20"

SCOPE_SETS = {
    "cli": [
        "user:profile",
        "user:inference",
        "user:sessions:claude_code",
        "user:mcp_servers",
    ],
    "all": [
        "org:create_api_key",
        "user:profile",
        "user:inference",
        "user:sessions:claude_code",
        "user:mcp_servers",
    ],
    "inference-only": [
        "user:inference",
    ],
}


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def make_verifier() -> str:
    return b64url(secrets.token_bytes(32))


def make_challenge(verifier: str) -> str:
    return b64url(hashlib.sha256(verifier.encode("ascii")).digest())


def make_state() -> str:
    return b64url(secrets.token_bytes(32))


def claude_dir() -> Path:
    return Path.home() / ".claude"


def state_dir() -> Path:
    return claude_dir() / "oauth-manual"


def credentials_path() -> Path:
    return claude_dir() / ".credentials.json"


def config_path() -> Path:
    return Path.home() / ".claude.json"


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def write_json_atomic(path: Path, data: dict[str, Any]) -> None:
    ensure_parent(path)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, sort_keys=False)
            handle.write("\n")
        os.replace(tmp_name, path)
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass


def read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def now_ms() -> int:
    return int(time.time() * 1000)


def default_state_path(authorize_source: str, scope_set: str) -> Path:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    return state_dir() / f"{stamp}-{authorize_source}-{scope_set}.json"


def latest_state_path() -> Path:
    candidates = sorted(state_dir().glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True)
    if not candidates:
        raise SystemExit("No saved OAuth state files found in ~/.claude/oauth-manual")
    return candidates[0]


def build_authorize_url(
    *,
    authorize_url: str,
    redirect_uri: str,
    client_id: str,
    scope: list[str],
    code_challenge: str,
    state: str,
    org_uuid: str | None,
    login_hint: str | None,
    login_method: str | None,
) -> str:
    query = {
        "code": "true",
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "scope": " ".join(scope),
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "state": state,
    }
    if org_uuid:
        query["orgUUID"] = org_uuid
    if login_hint:
        query["login_hint"] = login_hint
    if login_method:
        query["login_method"] = login_method
    return f"{authorize_url}?{urllib.parse.urlencode(query)}"


def http_json(
    url: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    if shutil.which("curl"):
        return curl_json(url, method=method, payload=payload, headers=headers)

    return urllib_json(url, method=method, payload=payload, headers=headers)


def curl_json(
    url: str,
    *,
    method: str,
    payload: dict[str, Any] | None,
    headers: dict[str, str] | None,
) -> dict[str, Any]:
    command = ["curl", "-sS", "--fail-with-body", "-X", method]
    request_headers = dict(headers or {})
    if payload is not None:
        request_headers.setdefault("Content-Type", "application/json")
    for key, value in request_headers.items():
        command.extend(["-H", f"{key}: {value}"])
    if payload is not None:
        command.extend(["--data-binary", json.dumps(payload)])
    command.append(url)
    result = subprocess.run(command, check=False, capture_output=True, text=True)
    if result.returncode != 0:
        detail = result.stdout.strip() or result.stderr.strip() or "request failed"
        raise SystemExit(f"{method} {url} failed: {detail}")
    text = result.stdout.strip()
    return json.loads(text) if text else {}


def urllib_json(
    url: str,
    *,
    method: str,
    payload: dict[str, Any] | None,
    headers: dict[str, str] | None,
) -> dict[str, Any]:
    request_headers = dict(headers or {})
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        request_headers.setdefault("Content-Type", "application/json")
    request = urllib.request.Request(url, data=body, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            text = response.read().decode("utf-8")
            return json.loads(text) if text else {}
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"{method} {url} failed with {exc.code}: {text}") from exc


def parse_code_input(raw: str) -> tuple[str, str]:
    text = raw.strip()
    if "://" in text:
        parsed = urllib.parse.urlparse(text)
        query = urllib.parse.parse_qs(parsed.query)
        code = query.get("code", [None])[0]
        state = query.get("state", [None])[0]
        if not state and parsed.fragment:
            if "=" in parsed.fragment:
                fragment = urllib.parse.parse_qs(parsed.fragment)
                state = fragment.get("state", [None])[0]
            else:
                state = parsed.fragment
        if code and state:
            return code, state
    if "#" in text:
        code, state = text.split("#", 1)
        if code and state:
            return code, state
    raise SystemExit("Expected either '<code>#<state>' or a callback URL containing code and state")


def infer_subscription_type(profile: dict[str, Any], existing: dict[str, Any]) -> str | None:
    account = profile.get("account") or {}
    organization = profile.get("organization") or {}
    if account.get("has_claude_max") or organization.get("organization_type") == "claude_max":
        return "max"
    if account.get("has_claude_pro"):
        return "pro"
    return existing.get("subscriptionType")


def exchange_code(state_data: dict[str, Any], code: str, state: str) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": state_data["redirect_uri"],
        "client_id": state_data["client_id"],
        "code_verifier": state_data["verifier"],
        "state": state,
    }
    if state_data.get("expires_in") is not None:
        payload["expires_in"] = state_data["expires_in"]
    return http_json(state_data["token_url"], method="POST", payload=payload)


def write_local_credentials(
    *,
    token_response: dict[str, Any],
    profile: dict[str, Any],
    roles: dict[str, Any],
) -> None:
    existing_creds = read_json(credentials_path())
    existing_oauth = (existing_creds.get("claudeAiOauth") or {}) if isinstance(existing_creds, dict) else {}
    scope_value = token_response.get("scope") or ""
    scopes = [item for item in scope_value.split(" ") if item]
    expires_in = token_response.get("expires_in")
    expires_at = now_ms() + int(expires_in) * 1000 if expires_in is not None else None
    rate_limit_tier = ((profile.get("organization") or {}).get("rate_limit_tier")) or existing_oauth.get("rateLimitTier")
    subscription_type = infer_subscription_type(profile, existing_oauth)

    new_creds = {
        "claudeAiOauth": {
            "accessToken": token_response["access_token"],
            "refreshToken": token_response.get("refresh_token"),
            "expiresAt": expires_at,
            "scopes": scopes,
            "subscriptionType": subscription_type,
            "rateLimitTier": rate_limit_tier,
        }
    }
    write_json_atomic(credentials_path(), new_creds)

    config = read_json(config_path())
    oauth_account = dict(config.get("oauthAccount") or {})
    account = profile.get("account") or {}
    organization = profile.get("organization") or {}
    updated_account = {
        "accountUuid": account.get("uuid") or oauth_account.get("accountUuid"),
        "emailAddress": account.get("email") or account.get("email_address") or oauth_account.get("emailAddress"),
        "organizationUuid": organization.get("uuid") or roles.get("organization_uuid") or oauth_account.get("organizationUuid"),
        "organizationName": organization.get("name") or roles.get("organization_name") or oauth_account.get("organizationName"),
        "billingType": organization.get("billing_type") or oauth_account.get("billingType"),
        "accountCreatedAt": account.get("created_at") or oauth_account.get("accountCreatedAt"),
        "subscriptionCreatedAt": organization.get("subscription_created_at") or oauth_account.get("subscriptionCreatedAt"),
    }
    config["oauthAccount"] = {key: value for key, value in updated_account.items() if value is not None}
    write_json_atomic(config_path(), config)


def fetch_profile(access_token: str, profile_url: str) -> dict[str, Any]:
    return http_json(
        profile_url,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        },
    )


def fetch_roles(access_token: str, roles_url: str) -> dict[str, Any]:
    try:
        return http_json(
            roles_url,
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
                "anthropic-beta": ROLES_BETA,
            },
        )
    except SystemExit:
        return {}


def command_start(args: argparse.Namespace) -> int:
    verifier = make_verifier()
    challenge = make_challenge(verifier)
    state = make_state()
    scope = SCOPE_SETS[args.scope_set]
    authorize_url = args.authorize_url or (
        CLAUDE_AI_AUTHORIZE_URL if args.authorize_source == "claude-ai" else CONSOLE_AUTHORIZE_URL
    )
    state_path = Path(args.state_file).expanduser() if args.state_file else default_state_path(args.authorize_source, args.scope_set)
    state_payload = {
        "created_at": int(time.time()),
        "authorize_source": args.authorize_source,
        "authorize_url": authorize_url,
        "token_url": args.token_url or TOKEN_URL,
        "profile_url": args.profile_url or PROFILE_URL,
        "roles_url": args.roles_url or ROLES_URL,
        "redirect_uri": args.redirect_uri or MANUAL_REDIRECT_URI,
        "client_id": args.client_id or CLIENT_ID,
        "scope": " ".join(scope),
        "scope_list": scope,
        "scope_set": args.scope_set,
        "verifier": verifier,
        "challenge": challenge,
        "state": state,
        "org_uuid": args.org_uuid,
        "login_hint": args.login_hint,
        "login_method": args.login_method,
        "expires_in": args.expires_in,
    }
    url = build_authorize_url(
        authorize_url=authorize_url,
        redirect_uri=state_payload["redirect_uri"],
        client_id=state_payload["client_id"],
        scope=scope,
        code_challenge=challenge,
        state=state,
        org_uuid=args.org_uuid,
        login_hint=args.login_hint,
        login_method=args.login_method,
    )
    write_json_atomic(state_path, state_payload)
    print(f"State file: {state_path}")
    print("")
    print(url)
    print("")
    print(f"Next: python3 scripts/claude_oauth_manual.py finish '<code#state>' --state-file {state_path}")
    return 0


def command_finish(args: argparse.Namespace) -> int:
    code, state = parse_code_input(args.code)
    state_path = Path(args.state_file).expanduser() if args.state_file else latest_state_path()
    state_data = read_json(state_path)
    expected_state = state_data.get("state")
    if state != expected_state:
        raise SystemExit(f"State mismatch: got {state}, expected {expected_state}")
    token_response = exchange_code(state_data, code, state)
    access_token = token_response.get("access_token")
    if not access_token:
        raise SystemExit("Token exchange response did not include access_token")
    profile = fetch_profile(access_token, state_data.get("profile_url", PROFILE_URL))
    roles = fetch_roles(access_token, state_data.get("roles_url", ROLES_URL))
    write_local_credentials(token_response=token_response, profile=profile, roles=roles)
    if not args.keep_state_file:
        try:
            state_path.unlink()
        except FileNotFoundError:
            pass
    print(f"Wrote {credentials_path()}")
    print(f"Updated {config_path()}")
    account = profile.get("account") or {}
    organization = profile.get("organization") or {}
    print(f"Email: {account.get('email') or account.get('email_address') or 'unknown'}")
    print(f"Organization: {organization.get('name') or roles.get('organization_name') or 'unknown'}")
    print("Verify: env -u ANTHROPIC_API_KEY claude auth status --json")
    if args.verify:
        result = subprocess.run(
            ["bash", "-lc", "env -u ANTHROPIC_API_KEY claude auth status --json"],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.stdout:
            print("")
            print(result.stdout.strip())
        if result.returncode != 0 and result.stderr:
            print(result.stderr.strip(), file=sys.stderr)
            return result.returncode
    return 0


def command_status(_: argparse.Namespace) -> int:
    creds = read_json(credentials_path())
    oauth = (creds.get("claudeAiOauth") or {}) if isinstance(creds, dict) else {}
    config = read_json(config_path())
    account = config.get("oauthAccount") or {}
    expires_at = oauth.get("expiresAt")
    expired = bool(expires_at is not None and expires_at <= now_ms())
    summary = {
        "credentialsPath": str(credentials_path()),
        "configPath": str(config_path()),
        "hasAccessToken": bool(oauth.get("accessToken")),
        "hasRefreshToken": bool(oauth.get("refreshToken")),
        "expired": expired,
        "expiresAt": expires_at,
        "scopes": oauth.get("scopes") or [],
        "subscriptionType": oauth.get("subscriptionType"),
        "rateLimitTier": oauth.get("rateLimitTier"),
        "accountUuid": account.get("accountUuid"),
        "emailAddress": account.get("emailAddress"),
        "organizationUuid": account.get("organizationUuid"),
        "organizationName": account.get("organizationName"),
    }
    print(json.dumps(summary, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manual Claude Code OAuth helper for headless environments.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    start = subparsers.add_parser("start", help="Generate a manual PKCE login URL and save state.")
    start.add_argument("--state-file", help="Explicit path for the saved state JSON file.")
    start.add_argument("--authorize-source", choices=["claude-ai", "console"], default="claude-ai")
    start.add_argument("--scope-set", choices=sorted(SCOPE_SETS.keys()), default="cli")
    start.add_argument("--client-id", default=CLIENT_ID)
    start.add_argument("--authorize-url")
    start.add_argument("--token-url")
    start.add_argument("--profile-url")
    start.add_argument("--roles-url")
    start.add_argument("--redirect-uri", default=MANUAL_REDIRECT_URI)
    start.add_argument("--org-uuid")
    start.add_argument("--login-hint")
    start.add_argument("--login-method")
    start.add_argument("--expires-in", type=int)
    start.set_defaults(func=command_start)

    finish = subparsers.add_parser("finish", help="Exchange code#state and write local Claude credentials.")
    finish.add_argument("code", help="Either '<code>#<state>' or the full callback URL.")
    finish.add_argument("--state-file", help="Path to the saved state JSON file. Defaults to the newest one.")
    finish.add_argument("--keep-state-file", action="store_true")
    finish.add_argument("--verify", action="store_true", help="Run 'claude auth status --json' after writing files.")
    finish.set_defaults(func=command_finish)

    status = subparsers.add_parser("status", help="Show local credential and account metadata.")
    status.set_defaults(func=command_status)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
