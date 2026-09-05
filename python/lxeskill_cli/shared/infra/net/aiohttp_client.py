from __future__ import annotations

import threading
from dataclasses import dataclass
from enum import Enum
from typing import Dict, Mapping

import aiohttp


class HttpSessionPurpose(str, Enum):
    ERP = "erp"
    EXTERNAL = "external"
    DATA_SERVICE = "data_service"


@dataclass(frozen=True)
class HttpSessionOptions:
    connector_limit: int
    connector_limit_per_host: int
    total_timeout_s: int
    keepalive_timeout_s: int
    ttl_dns_cache_s: int = 300
    headers: Mapping[str, str] | None = None


_SESSION_OPTIONS: Dict[HttpSessionPurpose, HttpSessionOptions] = {
    HttpSessionPurpose.DATA_SERVICE: HttpSessionOptions(
        connector_limit=8, connector_limit_per_host=4, total_timeout_s=60,
        keepalive_timeout_s=30, headers={"User-Agent": "RobotCoze-DataService/1.0"},
    ),
    HttpSessionPurpose.ERP: HttpSessionOptions(
        connector_limit=64,
        connector_limit_per_host=32,
        total_timeout_s=60,
        keepalive_timeout_s=30,
        headers={"User-Agent": "RobotCoze-ERP/1.0"},
    ),
    HttpSessionPurpose.EXTERNAL: HttpSessionOptions(
        connector_limit=16,
        connector_limit_per_host=8,
        total_timeout_s=30,
        keepalive_timeout_s=20,
        headers={"User-Agent": "RobotCoze-External/1.0"},
    ),
}


def _normalize_purpose(value: HttpSessionPurpose | str) -> HttpSessionPurpose:
    if isinstance(value, HttpSessionPurpose):
        return value
    return HttpSessionPurpose(str(value).strip().lower())


def _build_session(options: HttpSessionOptions) -> aiohttp.ClientSession:
    connector = aiohttp.TCPConnector(
        limit=options.connector_limit,
        limit_per_host=options.connector_limit_per_host,
        ttl_dns_cache=options.ttl_dns_cache_s,
        keepalive_timeout=options.keepalive_timeout_s,
        enable_cleanup_closed=True,
    )
    timeout = aiohttp.ClientTimeout(total=options.total_timeout_s)
    return aiohttp.ClientSession(
        connector=connector,
        timeout=timeout,
        headers=dict(options.headers or {}),
        # Shared sessions are connection pools only. Auth material must come
        # from browser_auth_service; default CookieJar can shadow manual cookies.
        cookie_jar=aiohttp.DummyCookieJar(),
        trust_env=False,
    )


class HttpSessionRegistry:
    _sessions: Dict[HttpSessionPurpose, aiohttp.ClientSession] = {}
    _lock = threading.Lock()

    @classmethod
    def get(cls, purpose: HttpSessionPurpose | str) -> aiohttp.ClientSession:
        normalized = _normalize_purpose(purpose)
        with cls._lock:
            session = cls._sessions.get(normalized)
            if session is None or session.closed:
                session = _build_session(_SESSION_OPTIONS[normalized])
                cls._sessions[normalized] = session
            return session

    @classmethod
    async def close_all(cls) -> None:
        with cls._lock:
            sessions = list(cls._sessions.values())
            cls._sessions.clear()
        for session in sessions:
            if session and not session.closed:
                await session.close()


class HttpSessionProxy:
    def __init__(self, purpose: HttpSessionPurpose) -> None:
        self._purpose = purpose

    def __getattr__(self, name: str):
        return getattr(HttpSessionRegistry.get(self._purpose), name)


data_service_http_session = HttpSessionProxy(HttpSessionPurpose.DATA_SERVICE)
erp_http_session = HttpSessionProxy(HttpSessionPurpose.ERP)
external_http_session = HttpSessionProxy(HttpSessionPurpose.EXTERNAL)


async def close_all_aiohttp_sessions() -> None:
    await HttpSessionRegistry.close_all()


__all__ = [
    "HttpSessionOptions",
    "HttpSessionPurpose",
    "HttpSessionRegistry",
    "close_all_aiohttp_sessions",
    "erp_http_session",
    "data_service_http_session",
    "external_http_session",
]
