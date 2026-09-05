from __future__ import annotations

from .aiohttp_client import (
    HttpSessionPurpose,
    close_all_aiohttp_sessions,
    erp_http_session,
    data_service_http_session,
    external_http_session,
)
from .policy import (
    bootstrap_network_policy,
    build_child_env,
    log_network_snapshot,
    network_snapshot,
)
from .requests_client import (
    RequestsPurpose,
    close_all_requests_sessions,
    external_requests_session,
    local_service_requests_session,
)


async def close_all_network_clients() -> None:
    await close_all_aiohttp_sessions()
    close_all_requests_sessions()


__all__ = [
    "HttpSessionPurpose",
    "RequestsPurpose",
    "bootstrap_network_policy",
    "build_child_env",
    "close_all_aiohttp_sessions",
    "close_all_network_clients",
    "close_all_requests_sessions",
    "erp_http_session",
    "data_service_http_session",
    "external_http_session",
    "external_requests_session",
    "local_service_requests_session",
    "log_network_snapshot",
    "network_snapshot",
]
