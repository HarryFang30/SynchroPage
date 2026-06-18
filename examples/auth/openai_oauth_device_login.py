from __future__ import annotations

import asyncio
import sys
import webbrowser

from pdf_agent.auth import OpenAIOAuthError, OpenAIOAuthManager
from pdf_agent.gateway import build_chatgpt_codex_auth


async def main() -> int:
    manager = OpenAIOAuthManager()
    status = await manager.get_status()
    if status.authenticated:
        auth = await build_chatgpt_codex_auth(manager)
        print(f"already authenticated: {auth.account_id}")
        print(f"upstream: {auth.upstream_base_url}")
        return 0

    device = await manager.start_login()
    print(f"open: {device.verification_uri}")
    print(f"code: {device.user_code}")
    webbrowser.open(device.verification_uri)

    deadline = asyncio.get_running_loop().time() + device.expires_in
    while asyncio.get_running_loop().time() < deadline:
        account = await manager.poll_login(device.device_code)
        if account is not None:
            print(f"authenticated: {account.login} ({account.id})")
            return 0
        await asyncio.sleep(device.interval)

    print("device code expired", file=sys.stderr)
    return 1


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except OpenAIOAuthError as exc:
        print(f"{exc.code}: {exc}", file=sys.stderr)
        raise SystemExit(1)
