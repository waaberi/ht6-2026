from __future__ import annotations

import os
from typing import Annotated, Any

import httpx
from auth0_api_python.errors import BaseAuthError
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi_plugin.fast_api_client import Auth0FastAPI


def _environment_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise RuntimeError(f"{name} must be true or false")


AUTH_REQUIRED = _environment_flag("EXPOSURE_REQUIRE_AUTH")
AUTH_TIMEOUT_SECONDS = max(1.0, min(15.0, float(os.getenv("EXPOSURE_AUTH_TIMEOUT_SECONDS", "5"))))
AUTH0_DOMAIN = os.getenv("AUTH0_DOMAIN", "dev-40ogr4b5dnzkfkp3.us.auth0.com").strip().rstrip("/")
AUTH0_AUDIENCE = os.getenv("AUTH0_AUDIENCE", "https://api.exposure.app").strip()


async def _fetch_auth0_document(url: str) -> httpx.Response:
    async with httpx.AsyncClient(timeout=AUTH_TIMEOUT_SECONDS) as client:
        response = await client.get(url)
        response.raise_for_status()
        return response


def _build_auth0_client() -> Auth0FastAPI | None:
    if not AUTH0_DOMAIN or not AUTH0_AUDIENCE:
        return None
    return Auth0FastAPI(
        domain=AUTH0_DOMAIN,
        audience=AUTH0_AUDIENCE,
        custom_fetch=_fetch_auth0_document,
        dpop_enabled=False,
    )


AUTH0_CLIENT = _build_auth0_client()

bearer_scheme = HTTPBearer(
    auto_error=False,
    description="Auth0 access token. Required only when EXPOSURE_REQUIRE_AUTH=true.",
)


def auth_configured() -> bool:
    return bool(AUTH0_DOMAIN and AUTH0_AUDIENCE and AUTH0_CLIENT)


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="A valid Auth0 session is required.",
        headers={"WWW-Authenticate": "Bearer"},
    )


def _caused_by_network_error(error: BaseException) -> bool:
    current: BaseException | None = error
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, (httpx.TimeoutException, httpx.RequestError)):
            return True
        current = current.__cause__ or current.__context__
    return False


async def validate_auth0_access_token(access_token: str) -> dict[str, Any]:
    if not auth_configured() or AUTH0_CLIENT is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication is not configured.",
        )

    try:
        claims = await AUTH0_CLIENT.api_client.verify_access_token(
            access_token,
            required_claims=["sub"],
        )
    except BaseAuthError as error:
        if _caused_by_network_error(error):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Authentication service is unavailable.",
            ) from error
        raise _unauthorized() from error
    except (httpx.TimeoutException, httpx.RequestError) as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service is unavailable.",
        ) from error

    if not isinstance(claims, dict) or not isinstance(claims.get("sub"), str) or not claims["sub"]:
        raise _unauthorized()
    return claims


async def require_authenticated_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
) -> dict[str, Any] | None:
    if not AUTH_REQUIRED:
        return None
    if credentials is None or credentials.scheme.lower() != "bearer" or not credentials.credentials:
        raise _unauthorized()
    return await validate_auth0_access_token(credentials.credentials)


async def require_database_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
) -> dict[str, Any]:
    """Require Auth0 for owner-scoped data even when public analysis is enabled."""
    if credentials is None or credentials.scheme.lower() != "bearer" or not credentials.credentials:
        raise _unauthorized()
    return await validate_auth0_access_token(credentials.credentials)
