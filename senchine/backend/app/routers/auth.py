"""Authentication endpoints."""

from __future__ import annotations

import json
import time

from fastapi import APIRouter, Depends, HTTPException, Request, status

from .. import db
from ..schemas import LoginRequest, RegisterRequest
from ..security import create_token, current_user, hash_password, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Simple in-process attempt limiter. Enough to stop credential stuffing against a
# demo instance; a production deployment would move this to shared storage.
_ATTEMPTS: dict[str, list[float]] = {}
MAX_ATTEMPTS = 8
WINDOW_SECONDS = 300


def _rate_limited(key: str) -> bool:
    now = time.time()
    attempts = [t for t in _ATTEMPTS.get(key, []) if now - t < WINDOW_SECONDS]
    _ATTEMPTS[key] = attempts
    return len(attempts) >= MAX_ATTEMPTS


def _record_attempt(key: str) -> None:
    _ATTEMPTS.setdefault(key, []).append(time.time())


@router.post("/login")
def login(payload: LoginRequest, request: Request) -> dict:
    ip = request.client.host if request.client else "unknown"
    key = f"{ip}:{payload.email.lower()}"

    if _rate_limited(key):
        db.audit("auth.rate_limited", f"user:{payload.email}", detail="too many attempts", ip=ip)
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many failed attempts. Try again in a few minutes.",
        )

    row = db.query_one(
        "SELECT id, email, name, password_hash, salt, role, skills, active "
        "FROM users WHERE LOWER(email) = LOWER(?)",
        (payload.email,),
    )

    # Constant-ish response regardless of whether the account exists, so the
    # endpoint cannot be used to enumerate valid emails.
    if row is None or not verify_password(payload.password, row["password_hash"], row["salt"]):
        _record_attempt(key)
        db.audit("auth.login_failed", f"user:{payload.email}", detail="bad credentials", ip=ip)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")

    if not row["active"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Account is disabled")

    _ATTEMPTS.pop(key, None)
    token = create_token({"sub": str(row["id"]), "role": row["role"]})
    db.audit("auth.login", f"user:{row['id']}", user_id=row["id"], actor=row["email"], ip=ip)

    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {
            "id": row["id"],
            "email": row["email"],
            "name": row["name"],
            "role": row["role"],
            "skills": json.loads(row["skills"] or "[]"),
        },
    }


@router.post("/register", status_code=status.HTTP_201_CREATED)
def register(payload: RegisterRequest, request: Request) -> dict:
    """Self-service registration, capped at non-privileged roles."""
    existing = db.query_one(
        "SELECT id FROM users WHERE LOWER(email) = LOWER(?)", (payload.email,)
    )
    if existing:
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with that email exists")

    password_hash, salt = hash_password(payload.password)
    user_id = db.execute(
        "INSERT INTO users(email, name, password_hash, salt, role, skills, phone, "
        "shift, plant_id, active, created_at) VALUES(?,?,?,?,?,?,?,?,NULL,1,?)",
        (
            payload.email.lower(), payload.name, password_hash, salt, payload.role,
            json.dumps(payload.skills), payload.phone, payload.shift, time.time(),
        ),
    )
    db.audit(
        "auth.register", f"user:{user_id}", user_id=user_id, actor=payload.email,
        detail=f"role={payload.role}",
        ip=request.client.host if request.client else None,
    )
    token = create_token({"sub": str(user_id), "role": payload.role})
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {
            "id": user_id, "email": payload.email.lower(), "name": payload.name,
            "role": payload.role, "skills": payload.skills,
        },
    }


@router.get("/me")
def me(user: dict = Depends(current_user)) -> dict:
    return {"user": user}


@router.get("/demo-accounts")
def demo_accounts() -> dict:
    """Demo credentials, exposed so a reviewer can sign in without setup."""
    rows = db.query(
        "SELECT email, name, role FROM users WHERE active = 1 ORDER BY "
        "CASE role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 WHEN 'engineer' THEN 2 "
        "WHEN 'technician' THEN 3 ELSE 4 END"
    )
    return {
        "password": "senchine",
        "accounts": db.rows_to_dicts(rows),
        "note": "Demo instance. Every account shares the same password.",
    }
