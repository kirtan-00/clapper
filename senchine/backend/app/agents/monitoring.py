"""Agent 1 — Monitoring.

Responsibilities
----------------
Collect IoT and edge sensor data; validate sensors; handle missing values; filter
noise; fuse multi-sensor evidence (EdgeSense); monitor in real time; detect
anomalies; produce a machine health score; push live updates over WebSocket.

Design
------
This agent is the only component that touches raw sensor data. Everything
downstream consumes its canonical output, which is what allows the Prediction and
Maintenance agents to be entirely industry-agnostic.

The health score is intentionally *not* `1 - anomaly_score`. A health score has
to answer "how worried should I be about this machine", which combines how far
the machine is from healthy, how many sensors are actually reporting, and how
much the evidence can be trusted. A machine whose sensors have all failed is not
healthy — it is unknown, and the score says so.
"""

from __future__ import annotations

import time
from typing import Any

import numpy as np

from .. import db
from ..ml import features as feat
from ..ml.fusion import confidence_band, fuse
from ..ml.registry import registry
from ..realtime import hub
from ..sim.simulator import simulator
from .base import Agent

# Health-score weights. Deviation dominates; confidence and coverage modulate.
W_DEVIATION = 0.62
W_ANOMALY = 0.38


class MonitoringAgent(Agent):
    name = "monitoring"
    description = (
        "Ingests IoT and EdgeSense telemetry, validates and cleans it, fuses "
        "multi-sensor evidence, detects anomalies and publishes machine health."
    )
    consumes = ("sensor_stream",)
    produces = ("health_score", "sensor_status", "anomaly_score", "feature_vector")

    def execute(self, *, machine_id: int, **_: Any) -> tuple[dict[str, Any], str]:
        machine = db.query_one(
            "SELECT id, code, name, machine_type, criticality, retrofit, plant_id "
            "FROM machines WHERE id = ?",
            (machine_id,),
        )
        if machine is None:
            raise KeyError(f"unknown machine {machine_id}")

        views = simulator.machine_sensor_views(machine_id)
        if not views:
            raise RuntimeError(f"no sensors registered for machine {machine_id}")

        sensor_reports, fusion_inputs = self._validate_and_clean(views)
        fusion = fuse(fusion_inputs)
        channels = self._to_feature_channels(fusion, sensor_reports)
        vector = feat.build_vector(channels)

        anomaly = registry.score_anomaly(vector)
        health = self._health_score(vector, anomaly["anomaly_score"], fusion, sensor_reports)

        snapshot = {
            "machine_id": machine_id,
            "code": machine["code"],
            "name": machine["name"],
            "ts": time.time(),
            "health_score": health["score"],
            "health_band": health["band"],
            "anomaly_score": round(anomaly["anomaly_score"], 4),
            "confidence": fusion["confidence"],
            "confidence_band": confidence_band(fusion["confidence"]),
            "retrofit": bool(machine["retrofit"]),
            "mode": fusion["mode"],
            "sensors": sensor_reports,
            "fusion": {
                "channels": fusion["channels"],
                "contributions": fusion["contributions"],
                "missing_channels": fusion["missing_channels"],
                "mode": fusion["mode"],
                "confidence": fusion["confidence"],
            },
            "features": feat.describe_vector(vector),
            "vector": [round(float(v), 5) for v in vector],
            "health_factors": health["factors"],
            "data_quality": health["data_quality"],
        }

        self._persist(snapshot)
        hub.publish_soon(f"machine:{machine_id}", "health.update", snapshot)
        hub.publish_soon(
            "fleet",
            "fleet.health",
            {
                "machine_id": machine_id,
                "code": machine["code"],
                "health_score": snapshot["health_score"],
                "health_band": snapshot["health_band"],
                "anomaly_score": snapshot["anomaly_score"],
                "confidence": snapshot["confidence"],
                "retrofit": snapshot["retrofit"],
                "ts": snapshot["ts"],
            },
        )

        summary = (
            f"{machine['code']}: health {health['score']:.1f} ({health['band']}), "
            f"anomaly {anomaly['anomaly_score']:.2f}, "
            f"confidence {fusion['confidence']:.2f} ({fusion['mode']})"
        )
        return snapshot, summary

    # -- validation and cleaning -------------------------------------------

    def _validate_and_clean(
        self, views: list[dict[str, Any]]
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Per-sensor validation, gap handling and noise filtering.

        Produces two things: a human-facing sensor status report, and the
        cleaned inputs the fusion layer consumes.
        """
        reports: list[dict[str, Any]] = []
        fusion_inputs: list[dict[str, Any]] = []

        for view in views:
            window = view["window"]
            raw_values = [value for _, value, _ in window]
            qualities = [quality for _, _, quality in window]

            missing = feat.missing_ratio(raw_values)
            noisy = (
                sum(1 for q in qualities if q == "noisy") / len(qualities)
                if qualities
                else 0.0
            )
            stats = feat.window_stats(raw_values)

            # Range validation against the sensor's declared nominal. A reading
            # far outside physical plausibility is a sensor fault, not a machine
            # fault, and must not be allowed to trigger a maintenance alert.
            nominal = float(view["nominal"]) or 1.0
            ratio = (stats["mean"] / nominal) if stats["n"] else 0.0
            out_of_range = bool(stats["n"] and (ratio > 5.0 or ratio < 0.02))

            status = view["status"]
            if status == "ok":
                if missing > 0.5:
                    status = "degraded"
                elif out_of_range:
                    status = "fault"
                elif noisy > 0.35:
                    status = "noisy"

            last_ts = window[-1][0] if window else None
            stale = bool(last_ts is None or (time.time() - last_ts) > 60)
            if stale and status == "ok":
                status = "offline"

            reports.append(
                {
                    "sensor_id": view["sensor_id"],
                    "tag": view["tag"],
                    "kind": view["kind"],
                    "unit": view["unit"],
                    "source": view["source"],
                    "device": view["device"],
                    "placement": view["placement"],
                    "distance_m": view["distance_m"],
                    "nominal": nominal,
                    "status": status,
                    "value": round(stats["mean"], 3) if stats["n"] else None,
                    "rms": round(stats["rms"], 3),
                    "peak": round(stats["peak"], 3),
                    "slope": round(stats["slope"], 4),
                    "full_mean": stats.get("full_mean", 0.0),
                    "full_std": stats.get("full_std", 0.0),
                    "ratio": round(ratio, 4),
                    "missing_pct": round(missing * 100, 1),
                    "noisy_pct": round(noisy * 100, 1),
                    "samples": stats["n"],
                    "last_seen": last_ts,
                }
            )

            if status in ("fault", "offline") or stats["n"] == 0:
                # Excluded from fusion entirely — a failed sensor contributes
                # nothing, and the confidence drop is the honest consequence.
                continue

            fusion_inputs.append(
                {
                    "tag": view["tag"],
                    "kind": view["kind"],
                    "device": view["device"],
                    "source": view["source"],
                    "distance_m": view["distance_m"],
                    "status": status,
                    "missing": missing,
                    "noisy": noisy,
                    "ratio": ratio,
                    "nominal": nominal,
                    "stats": stats,
                }
            )

        return reports, fusion_inputs

    def _to_feature_channels(
        self, fusion: dict[str, Any], reports: list[dict[str, Any]]
    ) -> dict[str, dict[str, float]]:
        """Convert fused channel ratios into the feature builder's input format."""
        channels: dict[str, dict[str, float]] = {}
        for name, data in fusion["channels"].items():
            channels[name] = {"value": data["value_ratio"], "nominal": 1.0}

        # Vibration carries extra shape statistics that the fusion layer, which
        # works on scalar ratios, does not transport.
        vib = next(
            (
                r
                for r in reports
                if r["kind"] == "vibration" and r["status"] not in ("fault", "offline")
            ),
            None,
        )
        if vib and "vib_rms" in channels and vib["rms"] > 0:
            nominal = vib["nominal"] or 1.0
            channels["vib_rms"]["peak_ratio"] = vib["peak"] / nominal
            # Normalised by the healthy peak-to-RMS ratio, so 1.0 means "healthy
            # shape" on the same scale as every other feature. Same constant the
            # training generator uses — see features.HEALTHY_CREST_RATIO.
            channels["vib_rms"]["crest"] = (
                vib["peak"] / vib["rms"]
            ) / feat.HEALTHY_CREST_RATIO
            channels["vib_rms"]["slope_ratio"] = vib["slope"] / nominal

        temp = next(
            (
                r
                for r in reports
                if r["kind"] in ("temperature", "thermal")
                and r["status"] not in ("fault", "offline")
            ),
            None,
        )
        if temp and "temp_c" in channels:
            channels["temp_c"]["slope_ratio"] = temp["slope"] / (temp["nominal"] or 1.0)

        # Phase imbalance. Two independent estimators, whichever is stronger:
        #   1. Dispersion across multiple current-measuring devices, when a
        #      machine happens to have more than one.
        #   2. Excess within-window variability of a single current measurement —
        #      unbalanced phases modulate the line current, and this is the only
        #      estimator available on the single-clamp installations that make up
        #      most of the real world.
        current_sensors = [
            r for r in reports
            if r["kind"] == "current" and r["status"] not in ("fault", "offline")
        ]
        if "current_a" in channels and current_sensors:
            across_devices = (
                float(np.std([r["ratio"] for r in current_sensors]))
                if len(current_sensors) > 1
                else 0.0
            )

            within_window = 0.0
            for report in current_sensors:
                # A noisy or degraded sensor produces excess variance that is
                # instrumental, not physical. Reading it as phase imbalance
                # turns a loose connector into an electrical-fault alert — the
                # exact false alarm this platform exists to eliminate. Only a
                # healthy sensor may contribute a variance-based estimate.
                if report["status"] != "ok" or report["noisy_pct"] > 5.0:
                    continue
                mean = report["full_mean"]
                if not mean or report["samples"] < 24:
                    continue
                cv = report["full_std"] / abs(mean)
                excess = max(0.0, cv - feat.CURRENT_CV_HEALTHY) / feat.CURRENT_CV_SCALE
                within_window = max(within_window, excess)

            channels["current_a"]["imbalance"] = round(
                min(2.0, max(across_devices, within_window)), 4
            )
        return channels

    # -- health scoring -----------------------------------------------------

    def _health_score(
        self,
        vector: np.ndarray,
        anomaly_score: float,
        fusion: dict[str, Any],
        reports: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Blend deviation and anomaly into a 0-100 health score.

        Confidence does not push the score down — an unreliable reading is not
        evidence of ill health. Instead it pulls the score toward "unknown"
        (a neutral 70), which is honest: with weak evidence we genuinely do not
        know, and the UI shows the low-confidence badge alongside.
        """
        # Deviation on the channels that indicate mechanical health, measured
        # against the *learned healthy baseline* rather than a flat 1.0. Some
        # channels sit naturally above or below nominal on a perfectly healthy
        # machine (peak always exceeds RMS, for one), so comparing to a flat 1.0
        # bakes a permanent false deviation into every machine's score.
        watch = ["vib_rms", "vib_peak", "vib_crest", "temp_rise", "current_imbalance",
                 "ultrasonic_db", "pressure_bar", "vib_trend", "temp_trend"]
        baseline = registry.baseline
        deviations = []
        for name in watch:
            idx = feat.FEATURE_INDEX[name]
            reference = float(baseline[idx]) if idx < len(baseline) else 1.0
            reference = reference if reference > 1e-6 else 1.0
            deviations.append(max(0.0, float(vector[idx]) / reference - 1.0))
        # Worst-channel emphasis: one badly deviating channel is a fault even if
        # everything else is fine, so a plain mean would wash it out.
        peak_dev = max(deviations) if deviations else 0.0
        mean_dev = float(np.mean(deviations)) if deviations else 0.0
        # Scaled so a channel at ~2x its healthy baseline drives the index near
        # 1.0. Saturating earlier than that collapses every serious fault onto a
        # health score of zero, which destroys the ranking between "bad" and
        # "about to fail" precisely where triage needs it.
        deviation_index = min(1.0, 0.52 * peak_dev + 0.28 * mean_dev * 2.0)

        raw_penalty = W_DEVIATION * deviation_index + W_ANOMALY * anomaly_score
        score = 100.0 * (1.0 - min(1.0, raw_penalty))

        confidence = fusion["confidence"]
        healthy_sensors = sum(1 for r in reports if r["status"] == "ok")
        total_sensors = len(reports) or 1
        coverage = healthy_sensors / total_sensors

        # Shrink toward "unknown" when evidence is weak.
        trust = min(1.0, confidence * 1.15)
        score = trust * score + (1.0 - trust) * 70.0

        band = (
            "healthy" if score >= 80
            else "watch" if score >= 62
            else "degraded" if score >= 42
            else "critical"
        )

        return {
            "score": round(float(np.clip(score, 0.0, 100.0)), 1),
            "band": band,
            "factors": {
                "deviation_index": round(deviation_index, 4),
                "anomaly_component": round(W_ANOMALY * anomaly_score, 4),
                "deviation_component": round(W_DEVIATION * deviation_index, 4),
                "evidence_trust": round(trust, 4),
            },
            "data_quality": {
                "sensors_total": total_sensors,
                "sensors_healthy": healthy_sensors,
                "sensor_coverage": round(coverage, 3),
                "degraded": [
                    r["tag"] for r in reports if r["status"] not in ("ok",)
                ],
                "avg_missing_pct": round(
                    float(np.mean([r["missing_pct"] for r in reports])) if reports else 0.0,
                    2,
                ),
            },
        }

    # -- persistence --------------------------------------------------------

    def _persist(self, snapshot: dict[str, Any]) -> None:
        import json

        db.execute(
            "INSERT INTO health_snapshots(machine_id, ts, health_score, anomaly_score, "
            "confidence, fusion_json, sensors_json) VALUES(?,?,?,?,?,?,?)",
            (
                snapshot["machine_id"],
                snapshot["ts"],
                snapshot["health_score"],
                snapshot["anomaly_score"],
                snapshot["confidence"],
                json.dumps(
                    {
                        "channels": snapshot["fusion"]["channels"],
                        "mode": snapshot["fusion"]["mode"],
                        "missing_channels": snapshot["fusion"]["missing_channels"],
                    }
                ),
                json.dumps(
                    [
                        {k: v for k, v in s.items() if k != "placement"}
                        for s in snapshot["sensors"]
                    ]
                ),
            ),
        )


monitoring_agent = MonitoringAgent()
