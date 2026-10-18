"""Minimal IBM watsonx.ai chat client.

Endpoint: POST {WATSONX_URL}/ml/v1/text/chat?version=...
Auth: IBM Cloud IAM bearer token exchanged from WATSONX_API_KEY. The key and
token never leave this process and are never included in errors or logs.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

import httpx

DEFAULT_IAM_URL = "https://iam.cloud.ibm.com/identity/token"
API_VERSION = "2024-05-31"


class ProviderError(Exception):
    """Base class. `code` is a stable, user-safe identifier."""

    code = "provider_error"


class ProviderNotConfigured(ProviderError):
    code = "not_configured"


class ProviderTimeout(ProviderError):
    code = "timeout"


class ProviderRateLimited(ProviderError):
    code = "rate_limited"


class ProviderAuthError(ProviderError):
    code = "auth_failed"


class ProviderBadResponse(ProviderError):
    code = "bad_response"


@dataclass(frozen=True)
class WatsonxConfig:
    api_key: str
    project_id: str
    url: str
    model_id: str
    timeout_s: float = 30.0
    iam_url: str = DEFAULT_IAM_URL

    def missing(self) -> list[str]:
        """Names (never values) of required settings that are absent or invalid."""
        out = [name for name, v in (("WATSONX_API_KEY", self.api_key), ("WATSONX_PROJECT_ID", self.project_id),
                                    ("WATSONX_URL", self.url), ("WATSONX_MODEL_ID", self.model_id)) if not v]
        if self.url and not self.url.startswith(("https://", "http://")):
            out.append("WATSONX_URL (must start with https://)")
        return out

    @property
    def configured(self) -> bool:
        return not self.missing()


class WatsonxClient:
    def __init__(self, config: WatsonxConfig, http: httpx.AsyncClient | None = None):
        self.config = config
        self._http = http or httpx.AsyncClient(timeout=config.timeout_s)
        self._token: str | None = None
        self._token_expiry = 0.0
        self._lock = asyncio.Lock()

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _get_token(self) -> str:
        async with self._lock:
            if self._token and time.monotonic() < self._token_expiry - 60:
                return self._token
            try:
                resp = await self._http.post(
                    self.config.iam_url,
                    data={
                        "grant_type": "urn:ibm:params:oauth:grant-type:apikey",
                        "apikey": self.config.api_key,
                    },
                    headers={"Accept": "application/json"},
                )
            except httpx.TimeoutException as exc:
                raise ProviderTimeout() from exc
            except httpx.HTTPError as exc:
                raise ProviderError() from exc
            if resp.status_code in (400, 401, 403):
                raise ProviderAuthError()
            if resp.status_code != 200:
                raise ProviderError()
            body = resp.json()
            token = body.get("access_token")
            if not isinstance(token, str):
                raise ProviderAuthError()
            self._token = token
            self._token_expiry = time.monotonic() + float(body.get("expires_in", 3600))
            return token

    async def chat(self, messages: list[dict], tools: list[dict]) -> dict:
        """Return the assistant message dict from choices[0].message."""
        if not self.config.configured:
            raise ProviderNotConfigured()
        token = await self._get_token()
        payload = {
            "model_id": self.config.model_id,
            "project_id": self.config.project_id,
            "messages": messages,
            "tools": tools,
            "tool_choice_option": "auto",
            "max_tokens": 800,
            "temperature": 0.1,
            "time_limit": int(self.config.timeout_s * 1000),
        }
        try:
            resp = await self._http.post(
                f"{self.config.url.rstrip('/')}/ml/v1/text/chat",
                params={"version": API_VERSION},
                json=payload,
                headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            )
        except httpx.TimeoutException as exc:
            raise ProviderTimeout() from exc
        except httpx.HTTPError as exc:
            raise ProviderError() from exc

        if resp.status_code == 429:
            raise ProviderRateLimited()
        if resp.status_code in (401, 403):
            self._token = None
            raise ProviderAuthError()
        if resp.status_code >= 400:
            raise ProviderError()
        try:
            message = resp.json()["choices"][0]["message"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise ProviderBadResponse() from exc
        if not isinstance(message, dict):
            raise ProviderBadResponse()
        return message
