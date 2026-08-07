"""Agent framework: a thin, explicit base class.

No agent framework dependency. Each agent is a class with a `run` method, a name,
and a declared contract (what it consumes, what it emits). Everything is
traced — every run writes an `agent_runs` row and streams to the live Agent
Activity panel — so the multi-agent pipeline is observable rather than a black
box, which is what a reviewer needs to see during a walkthrough.

Agents communicate through explicit typed results passed by the orchestrator,
not through shared mutable state. That keeps the data flow readable and means an
agent can be tested in isolation with a hand-written input.
"""

from __future__ import annotations

import json
import time
import traceback
from typing import Any

from .. import db
from ..realtime import hub


class AgentResult:
    """Uniform envelope returned by every agent run."""

    __slots__ = ("agent", "ok", "data", "summary", "duration_ms", "error")

    def __init__(
        self,
        agent: str,
        ok: bool,
        data: dict[str, Any],
        summary: str,
        duration_ms: float,
        error: str | None = None,
    ) -> None:
        self.agent = agent
        self.ok = ok
        self.data = data
        self.summary = summary
        self.duration_ms = duration_ms
        self.error = error

    def as_dict(self) -> dict[str, Any]:
        return {
            "agent": self.agent,
            "ok": self.ok,
            "summary": self.summary,
            "duration_ms": round(self.duration_ms, 2),
            "error": self.error,
            "data": self.data,
        }


class Agent:
    """Base class. Subclasses implement `execute`."""

    name: str = "agent"
    description: str = ""
    consumes: tuple[str, ...] = ()
    produces: tuple[str, ...] = ()

    def execute(self, **kwargs: Any) -> tuple[dict[str, Any], str]:
        raise NotImplementedError

    def run(self, *, machine_id: int | None = None, trace: bool = True, **kwargs: Any) -> AgentResult:
        started = time.perf_counter()
        try:
            data, summary = self.execute(machine_id=machine_id, **kwargs)
            duration = (time.perf_counter() - started) * 1000
            result = AgentResult(self.name, True, data, summary, duration)
        except Exception as exc:  # noqa: BLE001 — an agent failure must not stop the pipeline
            duration = (time.perf_counter() - started) * 1000
            result = AgentResult(
                self.name,
                False,
                {"traceback": traceback.format_exc(limit=4)},
                f"{type(exc).__name__}: {exc}",
                duration,
                error=str(exc),
            )
        if trace:
            self._trace(result, machine_id)
        return result

    def _trace(self, result: AgentResult, machine_id: int | None) -> None:
        try:
            db.execute(
                "INSERT INTO agent_runs(ts, agent, machine_id, duration_ms, status, "
                "summary, detail_json) VALUES(?,?,?,?,?,?,?)",
                (
                    time.time(),
                    self.name,
                    machine_id,
                    result.duration_ms,
                    "ok" if result.ok else "error",
                    result.summary[:500],
                    json.dumps(_trim_for_trace(result.data))[:4000],
                ),
            )
        except Exception:  # noqa: BLE001 — tracing must never break the pipeline
            pass

        hub.publish_soon(
            "agents",
            "agent.run",
            {
                "agent": self.name,
                "machine_id": machine_id,
                "ok": result.ok,
                "summary": result.summary,
                "duration_ms": round(result.duration_ms, 2),
            },
        )


def _trim_for_trace(data: dict[str, Any]) -> dict[str, Any]:
    """Keep traces small — drop bulky arrays that belong in their own tables."""
    skip = {"window", "readings", "contributions", "loss_curve", "per_feature_error"}
    return {k: v for k, v in data.items() if k not in skip}
