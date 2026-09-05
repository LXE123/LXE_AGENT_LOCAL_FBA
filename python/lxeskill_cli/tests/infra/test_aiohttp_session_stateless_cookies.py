from __future__ import annotations

import asyncio

import aiohttp
from aiohttp import web

from shared.infra.net.aiohttp_client import (
    HttpSessionPurpose,
    HttpSessionRegistry,
    close_all_aiohttp_sessions,
)


def test_shared_aiohttp_sessions_use_dummy_cookie_jar() -> None:
    async def run() -> None:
        try:
            erp_session = HttpSessionRegistry.get(HttpSessionPurpose.ERP)
            external_session = HttpSessionRegistry.get(HttpSessionPurpose.EXTERNAL)
            data_session = HttpSessionRegistry.get(HttpSessionPurpose.DATA_SERVICE)
            assert isinstance(data_session.cookie_jar, aiohttp.DummyCookieJar)
            assert data_session.trust_env is False

            assert isinstance(erp_session.cookie_jar, aiohttp.DummyCookieJar)
            assert isinstance(external_session.cookie_jar, aiohttp.DummyCookieJar)
        finally:
            await close_all_aiohttp_sessions()

    asyncio.run(run())


def test_shared_aiohttp_session_does_not_override_manual_cookie_header() -> None:
    received_cookie_headers: list[str] = []

    async def poison(request: web.Request) -> web.Response:
        return web.Response(text="poisoned", headers={"Set-Cookie": "PHPSESSID=STALE; Path=/"})

    async def echo(request: web.Request) -> web.Response:
        received_cookie_headers.append(str(request.headers.get("Cookie") or ""))
        return web.Response(text="ok")

    async def run() -> None:
        app = web.Application()
        app.router.add_get("/poison", poison)
        app.router.add_get("/echo", echo)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "localhost", 0)
        await site.start()
        sockets = list(getattr(site._server, "sockets", []) or [])
        assert sockets, "aiohttp test server did not expose sockets"
        port = int(sockets[0].getsockname()[1])

        try:
            session = HttpSessionRegistry.get(HttpSessionPurpose.ERP)
            base_url = f"http://localhost:{port}"
            async with session.get(f"{base_url}/poison") as resp:
                await resp.text()
            async with session.get(
                f"{base_url}/echo",
                headers={"Cookie": "PHPSESSID=FRESH; other=x"},
            ) as resp:
                await resp.text()
        finally:
            await close_all_aiohttp_sessions()
            await runner.cleanup()

    asyncio.run(run())

    assert received_cookie_headers == ["PHPSESSID=FRESH; other=x"]
