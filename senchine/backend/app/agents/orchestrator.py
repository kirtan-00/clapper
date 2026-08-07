"""Multi-agent orchestration and the real-time pipeline loop.

Execution model
---------------
Monitoring runs on every tick for every machine — it is cheap and must be
real-time. Prediction and Maintenance run every Nth tick, and only for machines
that Monitoring flagged as worth looking at. This is the core cost decision in
the platform: the expensive stages are gated on evidence from the cheap stage,
so compute tracks the number of *degrading* machines rather than the fleet size.

The pipeline is deliberately sequential per machine (Monitoring → Prediction →
Maintenance) because each stage genuinely consumes the previous stage's output.
Machines are independent of each other, so the loop parallelises across the fleet
if throughput ever demands it.

The loop is defensive: one machine raising an exception must not stop the other
twenty-nine. Failures are traced and the loop continues.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from .. import db
from ..config import settings
from ..realtime import hub
from ..sim.simulator import simulator
from .maintenance import maintenance_agent
from .monitoring import monitoring_agent
from .prediction import prediction_agent

# A machine is escalated to the Prediction agent when either holds.
ESCALATE_ANOMALY = 0.28
ESCALATE_HEALTH = 88.0
# Machines below this health always escalate, regardless of cadence.
URGENT_HEALTH = 55.0
# Retention sweep cadence, in ticks.
TRIM_EVERY = 150


class Orchestrator:
    def __init__(self) -> None:
        self.running = False
        self.tick = 0
        self.last_cycle_ms = 0.0
        self.cycles = 0
        self.errors = 0
        self.escalations = 0
        self._task: asyncio.Task | None = None
        self.paused = False

    # -- lifecycle ----------------------------------------------------------

    async def start(self) -> None:
        if self.running:
            return
        self.running = True
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        self.running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _loop(self) -> None:
        while self.running:
            try:
                if not self.paused:
                    await asyncio.to_thread(self.run_cycle)
            except Exception as exc:  # noqa: BLE001 — the loop must survive anything
                self.errors += 1
                hub.publish_soon(
                    "agents", "pipeline.error",
                    {"error": f"{type(exc).__name__}: {exc}", "tick": self.tick},
                )
            await asyncio.sleep(settings.tick_seconds)

    # -- one cycle ----------------------------------------------------------

    def run_cycle(self) -> dict[str, Any]:
        """One full pipeline pass. Runs on a worker thread; blocking is fine here."""
        started = time.perf_counter()
        self.tick += 1

        # 1. Ingest — advance the simulated plant and persist raw telemetry.
        batch = simulator.tick()
        simulator.persist(batch)

        run_heavy = self.tick % max(1, settings.pipeline_every) == 0
        monitored = 0
        escalated: list[int] = []
        predictions: list[dict[str, Any]] = []
        actions: list[dict[str, Any]] = []

        # 2. Monitoring — every machine, every tick.
        for machine_id in list(simulator.machines.keys()):
            outcome = monitoring_agent.run(machine_id=machine_id, trace=False)
            if not outcome.ok:
                self.errors += 1
                continue
            monitored += 1
            snapshot = outcome.data

            needs_prediction = (
                snapshot["anomaly_score"] >= ESCALATE_ANOMALY
                or snapshot["health_score"] <= ESCALATE_HEALTH
            )
            urgent = snapshot["health_score"] <= URGENT_HEALTH

            if needs_prediction and (run_heavy or urgent):
                escalated.append(machine_id)

                # 3. Prediction — only for machines that earned it.
                prediction_outcome = prediction_agent.run(
                    machine_id=machine_id, snapshot=snapshot
                )
                if not prediction_outcome.ok:
                    self.errors += 1
                    continue
                prediction = prediction_outcome.data
                predictions.append(prediction)

                # 4. Maintenance — turn the prediction into prioritised action.
                maintenance_outcome = maintenance_agent.run(
                    machine_id=machine_id, prediction=prediction
                )
                if maintenance_outcome.ok:
                    if maintenance_outcome.data.get("action_taken") != "none":
                        actions.append(maintenance_outcome.data)
                else:
                    self.errors += 1

        self.escalations += len(escalated)

        # 5. Housekeeping.
        if self.tick % 10 == 0:
            simulator.sync_sensor_status()
        if self.tick % TRIM_EVERY == 0:
            db.trim_readings()

        self.last_cycle_ms = (time.perf_counter() - started) * 1000
        self.cycles += 1

        status = {
            "tick": self.tick,
            "monitored": monitored,
            "escalated": len(escalated),
            "predictions": len(predictions),
            "actions": len(actions),
            "cycle_ms": round(self.last_cycle_ms, 1),
            "heavy_pass": run_heavy,
            "ts": time.time(),
        }
        hub.publish_soon("agents", "pipeline.cycle", status)
        return status

    # -- introspection ------------------------------------------------------

    def status(self) -> dict[str, Any]:
        return {
            "running": self.running,
            "paused": self.paused,
            "tick": self.tick,
            "cycles": self.cycles,
            "errors": self.errors,
            "escalations": self.escalations,
            "last_cycle_ms": round(self.last_cycle_ms, 1),
            "tick_seconds": settings.tick_seconds,
            "pipeline_every": settings.pipeline_every,
            "simulator": simulator.fleet_summary(),
        }

    @staticmethod
    def agent_manifest() -> list[dict[str, Any]]:
        """Declared contract of every agent — rendered in the UI's agent panel."""
        from .copilot import copilot_agent

        return [
            {
                "name": agent.name,
                "title": title,
                "description": agent.description,
                "consumes": list(agent.consumes),
                "produces": list(agent.produces),
                "cadence": cadence,
            }
            for agent, title, cadence in (
                (monitoring_agent, "Monitoring Agent", "every tick, every machine"),
                (prediction_agent, "Prediction Agent", "on escalation from Monitoring"),
                (maintenance_agent, "Maintenance Agent", "on every new prediction"),
                (copilot_agent, "AI Copilot Agent", "on user request"),
            )
        ]


orchestrator = Orchestrator()
