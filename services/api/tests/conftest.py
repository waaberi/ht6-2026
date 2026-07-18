from __future__ import annotations

import asyncio
import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from exposure_api.main import app


@pytest.fixture(autouse=True)
def run_worker_calls_inline(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep API tests deterministic where sandboxed Python worker threads are unavailable."""
    async def inline(function: object, *args: object, **kwargs: object) -> object:
        return function(*args, **kwargs)  # type: ignore[operator]

    monkeypatch.setattr(asyncio, "to_thread", inline)


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def image_bytes() -> bytes:
    image = Image.new("RGB", (120, 80), (55, 65, 75))
    draw = ImageDraw.Draw(image)
    draw.rectangle((44, 18, 95, 68), fill=(185, 115, 65))
    draw.line((0, 60, 119, 55), fill=(230, 230, 220), width=3)
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()
