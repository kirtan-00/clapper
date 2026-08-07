"""Synthetic IoT sensor stream with physics-based degradation.

This stands in for the MQTT/OPC-UA gateway a real deployment would have. It is a
faithful stand-in rather than a random-number generator:

* Every machine carries a *true* hidden state (duty point, active fault mode,
  severity). Sensors observe that state — they do not each wander independently,
  which is why the fused multi-sensor picture is coherent and why the anomaly
  detector sees a real manifold rather than noise.
* Edge devices observe the machine *indirectly*: their measured deviation is
  attenuated by mounting distance, so a retrofitted machine genuinely produces
  weaker evidence than an instrumented one. This is what the EdgeSense fusion
  layer has to overcome, and it means the confidence numbers are earned.
* Real-world data defects are injected deliberately — dropouts, stuck sensors,
  EMI noise bursts, full sensor failures — because handling them is a stated
  requirement, and a pipeline only proves it handles them if they occur.

Hot path / cold path
--------------------
Readings go into an in-memory ring buffer *and* SQLite. Agents read the ring
buffer (microseconds, no I/O on the real-time path); SQLite keeps the durable
trace for history, audit and replay. Raw readings are retention-trimmed; the
derived snapshots are what persist.
"""

from __future__ import annotations

import math
import random
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Iterable

from .. import db
from ..config import settings
from ..ml.features import CURRENT_CV_SCALE, KIND_TO_CHANNEL
from ..ml.fusion import DECAY_M
from .profiles import ARCHETYPE_BY_KEY, SENSOR_KIND_SPEC
from ..physics import FAILURE_SIGNATURES

# Probability per tick of injecting each class of data defect.
P_DROPOUT = 0.012        # a sample simply does not arrive
P_NOISE_BURST = 0.004    # EMI / loose connector
P_SENSOR_FAULT = 0.0006  # sensor degrades and stays degraded
SENSOR_FAULT_TICKS = (40, 160)
# Fraction of vibration samples carrying a mechanical impact when an impulsive
# failure mode (bearing wear, lubrication loss) is developing.
P_IMPULSE = 0.14


@dataclass
class SensorRuntime:
    """Live state for one physical sensor."""

    id: int
    machine_id: int
    tag: str
    kind: str
    unit: str
    source: str
    device: str
    placement: str
    distance_m: float
    nominal: float
    noise_sigma: float
    status: str = "ok"
    fault_ticks_left: int = 0
    stuck_value: float | None = None
    buffer: deque = field(default_factory=lambda: deque(maxlen=settings.window_size))

    @property
    def channel(self) -> str:
        return KIND_TO_CHANNEL.get(self.kind, self.kind)


@dataclass
class MachineRuntime:
    """Hidden true state of one machine."""

    id: int
    code: str
    name: str
    archetype: str
    retrofit: bool
    duty_phase: float
    duty_base: float
    fault: str | None = None
    severity: float = 0.0
    severity_target: float = 0.0  # ramp destination for an injected fault
    ramp_rate: float = 0.0        # severity gained per tick while ramping in
    progression: float = 0.0      # severity gained per tick once at target
    scenario: str | None = None   # human label when injected manually
    running: bool = True
    sensors: list[SensorRuntime] = field(default_factory=list)


class Simulator:
    """Owns the hidden fleet state and produces sensor readings each tick."""

    def __init__(self, seed: int = 42) -> None:
        self.rng = random.Random(seed)
        self.machines: dict[int, MachineRuntime] = {}
        self.sensors: dict[int, SensorRuntime] = {}
        self.tick_count = 0
        self._lock = threading.RLock()
        self.loaded = False

    # -- setup --------------------------------------------------------------

    def load_from_db(self) -> None:
        """Rebuild runtime state from the persisted fleet definition."""
        with self._lock:
            self.machines.clear()
            self.sensors.clear()

            machine_rows = db.query(
                "SELECT id, code, name, machine_type, retrofit, status FROM machines"
            )
            for row in machine_rows:
                self.machines[row["id"]] = MachineRuntime(
                    id=row["id"],
                    code=row["code"],
                    name=row["name"],
                    archetype=row["machine_type"],
                    retrofit=bool(row["retrofit"]),
                    duty_phase=self.rng.uniform(0, 2 * math.pi),
                    duty_base=self.rng.uniform(0.72, 0.98),
                    running=row["status"] != "stopped",
                )

            sensor_rows = db.query(
                "SELECT id, machine_id, tag, kind, unit, source, device, placement, "
                "distance_m, nominal, noise_sigma, status FROM sensors"
            )
            for row in sensor_rows:
                machine = self.machines.get(row["machine_id"])
                if machine is None:
                    continue
                runtime = SensorRuntime(
                    id=row["id"],
                    machine_id=row["machine_id"],
                    tag=row["tag"],
                    kind=row["kind"],
                    unit=row["unit"],
                    source=row["source"],
                    device=row["device"],
                    placement=row["placement"],
                    distance_m=float(row["distance_m"]),
                    nominal=float(row["nominal"]),
                    noise_sigma=float(row["noise_sigma"]),
                    status=row["status"] or "ok",
                )
                self.sensors[runtime.id] = runtime
                machine.sensors.append(runtime)

            self.loaded = True

    # -- hidden state -------------------------------------------------------

    def _duty(self, machine: MachineRuntime) -> float:
        """Slowly varying load factor — plants do not run at a constant point."""
        wave = math.sin(machine.duty_phase + self.tick_count * 0.012)
        return max(0.35, min(1.15, machine.duty_base + 0.12 * wave))

    def true_channel_ratio(self, machine: MachineRuntime, channel: str) -> float:
        """The machine's real value on a canonical channel, as a ratio of nominal."""
        duty = self._duty(machine)

        # Healthy baseline response to load, per channel.
        base = {
            "vib_rms": 0.85 + 0.30 * duty,
            "temp_c": 0.80 + 0.28 * duty,
            "current_a": 0.70 + 0.35 * duty,
            "power_kw": 0.65 + 0.40 * duty,
            "acoustic_db": 0.88 + 0.18 * duty,
            "ultrasonic_db": 0.92 + 0.12 * duty,
            "speed_rpm": 0.90 + 0.14 * duty,
            "pressure_bar": 0.85 + 0.22 * duty,
            "ambient_c": 1.0,
            "humidity_pct": 1.0,
        }.get(channel, 1.0)

        if not machine.running:
            # A stopped machine still radiates residual heat and sits in ambient.
            if channel in ("ambient_c", "humidity_pct"):
                return base
            return 0.05 if channel != "temp_c" else 0.45

        if machine.fault and machine.severity > 0:
            sensitivity = FAILURE_SIGNATURES.get(machine.fault, {}).get(channel)
            if sensitivity:
                base *= 1.0 + sensitivity * machine.severity
        return max(0.02, base)

    def _advance_fault(self, machine: MachineRuntime) -> None:
        """Ramp an injected fault in, then let it progress.

        Faults ramp rather than step. A step change is not how machinery
        degrades, and it produces a large artificial transient in the trend
        features that briefly skews the failure-type classification. Ramping over
        a few ticks keeps injected scenarios physically honest while still
        reaching the requested severity quickly enough to demo.
        """
        if not machine.fault:
            return
        if machine.severity < machine.severity_target and machine.ramp_rate > 0:
            machine.severity = min(
                machine.severity_target, machine.severity + machine.ramp_rate
            )
        elif machine.progression > 0:
            machine.severity = min(1.0, machine.severity + machine.progression)

    # -- sampling -----------------------------------------------------------

    def _sample_sensor(
        self, machine: MachineRuntime, sensor: SensorRuntime
    ) -> tuple[float | None, str]:
        """Produce one reading, applying measurement physics and data defects."""
        # Injected sensor faults persist for a while, then heal.
        if sensor.fault_ticks_left > 0:
            sensor.fault_ticks_left -= 1
            if sensor.fault_ticks_left == 0:
                sensor.status = "ok"
                sensor.stuck_value = None
        elif self.rng.random() < P_SENSOR_FAULT:
            sensor.status = self.rng.choice(["noisy", "stuck", "degraded"])
            sensor.fault_ticks_left = self.rng.randint(*SENSOR_FAULT_TICKS)

        if sensor.status == "offline":
            return None, "missing"
        if sensor.status == "stuck":
            if sensor.stuck_value is None:
                sensor.stuck_value = sensor.nominal * self.true_channel_ratio(
                    machine, sensor.channel
                )
            return round(sensor.stuck_value, 4), "stuck"

        true_ratio = self.true_channel_ratio(machine, sensor.channel)

        # Edge devices observe the machine from a distance: the *deviation* from
        # nominal is attenuated, though the nominal reading itself is not. This
        # is precisely the signal loss the fusion layer is designed to recover.
        if sensor.source == "edge" and sensor.distance_m > 0:
            decay = DECAY_M.get(sensor.kind, 3.0)
            transfer = math.exp(-sensor.distance_m / (2.0 * decay))
            observed_ratio = 1.0 + (true_ratio - 1.0) * transfer
        else:
            observed_ratio = true_ratio

        sigma = sensor.noise_sigma
        if sensor.status == "noisy":
            sigma *= 5.0
        elif sensor.status == "degraded":
            sigma *= 2.5
        if self.rng.random() < P_NOISE_BURST:
            sigma *= 8.0

        # Phase imbalance modulates the measured line current. Emitting it as
        # excess variance (rather than a raised mean) is what lets the monitoring
        # agent recover an imbalance estimate from a single clamp — the only
        # configuration most real installations have.
        if sensor.kind == "current" and machine.fault and machine.severity > 0:
            imbalance = FAILURE_SIGNATURES.get(machine.fault, {}).get(
                "current_imbalance", 0.0
            )
            if imbalance > 0:
                sigma = math.sqrt(
                    sigma**2 + (CURRENT_CV_SCALE * imbalance * machine.severity) ** 2
                )

        value = sensor.nominal * observed_ratio * (1.0 + self.rng.gauss(0.0, sigma))

        # Impulsiveness. A degrading bearing or a dry lubrication film does not
        # simply raise the average vibration level — it produces sharp periodic
        # impacts. That is what raises the crest factor, and crest factor is the
        # earliest reliable indicator of both modes. Modelling it as a spike
        # process on a minority of samples (rather than scaling the mean) is what
        # makes the derived crest feature respond the way the physics says it
        # should.
        if sensor.kind == "vibration" and machine.fault and machine.severity > 0:
            crest_sensitivity = FAILURE_SIGNATURES.get(machine.fault, {}).get(
                "vib_crest", 0.0
            )
            if crest_sensitivity > 0 and self.rng.random() < P_IMPULSE:
                impulse = 1.0 + crest_sensitivity * machine.severity * self.rng.uniform(
                    0.8, 2.0
                )
                value *= impulse

        if self.rng.random() < P_DROPOUT:
            return None, "missing"

        quality = "good"
        if sensor.status in ("noisy", "degraded"):
            quality = "noisy"
        return round(max(0.0, value), 4), quality

    def tick(self) -> list[dict[str, Any]]:
        """Advance the fleet one step and return the readings produced."""
        with self._lock:
            self.tick_count += 1
            now = time.time()
            batch: list[dict[str, Any]] = []

            for machine in self.machines.values():
                self._advance_fault(machine)
                for sensor in machine.sensors:
                    value, quality = self._sample_sensor(machine, sensor)
                    sensor.buffer.append((now, value, quality))
                    sensor.last_seen = now
                    batch.append(
                        {
                            "sensor_id": sensor.id,
                            "machine_id": machine.id,
                            "ts": now,
                            "value": value,
                            "quality": quality,
                        }
                    )
            return batch

    def persist(self, batch: Iterable[dict[str, Any]]) -> None:
        rows = [(r["sensor_id"], r["ts"], r["value"], r["quality"]) for r in batch]
        if rows:
            db.execute_many(
                "INSERT INTO readings(sensor_id, ts, value, quality) VALUES(?,?,?,?)",
                rows,
            )

    def sync_sensor_status(self) -> None:
        """Push live sensor status/last-seen back to the database."""
        rows = [
            (s.status, s.buffer[-1][0] if s.buffer else None, s.id)
            for s in self.sensors.values()
        ]
        if rows:
            db.execute_many(
                "UPDATE sensors SET status = ?, last_seen = ? WHERE id = ?", rows
            )

    # -- scenario control ---------------------------------------------------

    def inject_fault(
        self,
        machine_id: int,
        category: str,
        severity: float = 0.25,
        progression: float = 0.004,
        label: str | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            machine = self.machines.get(machine_id)
            if machine is None:
                raise KeyError(f"unknown machine {machine_id}")
            if category not in FAILURE_SIGNATURES:
                raise ValueError(f"unknown failure category '{category}'")
            target = max(0.0, min(1.0, severity))
            machine.fault = category
            machine.severity_target = target
            # Start low and ramp to the requested severity over ~8 ticks.
            machine.severity = min(0.04, target)
            machine.ramp_rate = max(0.0, (target - machine.severity) / 8.0)
            machine.progression = max(0.0, progression)
            machine.scenario = label or category
            return self.machine_state(machine_id)

    def clear_fault(self, machine_id: int) -> dict[str, Any]:
        """Restore a machine to healthy — the effect of a completed repair."""
        with self._lock:
            machine = self.machines.get(machine_id)
            if machine is None:
                raise KeyError(f"unknown machine {machine_id}")
            machine.fault = None
            machine.severity = 0.0
            machine.severity_target = 0.0
            machine.ramp_rate = 0.0
            machine.progression = 0.0
            machine.scenario = None
            for sensor in machine.sensors:
                sensor.status = "ok"
                sensor.fault_ticks_left = 0
                sensor.stuck_value = None
            return self.machine_state(machine_id)

    def set_running(self, machine_id: int, running: bool) -> dict[str, Any]:
        with self._lock:
            machine = self.machines[machine_id]
            machine.running = running
            return self.machine_state(machine_id)

    def fail_sensor(self, sensor_id: int, status: str = "offline", ticks: int = 120) -> None:
        with self._lock:
            sensor = self.sensors.get(sensor_id)
            if sensor is None:
                raise KeyError(f"unknown sensor {sensor_id}")
            sensor.status = status
            sensor.fault_ticks_left = ticks
            sensor.stuck_value = None

    def machine_state(self, machine_id: int) -> dict[str, Any]:
        machine = self.machines[machine_id]
        return {
            "machine_id": machine.id,
            "code": machine.code,
            "running": machine.running,
            "injected_fault": machine.fault,
            "severity": round(machine.severity, 4),
            "progression": machine.progression,
            "scenario": machine.scenario,
            "duty": round(self._duty(machine), 4),
        }

    def sensor_window(self, sensor_id: int) -> list[tuple[float, float | None, str]]:
        sensor = self.sensors.get(sensor_id)
        return list(sensor.buffer) if sensor else []

    def machine_sensor_views(self, machine_id: int) -> list[dict[str, Any]]:
        """Everything the Monitoring agent needs about a machine's sensors."""
        machine = self.machines.get(machine_id)
        if machine is None:
            return []
        return [
            {
                "sensor_id": s.id,
                "tag": s.tag,
                "kind": s.kind,
                "unit": s.unit,
                "source": s.source,
                "device": s.device,
                "placement": s.placement,
                "distance_m": s.distance_m,
                "nominal": s.nominal,
                "status": s.status,
                "window": list(s.buffer),
            }
            for s in machine.sensors
        ]

    def fleet_summary(self) -> dict[str, Any]:
        with self._lock:
            faulted = [m for m in self.machines.values() if m.fault]
            return {
                "tick": self.tick_count,
                "machines": len(self.machines),
                "sensors": len(self.sensors),
                "injected_faults": len(faulted),
                "stopped": sum(1 for m in self.machines.values() if not m.running),
                "degraded_sensors": sum(
                    1 for s in self.sensors.values() if s.status != "ok"
                ),
            }


simulator = Simulator()
