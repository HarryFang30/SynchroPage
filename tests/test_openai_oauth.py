from __future__ import annotations

import asyncio
import base64
import json
import tempfile
import unittest
from pathlib import Path

from pdf_agent.auth.openai_oauth import HttpJsonResponse, OpenAIOAuthError, OpenAIOAuthManager
from pdf_agent.gateway import (
    build_chatgpt_codex_auth,
    build_codex_backend_headers,
    build_codex_responses_payload,
    parse_codex_models,
)

TEST_OAUTH_CONFIG = {"device_flow": {"client_id": "client-test"}}


class FakeHttpClient:
    def __init__(self) -> None:
        self.poll_ready = False
        self.form_calls: list[dict[str, str]] = []
        self.json_urls: list[str] = []
        self.form_urls: list[str] = []

    def post_json(self, url: str, payload: dict[str, object], headers: dict[str, str]) -> HttpJsonResponse:
        self.json_urls.append(url)
        if url.endswith("/usercode"):
            return HttpJsonResponse(
                200,
                {
                    "device_auth_id": "device-123",
                    "user_code": "ABCD-EFGH",
                    "expires_in": 900,
                    "interval": "5",
                },
                "",
            )
        if url.endswith("/token"):
            if not self.poll_ready:
                return HttpJsonResponse(403, {"error": "authorization_pending"}, "")
            return HttpJsonResponse(
                200,
                {
                    "authorization_code": "auth-code",
                    "code_verifier": "verifier",
                },
                "",
            )
        raise AssertionError(f"unexpected json url: {url}")

    def post_form(self, url: str, payload: dict[str, str], headers: dict[str, str]) -> HttpJsonResponse:
        self.form_urls.append(url)
        self.form_calls.append(payload)
        if payload["grant_type"] == "authorization_code":
            return HttpJsonResponse(
                200,
                {
                    "access_token": _jwt({"chatgpt_account_id": "acct_1", "email": "user@example.com"}),
                    "refresh_token": "refresh-1",
                    "id_token": _jwt({"chatgpt_account_id": "acct_1", "email": "user@example.com"}),
                    "expires_in": 3600,
                },
                "",
            )
        if payload["grant_type"] == "refresh_token":
            return HttpJsonResponse(
                200,
                {
                    "access_token": _jwt({"chatgpt_account_id": "acct_1", "email": "user@example.com"}),
                    "refresh_token": "refresh-2",
                    "expires_in": 3600,
                },
                "",
            )
        raise AssertionError(f"unexpected form payload: {payload}")


class FailingHttpClient:
    def post_json(self, url: str, payload: dict[str, object], headers: dict[str, str]) -> HttpJsonResponse:
        return HttpJsonResponse(
            500,
            {"error": "boom"},
            '{"access_token":"at-secret","refresh_token":"rt-secret","authorization_code":"code-secret"}',
        )

    def post_form(self, url: str, payload: dict[str, str], headers: dict[str, str]) -> HttpJsonResponse:
        return HttpJsonResponse(500, {"error": "boom"}, "Authorization: Bearer token-secret")


class OpenAIOAuthManagerTest(unittest.TestCase):
    def test_device_flow_persists_refresh_only_and_builds_headers(self) -> None:
        async def scenario() -> None:
            with tempfile.TemporaryDirectory() as tmp:
                fake = FakeHttpClient()
                manager = OpenAIOAuthManager(
                    config=TEST_OAUTH_CONFIG,
                    storage_path=Path(tmp) / "openai_oauth.json",
                    http_client=fake,
                )

                device = await manager.start_login()
                self.assertEqual(device.device_code, "device-123")
                self.assertEqual(device.user_code, "ABCD-EFGH")
                self.assertEqual(device.interval, 8)

                self.assertIsNone(await manager.poll_login(device.device_code))
                fake.poll_ready = True
                account = await manager.poll_login(device.device_code)
                self.assertIsNotNone(account)
                self.assertEqual(account.id, "acct_1")
                self.assertEqual(account.login, "user@example.com")

                status = await manager.get_status()
                self.assertTrue(status.authenticated)
                self.assertEqual(status.default_account_id, "acct_1")

                store_text = (Path(tmp) / "openai_oauth.json").read_text()
                self.assertIn("refresh-1", store_text)
                self.assertNotIn("access_token", store_text)

                auth = await build_chatgpt_codex_auth(manager)
                self.assertEqual(auth.account_id, "acct_1")
                self.assertEqual(auth.headers["ChatGPT-Account-Id"], "acct_1")
                self.assertTrue(auth.headers["Authorization"].startswith("Bearer "))
                self.assertEqual(auth.headers["originator"], "pdf-agent")

                reloaded = OpenAIOAuthManager(
                    config=TEST_OAUTH_CONFIG,
                    storage_path=Path(tmp) / "openai_oauth.json",
                    http_client=fake,
                )
                refreshed_auth = await build_chatgpt_codex_auth(reloaded)
                self.assertEqual(refreshed_auth.account_id, "acct_1")
                self.assertEqual(fake.form_calls[-1]["grant_type"], "refresh_token")
                self.assertIn("refresh-2", (Path(tmp) / "openai_oauth.json").read_text())

        asyncio.run(scenario())

    def test_config_mapping_controls_urls_and_storage_path(self) -> None:
        async def scenario() -> None:
            with tempfile.TemporaryDirectory() as tmp:
                storage_path = Path(tmp) / "configured" / "oauth.json"
                fake = FakeHttpClient()
                manager = OpenAIOAuthManager(
                    config={
                        "provider": {"id": "codex_oauth"},
                        "device_flow": {
                            "client_id": "client-custom",
                            "start_url": "https://auth.example.test/usercode",
                            "poll_url": "https://auth.example.test/token",
                            "token_url": "https://auth.example.test/oauth/token",
                            "verification_uri": "https://auth.example.test/device",
                            "redirect_uri": "https://auth.example.test/callback",
                            "polling_safety_margin_seconds": 1,
                        },
                        "storage": {"path": str(storage_path)},
                    },
                    http_client=fake,
                )

                device = await manager.start_login()
                self.assertEqual(device.verification_uri, "https://auth.example.test/device")
                self.assertEqual(device.interval, 6)
                self.assertEqual(fake.json_urls[-1], "https://auth.example.test/usercode")

                fake.poll_ready = True
                await manager.poll_login(device.device_code)
                self.assertEqual(fake.json_urls[-1], "https://auth.example.test/token")
                self.assertEqual(fake.form_urls[-1], "https://auth.example.test/oauth/token")
                self.assertEqual(fake.form_calls[-1]["client_id"], "client-custom")
                self.assertEqual(fake.form_calls[-1]["redirect_uri"], "https://auth.example.test/callback")
                self.assertTrue(storage_path.exists())

        asyncio.run(scenario())

    def test_oauth_error_details_are_redacted(self) -> None:
        async def scenario() -> None:
            manager = OpenAIOAuthManager(
                config=TEST_OAUTH_CONFIG,
                storage_path=Path(tempfile.gettempdir()) / "unused-oauth.json",
                http_client=FailingHttpClient(),
            )
            with self.assertRaises(OpenAIOAuthError) as raised:
                await manager.start_login()

            message = str(raised.exception)
            self.assertIn("<redacted>", message)
            self.assertNotIn("at-secret", message)
            self.assertNotIn("rt-secret", message)
            self.assertNotIn("code-secret", message)

        asyncio.run(scenario())

    def test_missing_oauth_client_id_fails_before_network_call(self) -> None:
        async def scenario() -> None:
            fake = FakeHttpClient()
            manager = OpenAIOAuthManager(
                config={"device_flow": {"client_id": "${PDF_AGENT_OPENAI_OAUTH_CLIENT_ID}"}},
                storage_path=Path(tempfile.gettempdir()) / "unused-oauth.json",
                http_client=fake,
            )
            with self.assertRaises(OpenAIOAuthError) as raised:
                await manager.start_login()

            self.assertEqual(raised.exception.code, "oauth_client_id_missing")
            self.assertEqual(fake.json_urls, [])

        asyncio.run(scenario())

    def test_codex_gateway_headers_payload_and_model_parsing(self) -> None:
        headers = build_codex_backend_headers(
            access_token="access-token",
            account_id="acct_1",
            originator="pdf-agent-test",
            session_id="session-123",
        )
        self.assertEqual(headers["Authorization"], "Bearer access-token")
        self.assertEqual(headers["ChatGPT-Account-Id"], "acct_1")
        self.assertEqual(headers["originator"], "pdf-agent-test")
        self.assertEqual(headers["session_id"], "session-123")
        self.assertEqual(headers["x-client-request-id"], "session-123")
        self.assertEqual(headers["x-codex-window-id"], "session-123:0")

        with self.assertRaises(ValueError):
            build_codex_backend_headers(access_token="PROXY_MANAGED", account_id="acct_1")

        payload = build_codex_responses_payload(
            {
                "model": "gpt-5.5",
                "input": "hello",
                "include": ["file_search_call.results"],
                "temperature": 0.2,
                "top_p": 0.9,
                "max_output_tokens": 100,
                "store": True,
                "stream": False,
            },
            service_tier="priority",
        )
        self.assertFalse(payload["store"])
        self.assertTrue(payload["stream"])
        self.assertEqual(payload["service_tier"], "priority")
        self.assertIn("file_search_call.results", payload["include"])
        self.assertIn("reasoning.encrypted_content", payload["include"])
        self.assertNotIn("temperature", payload)
        self.assertNotIn("top_p", payload)
        self.assertNotIn("max_output_tokens", payload)

        generation_payload = build_codex_responses_payload(
            {"model": "gpt-5.4-mini", "input": "generate json"},
            include_reasoning_encrypted_content=False,
        )
        self.assertNotIn("include", generation_payload)

        models = parse_codex_models(
            {
                "data": [{"id": "gpt-5.5", "owned_by": "openai"}],
                "models": [{"slug": "gpt-5.4-mini"}, "gpt-5.5"],
            }
        )
        self.assertEqual([model.id for model in models], ["gpt-5.4-mini", "gpt-5.5"])
        self.assertEqual(models[1].owned_by, "openai")


def _jwt(claims: dict[str, object]) -> str:
    header = _b64({"alg": "none", "typ": "JWT"})
    payload = _b64(claims)
    return f"{header}.{payload}.signature"


def _b64(value: dict[str, object]) -> str:
    raw = json.dumps(value, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


if __name__ == "__main__":
    unittest.main()
