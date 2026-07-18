from __future__ import annotations

import os
from typing import Annotated, Any

import httpx
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer


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
SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_PUBLIC_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY") or os.getenv("SUPABASE_ANON_KEY", "")

bearer_scheme = HTTPBearer(
    auto_error=False,
    description="Supabase access token. Required only when EXPOSURE_REQUIRE_AUTH=true.",
)


def auth_configured() -> bool:
    return bool(SUPABASE_URL and SUPABASE_PUBLIC_KEY)


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="A valid Supabase session is required.",
        headers={"WWW-Authenticate": "Bearer"},
    )


async def validate_supabase_access_token(access_token: str) -> dict[str, Any]:
    if not auth_configured():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication is not configured.",
        )

    try:
        async with httpx.AsyncClient(timeout=AUTH_TIMEOUT_SECONDS) as client:
            response = await client.get(
                f"{SUPABASE_URL}/auth/v1/user",
                headers={
                    "apikey": SUPABASE_PUBLIC_KEY,
                    "Authorization": f"Bearer {access_token}",
                },
            )
    except (httpx.TimeoutException, httpx.RequestError) as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service is unavailable.",
        ) from error

    if response.status_code in {status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN}:
        raise _unauthorized()
    if not response.is_success:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service is unavailable.",
        )
    try:
        user = response.json()
    except ValueError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service returned an invalid response.",
        ) from error
    if not isinstance(user, dict) or not isinstance(user.get("id"), str) or not user["id"]:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service returned an invalid response.",
        )
    return user


async def require_authenticated_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
) -> dict[str, Any] | None:
    if not AUTH_REQUIRED:
        return None
    if credentials is None or credentials.scheme.lower() != "bearer" or not credentials.credentials:
        raise _unauthorized()
    return await validate_supabase_access_token(credentials.credentials)
