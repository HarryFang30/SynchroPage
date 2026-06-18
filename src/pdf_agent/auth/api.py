from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .openai_oauth import OpenAIOAuthManager


@dataclass(frozen=True)
class OpenAIOAuthApi:
    manager: OpenAIOAuthManager

    async def start_login(self) -> dict[str, Any]:
        return (await self.manager.start_login()).to_public_dict()

    async def poll_login(self, device_code: str) -> dict[str, Any] | None:
        account = await self.manager.poll_login(device_code)
        return account.to_public_dict() if account is not None else None

    async def status(self) -> dict[str, Any]:
        return (await self.manager.get_status()).to_public_dict()

    async def remove_account(self, account_id: str) -> dict[str, Any]:
        await self.manager.remove_account(account_id)
        return await self.status()

    async def set_default_account(self, account_id: str) -> dict[str, Any]:
        await self.manager.set_default_account(account_id)
        return await self.status()

    async def logout(self) -> dict[str, Any]:
        await self.manager.logout()
        return await self.status()
