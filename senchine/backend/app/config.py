"""Central configuration.

Every setting is environment-overridable and has a default that lets the
platform boot with no configuration at all — a hard requirement for demo
reproducibility.
"""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[2]


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    # --- storage ---
    db_path: str = field(
        default_factory=lambda: os.environ.get("SENCHINE_DB")
        or str(BASE_DIR / "senchine.db")
    )
    model_dir: str = field(
        default_factory=lambda: os.environ.get("SENCHINE_MODEL_DIR")
        or str(BASE_DIR / "models")
    )

    # --- server ---
    host: str = field(default_factory=lambda: os.environ.get("SENCHINE_HOST", "0.0.0.0"))
    port: int = field(default_factory=lambda: _env_int("SENCHINE_PORT", 8000))

    # --- auth ---
    # A per-boot random secret is safe for a prototype and forces re-login after
    # a restart; set SENCHINE_JWT_SECRET to keep sessions across restarts.
    jwt_secret: str = field(
        default_factory=lambda: os.environ.get("SENCHINE_JWT_SECRET")
        or secrets.token_hex(32)
    )
    token_ttl_minutes: int = field(
        default_factory=lambda: _env_int("SENCHINE_TOKEN_TTL_MIN", 720)
    )

    # --- simulation ---
    tick_seconds: float = field(
        default_factory=lambda: _env_float("SENCHINE_TICK_SECONDS", 2.0)
    )
    # Run the Prediction/Maintenance agents every N monitoring ticks. Monitoring
    # is cheap and must be real-time; prediction is heavier and does not need to
    # run at sensor frequency.
    pipeline_every: int = field(
        default_factory=lambda: _env_int("SENCHINE_PIPELINE_EVERY", 3)
    )
    # Readings retained per sensor in the hot ring buffer used for features.
    window_size: int = field(default_factory=lambda: _env_int("SENCHINE_WINDOW", 64))

    # --- LLM ---
    anthropic_api_key: str = field(
        default_factory=lambda: os.environ.get("ANTHROPIC_API_KEY", "").strip()
    )
    llm_model: str = field(
        default_factory=lambda: os.environ.get("SENCHINE_LLM_MODEL", "claude-opus-5")
    )
    llm_effort: str = field(
        default_factory=lambda: os.environ.get("SENCHINE_LLM_EFFORT", "low")
    )
    llm_max_tokens: int = field(
        default_factory=lambda: _env_int("SENCHINE_LLM_MAX_TOKENS", 1400)
    )
    llm_cache_ttl: int = field(
        default_factory=lambda: _env_int("SENCHINE_LLM_CACHE_TTL", 300)
    )

    @property
    def llm_enabled(self) -> bool:
        return bool(self.anthropic_api_key)


settings = Settings()
