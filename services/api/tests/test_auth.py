from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest
from fastapi import HTTPException

from exposure_api import auth
from exposure_api.auth import require_authenticated_user
from exposure_api.main import app


def _analysis_request(image_bytes: bytes) -> dict[str, Any]:
    return {
        "files": {"image": ("photo.png", image_bytes, "image/png")},
        "data": {"version_id": "auth-fixture"},
    }


def test_every_v1_route_uses_auth_dependency_and_health_stays_public() -> None:
    routes = {route.path: route for route in app.routes if hasattr(route, "dependant")}
    protected = [route for path, route in routes.items() if path.startswith("/v1")]

    assert protected
    assert all(
        any(dependency.call is require_authenticated_user for dependency in route.dependant.dependencies)
        for route in protected
    )
    assert all(
        dependency.call is not require_authenticated_user
        for dependency in routes["/health"].dependant.dependencies
    )


def test_auth_gate_is_disabled_by_default_for_local_requests(
    client,
    image_bytes: bytes,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(auth, "AUTH_REQUIRED", False)

    response = client.post("/v1/analyze", **_analysis_request(image_bytes))

    assert response.status_code == 200, response.text


def test_required_auth_rejects_missing_bearer_token(
    client,
    image_bytes: bytes,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(auth, "AUTH_REQUIRED", True)

    response = client.post("/v1/analyze", **_analysis_request(image_bytes))

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


def test_required_auth_accepts_a_remotely_validated_bearer_token(
    client,
    image_bytes: bytes,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[str] = []

    async def validate(access_token: str) -> dict[str, str]:
        seen.append(access_token)
        return {"id": "user-fixture"}

    monkeypatch.setattr(auth, "AUTH_REQUIRED", True)
    monkeypatch.setattr(auth, "validate_supabase_access_token", validate)

    response = client.post(
        "/v1/analyze",
        headers={"Authorization": "Bearer session-fixture"},
        **_analysis_request(image_bytes),
    )

    assert response.status_code == 200, response.text
    assert seen == ["session-fixture"]


def test_remote_validation_uses_supabase_user_endpoint_and_public_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    class FakeClient:
        def __init__(self, *, timeout: float) -> None:
            captured["timeout"] = timeout

        async def __aenter__(self) -> "FakeClient":
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

        async def get(self, url: str, *, headers: dict[str, str]) -> httpx.Response:
            captured.update({"url": url, "headers": headers})
            return httpx.Response(200, json={"id": "user-fixture", "email": "person@example.test"})

    monkeypatch.setattr(auth, "SUPABASE_URL", "https://project.supabase.test")
    monkeypatch.setattr(auth, "SUPABASE_PUBLIC_KEY", "publishable-fixture")
    monkeypatch.setattr(auth.httpx, "AsyncClient", FakeClient)

    user = asyncio.run(auth.validate_supabase_access_token("access-fixture"))

    assert user["id"] == "user-fixture"
    assert captured["url"] == "https://project.supabase.test/auth/v1/user"
    assert captured["headers"] == {
        "apikey": "publishable-fixture",
        "Authorization": "Bearer access-fixture",
    }
    assert captured["timeout"] == auth.AUTH_TIMEOUT_SECONDS


@pytest.mark.parametrize("status_code", [401, 403])
def test_remote_validation_normalizes_rejected_tokens(
    status_code: int,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class RejectingClient:
        def __init__(self, **_kwargs: object) -> None:
            pass

        async def __aenter__(self) -> "RejectingClient":
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

        async def get(self, *_args: object, **_kwargs: object) -> httpx.Response:
            return httpx.Response(status_code)

    monkeypatch.setattr(auth, "SUPABASE_URL", "https://project.supabase.test")
    monkeypatch.setattr(auth, "SUPABASE_PUBLIC_KEY", "publishable-fixture")
    monkeypatch.setattr(auth.httpx, "AsyncClient", RejectingClient)

    with pytest.raises(HTTPException) as caught:
        asyncio.run(auth.validate_supabase_access_token("rejected-fixture"))

    assert caught.value.status_code == 401
    assert caught.value.headers == {"WWW-Authenticate": "Bearer"}


def test_required_auth_fails_closed_when_supabase_is_not_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(auth, "SUPABASE_URL", "")
    monkeypatch.setattr(auth, "SUPABASE_PUBLIC_KEY", "")

    with pytest.raises(HTTPException) as caught:
        asyncio.run(auth.validate_supabase_access_token("access-fixture"))

    assert caught.value.status_code == 503


def test_remote_auth_timeout_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    class TimingOutClient:
        def __init__(self, **_kwargs: object) -> None:
            pass

        async def __aenter__(self) -> "TimingOutClient":
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

        async def get(self, *_args: object, **_kwargs: object) -> httpx.Response:
            raise httpx.ReadTimeout("fixture timeout")

    monkeypatch.setattr(auth, "SUPABASE_URL", "https://project.supabase.test")
    monkeypatch.setattr(auth, "SUPABASE_PUBLIC_KEY", "publishable-fixture")
    monkeypatch.setattr(auth.httpx, "AsyncClient", TimingOutClient)

    with pytest.raises(HTTPException) as caught:
        asyncio.run(auth.validate_supabase_access_token("access-fixture"))

    assert caught.value.status_code == 503
