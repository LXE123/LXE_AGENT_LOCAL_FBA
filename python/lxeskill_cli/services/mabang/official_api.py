"""Read-only Mabang data-service transport; credentials never come from browser cookies."""
from __future__ import annotations

import asyncio
import json
import math
import os
import re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any

import aiohttp

from shared.infra.net import data_service_http_session
from .errors import MabangRequestError

REQUEST_TIMEOUT_SECONDS = 60
MAX_ATTEMPTS = 3
ROOT = "/api/v1/data-sources/mabang/"
_SENSITIVE = re.compile(r"(?i)authorization|cookie|password|passwd|secret|token|api.?key|app.?key|signature|^sign$")
_QUOTED_SECRET = re.compile(
    r'''(?i)((?:authorization|cookie|password|passwd|secret|token|api[_-]?key|app[_-]?key|signature)["']?\s*[:=]\s*)(["'])(.*?)(\2)'''
)


def diagnostic(value: Any) -> str:
    def clean(item: Any) -> Any:
        if isinstance(item, dict):
            return {str(k): "[REDACTED]" if _SENSITIVE.search(str(k)) else clean(v) for k, v in item.items()}
        if isinstance(item, list):
            return [clean(v) for v in item]
        return item

    result = value if isinstance(value, str) else json.dumps(clean(value), ensure_ascii=False, default=str)
    for name in ("LXE_DATA_SERVER_API_KEY", "LXE_DATA_SERVER_FALLBACK_API_KEY", "LXE_ERP_API_KEY"):
        secret = os.getenv(name, "").strip()
        if secret:
            result = result.replace(secret, "[REDACTED]")
    result = re.sub(r"(?i)\bBearer\s+[a-z0-9._~+/=-]+", "Bearer [REDACTED]", result)
    result = _QUOTED_SECRET.sub(r"\1[REDACTED]", result)
    result = re.sub(r'''(?i)((?:authorization|cookie|password|passwd|secret|token|api[_-]?key|signature)["']?\s*[:=]\s*)["']?[^\s,;}"']+''', r"\1[REDACTED]", result)
    if len(result) > 4000:
        result = result[:3800] + f"... [truncated {len(result) - 3800} chars]"
    return result


class OfficialApiError(MabangRequestError):
    def __init__(self, context: str, reason: str, payload: Any = None) -> None:
        super().__init__(diagnostic(f"{context}: {reason}") + (f"; response={diagnostic(payload)}" if payload is not None else ""))


def invalid(context: str, reason: str, payload: Any) -> None:
    raise OfficialApiError(context, reason, payload)


def retry_delay(value: str | None, fallback: float) -> float:
    if not value:
        return fallback
    try:
        seconds = float(value)
    except ValueError:
        try:
            date = parsedate_to_datetime(value)
            if date.tzinfo is None:
                date = date.replace(tzinfo=timezone.utc)
            seconds = (date - datetime.now(timezone.utc)).total_seconds()
        except (ValueError, TypeError, OverflowError):
            return fallback
    return max(0.0, seconds) if math.isfinite(seconds) and seconds >= 0 else fallback


def _business_failure(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return False
    if "code" in payload and str(payload["code"]) != "200":
        return True
    return any(_business_failure(payload.get(key)) for key in ("detail", "upstream", "body"))


async def post_json(endpoint: str, body: dict[str, Any], *, context: str) -> dict[str, Any]:
    base = os.getenv("LXE_DATA_SERVER_URL", "").strip().rstrip("/")
    key = os.getenv("LXE_DATA_SERVER_API_KEY", "").strip()
    if not base or not key:
        raise OfficialApiError(context, "LXE_DATA_SERVER_URL / LXE_DATA_SERVER_API_KEY 未配置")
    for attempt in range(MAX_ATTEMPTS):
        try:
            async with data_service_http_session.post(
                base + ROOT + endpoint,
                json=body,
                headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
                timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT_SECONDS),
                allow_redirects=False,
            ) as response:
                status = response.status
                raw = await response.text()
                retry_after = response.headers.get("Retry-After")
        except (aiohttp.ClientConnectionError, asyncio.TimeoutError) as exc:
            if attempt + 1 < MAX_ATTEMPTS:
                await asyncio.sleep(2 ** attempt)
                continue
            raise OfficialApiError(context, f"{type(exc).__name__}: {exc}") from exc
        except aiohttp.ClientError as exc:
            raise OfficialApiError(context, f"{type(exc).__name__}: {exc}") from exc
        try:
            payload = json.loads(raw)
        except ValueError:
            payload = raw
        retryable = status == 429 or (status in (502, 503, 504) and not _business_failure(payload))
        if retryable and attempt + 1 < MAX_ATTEMPTS:
            await asyncio.sleep(retry_delay(retry_after, 2 ** attempt) if status == 429 else 2 ** attempt)
            continue
        if not 200 <= status < 300:
            raise OfficialApiError(context, f"HTTP {status}", payload)
        if not isinstance(payload, dict) or str(payload.get("code")) != "200":
            raise OfficialApiError(context, f"HTTP {status}: 无效 JSON 或业务失败", payload)
        return payload
    raise AssertionError("unreachable")
