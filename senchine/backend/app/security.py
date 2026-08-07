"""Authentication, authorization and audit primitives.

JWT (HS256) and PBKDF2 password hashing are implemented on the standard library
so the prototype has no crypto dependency to install or pin. The token format is
standard-compliant, so swapping in `pyjwt` later is a drop-in change.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Any, Callable

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from . import db
from .config import settings

PBKDF2_ROUNDS = 120_000

# Role hierarchy — a role inherits every capability below it.
ROLE_RANK = {
    "viewer": 0,
    "technician": 1,
    "engineer": 2,
    "manager": 3,
    "admin": 4,
}

_bearer = HTTPBearer(auto_error=False)


# --------------------------------------------------------------------------
# Password hashing
# --------------------------------------------------------------------------


def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), PBKDF2_ROUNDS
    )
    return digest.hex(), salt


def verify_password(password: str, password_hash: str, salt: str) -> bool:
    candidate, _ = hash_password(password, salt)
    return hmac.compare_digest(candidate, password_hash)


# --------------------------------------------------------------------------
# JWT
# --------------------------------------------------------------------------


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def create_token(payload: dict[str, Any], ttl_minutes: int | None = None) -> str:
    ttl = ttl_minutes if ttl_minutes is not None else settings.token_ttl_minutes
    now = int(time.time())
    body = {**payload, "iat": now, "exp": now + ttl * 60, "iss": "senchine-ai"}
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    claims = _b64url(json.dumps(body, separators=(",", ":")).encode())
    signing_input = f"{header}.{claims}".encode()
    sig = hmac.new(settings.jwt_secret.encode(), signing_input, hashlib.sha256).digest()
    return f"{header}.{claims}.{_b64url(sig)}"


def decode_token(token: str) -> dict[str, Any]:
    """Return the token claims, or raise ValueError if invalid/expired."""
    try:
        header_b64, claims_b64, sig_b64 = token.split(".")
    except ValueError as exc:
        raise ValueError("malformed token") from exc

    signing_input = f"{header_b64}.{claims_b64}".encode()
    expected = hmac.new(
        settings.jwt_secret.encode(), signing_input, hashlib.sha256
    ).digest()
    if not hmac.compare_digest(expected, _b64url_decode(sig_b64)):
        raise ValueError("bad signature")

    claims = json.loads(_b64url_decode(claims_b64))
    if claims.get("exp", 0) < time.time():
        raise ValueError("token expired")
    return claims


# --------------------------------------------------------------------------
# FastAPI dependencies
# --------------------------------------------------------------------------


def _load_user(user_id: int) -> dict[str, Any]:
    row = db.query_one(
        "SELECT id, email, name, role, skills, phone, shift, plant_id, active "
        "FROM users WHERE id = ?",
        (user_id,),
    )
    if row is None or not row["active"]:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "user not found or inactive")
    user = dict(row)
    user["skills"] = json.loads(user["skills"] or "[]")
    return user


def current_user(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict[str, Any]:
    """Resolve the caller from a Bearer token (header) or `token` query param.

    The query-param path exists only for the WebSocket handshake, where browsers
    cannot set an Authorization header.
    """
    token = creds.credentials if creds else request.query_params.get("token")
    if not token:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "missing credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        claims = decode_token(token)
    except ValueError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from exc
    return _load_user(int(claims["sub"]))


def require_role(minimum: str) -> Callable[..., dict[str, Any]]:
    """Dependency factory enforcing a minimum role rank."""
    threshold = ROLE_RANK[minimum]

    def _guard(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
        if ROLE_RANK.get(user["role"], -1) < threshold:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"role '{user['role']}' cannot perform this action "
                f"(requires '{minimum}' or higher)",
            )
        return user

    return _guard


def user_from_token(token: str | None) -> dict[str, Any] | None:
    """Non-raising variant used by the WebSocket endpoint."""
    if not token:
        return None
    try:
        claims = decode_token(token)
        return _load_user(int(claims["sub"]))
    except (ValueError, HTTPException, KeyError):
        return None
