"""Anthropic client for the AI Copilot.

Cost engineering (an explicit project requirement) is done in four places:

1. **Prompt caching.** The system prompt is byte-stable and carries a cache
   breakpoint, so the large instruction block is billed at ~10% on every request
   after the first. All volatile content sits after the breakpoint.
2. **Low effort by default.** The Copilot summarises retrieved evidence — it does
   not need deep reasoning. `effort: "low"` cuts token spend substantially with
   no measurable quality loss on this task shape.
3. **Retrieval instead of context stuffing.** Only the evidence relevant to the
   question is sent, rather than the whole fleet state. Cost scales with the
   question, not the fleet.
4. **Response caching.** Identical questions inside a TTL window are served from
   memory. Dashboards get asked the same question repeatedly.

Reliability: a missing key, a network failure, a refusal or a rate limit all fall
back to the deterministic composer rather than surfacing an error, so the Copilot
never simply fails to answer.
"""

from __future__ import annotations

import hashlib
import threading
import time
from typing import Any

from ..config import settings
from .prompts import INTENT_GUIDANCE, SYSTEM_PROMPT, build_user_message

try:  # pragma: no cover - import guard exercised only without the SDK installed
    import anthropic

    _SDK_AVAILABLE = True
except ImportError:  # pragma: no cover
    anthropic = None  # type: ignore[assignment]
    _SDK_AVAILABLE = False


class ResponseCache:
    """Small TTL cache keyed by question + evidence fingerprint."""

    def __init__(self, ttl: int) -> None:
        self.ttl = ttl
        self._data: dict[str, tuple[float, dict[str, Any]]] = {}
        self._lock = threading.Lock()
        self.hits = 0
        self.misses = 0

    @staticmethod
    def key(question: str, evidence: str, role: str) -> str:
        digest = hashlib.sha256(
            f"{question.strip().lower()}|{role}|{evidence}".encode()
        ).hexdigest()
        return digest[:32]

    def get(self, key: str) -> dict[str, Any] | None:
        if self.ttl <= 0:
            return None
        with self._lock:
            entry = self._data.get(key)
            if entry is None:
                self.misses += 1
                return None
            stored_at, payload = entry
            if time.time() - stored_at > self.ttl:
                self._data.pop(key, None)
                self.misses += 1
                return None
            self.hits += 1
            return payload

    def put(self, key: str, payload: dict[str, Any]) -> None:
        if self.ttl <= 0:
            return
        with self._lock:
            # Bound memory: this is a cache, not a store.
            if len(self._data) > 256:
                oldest = min(self._data.items(), key=lambda kv: kv[1][0])[0]
                self._data.pop(oldest, None)
            self._data[key] = (time.time(), payload)

    def stats(self) -> dict[str, Any]:
        total = self.hits + self.misses
        return {
            "entries": len(self._data),
            "hits": self.hits,
            "misses": self.misses,
            "hit_rate": round(self.hits / total, 3) if total else 0.0,
            "ttl_seconds": self.ttl,
        }


class LLMClient:
    def __init__(self) -> None:
        self.cache = ResponseCache(settings.llm_cache_ttl)
        self._client: Any = None
        self.total_input_tokens = 0
        self.total_output_tokens = 0
        self.total_cache_read_tokens = 0
        self.total_cache_write_tokens = 0
        self.calls = 0
        self.failures = 0
        self.last_error: str | None = None

    @property
    def available(self) -> bool:
        return _SDK_AVAILABLE and settings.llm_enabled

    def _ensure_client(self) -> Any:
        if self._client is None and self.available:
            self._client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
        return self._client

    def complete(
        self,
        *,
        question: str,
        evidence: str,
        role: str,
        intent: str,
    ) -> dict[str, Any] | None:
        """Return a model answer, or `None` to signal "use the fallback".

        Never raises: every failure path returns `None`.
        """
        if not self.available:
            return None

        cache_key = self.cache.key(question, evidence, role)
        cached = self.cache.get(cache_key)
        if cached is not None:
            return {**cached, "cached": True}

        client = self._ensure_client()
        if client is None:
            return None

        user_text = build_user_message(question, evidence, role, intent)
        guidance = INTENT_GUIDANCE.get(intent)
        if guidance:
            user_text = f"{user_text}\n\n<response_guidance>{guidance}</response_guidance>"

        try:
            self.calls += 1
            response = client.beta.messages.create(
                model=settings.llm_model,
                max_tokens=settings.llm_max_tokens,
                # Stable prefix + cache breakpoint. Everything volatile is in the
                # user turn below, so this prefix is byte-identical every call.
                system=[
                    {
                        "type": "text",
                        "text": SYSTEM_PROMPT,
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
                messages=[{"role": "user", "content": user_text}],
                output_config={"effort": settings.llm_effort},
                # Safety classifiers can decline; route declines to a fallback
                # model server-side rather than returning nothing to the user.
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
            )
        except Exception as exc:  # noqa: BLE001 — the Copilot must degrade, not fail
            self.failures += 1
            self.last_error = f"{type(exc).__name__}: {exc}"
            return None

        # Always check stop_reason before reading content.
        if getattr(response, "stop_reason", None) == "refusal":
            self.failures += 1
            details = getattr(response, "stop_details", None)
            self.last_error = (
                f"model refusal ({getattr(details, 'category', 'unspecified')})"
            )
            return None

        text = "".join(
            block.text
            for block in response.content
            if getattr(block, "type", None) == "text"
        ).strip()
        if not text:
            self.failures += 1
            self.last_error = "empty response"
            return None

        usage = getattr(response, "usage", None)
        input_tokens = getattr(usage, "input_tokens", 0) or 0
        output_tokens = getattr(usage, "output_tokens", 0) or 0
        cache_read = getattr(usage, "cache_read_input_tokens", 0) or 0
        cache_write = getattr(usage, "cache_creation_input_tokens", 0) or 0

        self.total_input_tokens += input_tokens
        self.total_output_tokens += output_tokens
        self.total_cache_read_tokens += cache_read
        self.total_cache_write_tokens += cache_write

        payload = {
            "answer": text,
            "model": getattr(response, "model", settings.llm_model),
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_read_input_tokens": cache_read,
                "cache_creation_input_tokens": cache_write,
            },
            "cached": False,
        }
        self.cache.put(cache_key, payload)
        return payload

    def stats(self) -> dict[str, Any]:
        total_prompt = (
            self.total_input_tokens
            + self.total_cache_read_tokens
            + self.total_cache_write_tokens
        )
        return {
            "enabled": self.available,
            "sdk_installed": _SDK_AVAILABLE,
            "model": settings.llm_model if self.available else None,
            "effort": settings.llm_effort,
            "calls": self.calls,
            "failures": self.failures,
            "last_error": self.last_error,
            "tokens": {
                "input": self.total_input_tokens,
                "output": self.total_output_tokens,
                "cache_read": self.total_cache_read_tokens,
                "cache_write": self.total_cache_write_tokens,
                # The headline cost metric: share of prompt tokens served from
                # cache at ~10% of list price.
                "cache_hit_ratio": round(
                    self.total_cache_read_tokens / total_prompt, 3
                ) if total_prompt else 0.0,
            },
            "response_cache": self.cache.stats(),
        }


llm_client = LLMClient()
