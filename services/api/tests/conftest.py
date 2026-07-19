from __future__ import annotations

import asyncio
import io
from typing import Any

import httpx
import pytest
from PIL import Image, ImageDraw

from exposure_api.main import app


class ApiTestClient:
    """Synchronous facade over HTTPX's ASGI transport.

    Starlette's threaded TestClient can deadlock on the Python 3.14 runtime used
    by the workspace. Driving the ASGI app on the calling thread also makes the
    timeout tests deterministic.
    """

    async def _request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            return await client.request(method, url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> httpx.Response:
        return asyncio.run(self._request("POST", url, **kwargs))

    def get(self, url: str, **kwargs: Any) -> httpx.Response:
        return asyncio.run(self._request("GET", url, **kwargs))

    def put(self, url: str, **kwargs: Any) -> httpx.Response:
        return asyncio.run(self._request("PUT", url, **kwargs))

    def delete(self, url: str, **kwargs: Any) -> httpx.Response:
        return asyncio.run(self._request("DELETE", url, **kwargs))


@pytest.fixture(autouse=True)
def run_worker_calls_inline(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep API tests deterministic where sandboxed Python worker threads are unavailable."""
    async def inline(function: object, *args: object, **kwargs: object) -> object:
        return function(*args, **kwargs)  # type: ignore[operator]

    monkeypatch.setattr(asyncio, "to_thread", inline)


@pytest.fixture
def client() -> ApiTestClient:
    return ApiTestClient()


@pytest.fixture
def image_bytes() -> bytes:
    image = Image.new("RGB", (120, 80), (55, 65, 75))
    draw = ImageDraw.Draw(image)
    draw.rectangle((44, 18, 95, 68), fill=(185, 115, 65))
    draw.line((0, 60, 119, 55), fill=(230, 230, 220), width=3)
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()
