from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest
from auth0_api_python.errors import VerifyAccessTokenError
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


def test_required_auth_accepts_a_validated_bearer_token(
    client,
    image_bytes: bytes,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[str] = []

    async def validate(access_token: str) -> dict[str, str]:
        seen.append(access_token)
        return {"sub": "auth0|user-fixture"}

    monkeypatch.setattr(auth, "AUTH_REQUIRED", True)
    monkeypatch.setattr(auth, "validate_auth0_access_token", validate)

    response = client.post(
        "/v1/analyze",
        headers={"Authorization": "Bearer session-fixture"},
        **_analysis_request(image_bytes),
    )

    assert response.status_code == 200, response.text
    assert seen == ["session-fixture"]


def test_validation_uses_auth0_sdk_with_required_subject_claim(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    class FakeApiClient:
        async def verify_access_token(self, token: str, *, required_claims: list[str]) -> dict[str, str]:
            captured.update({"token": token, "required_claims": required_claims})
            return {"sub": "google-oauth2|user-fixture"}

    class FakeAuth0Client:
        api_client = FakeApiClient()

    monkeypatch.setattr(auth, "AUTH0_CLIENT", FakeAuth0Client())

    user = asyncio.run(auth.validate_auth0_access_token("access-fixture"))

    assert user["sub"] == "google-oauth2|user-fixture"
    assert captured == {"token": "access-fixture", "required_claims": ["sub"]}


def test_validation_normalizes_rejected_tokens(monkeypatch: pytest.MonkeyPatch) -> None:
    class RejectingApiClient:
        async def verify_access_token(self, *_args: object, **_kwargs: object) -> dict[str, str]:
            raise VerifyAccessTokenError("invalid fixture")

    class RejectingAuth0Client:
        api_client = RejectingApiClient()

    monkeypatch.setattr(auth, "AUTH0_CLIENT", RejectingAuth0Client())

    with pytest.raises(HTTPException) as caught:
        asyncio.run(auth.validate_auth0_access_token("rejected-fixture"))

    assert caught.value.status_code == 401
    assert caught.value.headers == {"WWW-Authenticate": "Bearer"}


def test_required_auth_fails_closed_when_auth0_is_not_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(auth, "AUTH0_CLIENT", None)

    with pytest.raises(HTTPException) as caught:
        asyncio.run(auth.validate_auth0_access_token("access-fixture"))

    assert caught.value.status_code == 503


def test_auth0_timeout_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    class TimingOutApiClient:
        async def verify_access_token(self, *_args: object, **_kwargs: object) -> dict[str, str]:
            raise httpx.ReadTimeout("fixture timeout")

    class TimingOutAuth0Client:
        api_client = TimingOutApiClient()

    monkeypatch.setattr(auth, "AUTH0_CLIENT", TimingOutAuth0Client())

    with pytest.raises(HTTPException) as caught:
        asyncio.run(auth.validate_auth0_access_token("access-fixture"))

    assert caught.value.status_code == 503
