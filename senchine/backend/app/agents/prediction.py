"""Agent 2 — Prediction.

Responsibilities
----------------
Predict failure probability; estimate Remaining Useful Life; predict the failure
type; produce a calibrated confidence; explain the prediction with SHAP.

Design
------
The raw model output is not the deliverable. A number without an explanation
does not get acted on in a maintenance organisation, and it should not be — a
planner who cannot see *why* has no way to sanity-check the model against what
they know about the asset. So every prediction ships with attributions, a
narrated root cause, and an explicit statement of its own limitations.

Two adjustments are applied on top of the model:

* **Evidence discounting.** A prediction built on weak, fused edge estimates is
  reported with lower confidence than the same prediction from direct
  instrumentation. The model does not know how good its inputs were; this agent
  does, and it propagates that.
* **Trend corroboration.** A prediction supported by a consistent multi-snapshot
  trend is more trustworthy than one from a single frame. Sustained deterioration
  raises confidence; a one-off spike does not.
"""

from __future__ import annotations

import json
import time
from typing import Any

import numpy as np

from .. import db
from ..ml.explain import narrate
from ..ml.mlp import CATEGORY_LABELS, RUL_CEILING_HOURS
from ..ml.registry import registry
from ..physics import FAILURE_DESCRIPTIONS
from ..realtime import hub
from .base import Agent

# Number of recent snapshots used to corroborate a prediction with a trend.
TREND_WINDOW = 12
# Below this anomaly score we do not spend a SHAP explanation — a healthy machine
# has nothing to explain, and the cost is better spent on the ones that matter.
EXPLAIN_THRESHOLD = 0.30


class PredictionAgent(Agent):
    name = "prediction"
    description = (
        "Predicts failure probability, remaining useful life and failure type, "
        "with SHAP-based explanations and calibrated confidence."
    )
    consumes = ("feature_vector", "anomaly_score", "health_score")
    produces = (
        "failure_probability", "remaining_useful_life",
        "confidence", "failure_category", "root_cause",
    )

    def execute(
        self, *, machine_id: int, snapshot: dict[str, Any] | None = None, **_: Any
    ) -> tuple[dict[str, Any], str]:
        machine = db.query_one(
            "SELECT id, code, name, machine_type, criticality, retrofit "
            "FROM machines WHERE id = ?",
            (machine_id,),
        )
        if machine is None:
            raise KeyError(f"unknown machine {machine_id}")

        if snapshot is None:
            snapshot = self._latest_snapshot(machine_id)
        vector = np.asarray(snapshot["vector"], dtype=float)

        prediction = registry.predict(vector)
        anomaly_score = float(snapshot.get("anomaly_score", 0.0))
        evidence_confidence = float(snapshot.get("confidence", 1.0))

        explanation: dict[str, Any]
        if anomaly_score >= EXPLAIN_THRESHOLD or prediction["failure_probability"] >= 0.25:
            explanation = registry.explain(vector, permutations=96)
            root_cause = narrate(explanation, prediction["category_label"])
        else:
            explanation = {
                "method": "skipped",
                "reason": "machine within healthy envelope — no deviation to attribute",
                "contributions": [],
                "explanation_quality": 1.0,
                "baseline_score": None,
                "predicted_score": round(prediction["failure_probability"], 5),
            }
            root_cause = (
                "All monitored channels sit within the healthy operating envelope; "
                "no failure mechanism is currently developing."
            )

        trend = self._trend(machine_id)
        confidence = self._calibrate_confidence(
            prediction["confidence"], evidence_confidence, trend, explanation
        )

        rul_hours = prediction["rul_hours"]
        result = {
            "machine_id": machine_id,
            "code": machine["code"],
            "name": machine["name"],
            "ts": time.time(),
            "failure_probability": round(prediction["failure_probability"], 4),
            "rul_hours": round(rul_hours, 1),
            "rul_display": self._format_rul(rul_hours),
            "rul_band": self._rul_band(rul_hours),
            "failure_category": prediction["failure_category"],
            "category_label": prediction["category_label"],
            "category_description": FAILURE_DESCRIPTIONS.get(
                prediction["failure_category"], ""
            ),
            "category_probabilities": prediction["category_probabilities"],
            "confidence": round(confidence["value"], 4),
            "confidence_basis": confidence["basis"],
            "root_cause": root_cause,
            "explanation": explanation,
            "trend": trend,
            "limitations": self._limitations(
                machine, evidence_confidence, explanation, trend, rul_hours
            ),
            "model_version": prediction["model_version"],
            "evidence_confidence": round(evidence_confidence, 4),
        }

        prediction_id = self._persist(result)
        result["prediction_id"] = prediction_id

        hub.publish_soon(f"machine:{machine_id}", "prediction.update", result)

        summary = (
            f"{machine['code']}: P(fail)={result['failure_probability']:.2f}, "
            f"RUL={result['rul_display']}, {result['category_label']}, "
            f"confidence {result['confidence']:.2f}"
        )
        return result, summary

    # -- helpers ------------------------------------------------------------

    def _latest_snapshot(self, machine_id: int) -> dict[str, Any]:
        """Re-run monitoring if no snapshot was handed in by the orchestrator."""
        from .monitoring import monitoring_agent

        outcome = monitoring_agent.run(machine_id=machine_id, trace=False)
        if not outcome.ok:
            raise RuntimeError(f"monitoring failed: {outcome.error}")
        return outcome.data

    def _trend(self, machine_id: int) -> dict[str, Any]:
        """Direction and consistency of health over the recent window."""
        rows = db.query(
            "SELECT health_score, anomaly_score, ts FROM health_snapshots "
            "WHERE machine_id = ? ORDER BY ts DESC LIMIT ?",
            (machine_id, TREND_WINDOW),
        )
        if len(rows) < 4:
            return {
                "direction": "unknown",
                "slope_per_hour": 0.0,
                "consistency": 0.0,
                "samples": len(rows),
            }

        scores = np.array([r["health_score"] for r in rows][::-1], dtype=float)
        times = np.array([r["ts"] for r in rows][::-1], dtype=float)
        hours = (times - times[0]) / 3600.0
        if hours[-1] - hours[0] < 1e-9:
            return {
                "direction": "stable", "slope_per_hour": 0.0,
                "consistency": 0.0, "samples": len(rows),
            }

        slope = float(np.polyfit(hours, scores, 1)[0])
        # Consistency = R^2 of the linear fit. A steady decline fits well; a
        # noisy sawtooth does not, and should not be treated as a trend.
        fitted = np.polyval(np.polyfit(hours, scores, 1), hours)
        ss_res = float(np.sum((scores - fitted) ** 2))
        ss_tot = float(np.sum((scores - scores.mean()) ** 2))
        consistency = 1.0 - ss_res / ss_tot if ss_tot > 1e-9 else 0.0

        direction = (
            "deteriorating" if slope < -0.5
            else "improving" if slope > 0.5
            else "stable"
        )
        return {
            "direction": direction,
            "slope_per_hour": round(slope, 3),
            "consistency": round(float(np.clip(consistency, 0.0, 1.0)), 3),
            "samples": len(rows),
            "recent_scores": [round(float(s), 1) for s in scores[-8:]],
        }

    def _calibrate_confidence(
        self,
        model_confidence: float,
        evidence_confidence: float,
        trend: dict[str, Any],
        explanation: dict[str, Any],
    ) -> dict[str, Any]:
        """Combine model certainty, evidence quality, trend and explainability."""
        basis: list[str] = []

        value = model_confidence
        basis.append(f"model certainty {model_confidence:.2f}")

        # Evidence quality is a hard multiplier, floored so a well-behaved model
        # on weak inputs still reports something usable.
        evidence_factor = 0.55 + 0.45 * evidence_confidence
        value *= evidence_factor
        basis.append(f"evidence quality {evidence_confidence:.2f}")

        if trend["direction"] == "deteriorating" and trend["consistency"] > 0.5:
            value = min(1.0, value * 1.12)
            basis.append("corroborated by a consistent deteriorating trend")
        elif trend["direction"] == "unknown":
            value *= 0.92
            basis.append("limited history for trend corroboration")

        quality = float(explanation.get("explanation_quality", 1.0))
        if quality < 0.85:
            value *= 0.93
            basis.append(f"attribution quality {quality:.2f}")

        return {"value": float(np.clip(value, 0.05, 0.99)), "basis": basis}

    def _limitations(
        self,
        machine: Any,
        evidence_confidence: float,
        explanation: dict[str, Any],
        trend: dict[str, Any],
        rul_hours: float,
    ) -> list[str]:
        """State plainly what this prediction cannot tell you."""
        notes: list[str] = []
        if machine["retrofit"]:
            notes.append(
                "This asset has no onboard instrumentation. Machine state is "
                "inferred from external EdgeSense devices, so absolute values are "
                "estimates; trends and relative changes are more reliable than "
                "the absolute numbers."
            )
        if evidence_confidence < 0.6:
            notes.append(
                f"Sensor evidence quality is {evidence_confidence:.0%}. Verify with a "
                "manual inspection before committing to a shutdown."
            )
        if trend["samples"] < 6:
            notes.append(
                "Fewer than six historical snapshots are available, so the trend "
                "component of this prediction is weakly supported."
            )
        if rul_hours >= RUL_CEILING_HOURS * 0.9:
            notes.append(
                "Remaining life is beyond the model's 2 000-hour planning horizon; "
                "read this as 'no failure expected within the horizon' rather than "
                "a precise figure."
            )
        if explanation.get("method") == "skipped":
            notes.append(
                "Attribution was skipped because the machine is inside its healthy "
                "envelope and there is no deviation to attribute."
            )
        notes.append(
            "Models were trained on physics-based synthetic degradation profiles. "
            "Before production use they require re-fitting on this site's own "
            "historical failure records."
        )
        return notes

    @staticmethod
    def _format_rul(hours: float) -> str:
        if hours >= RUL_CEILING_HOURS * 0.9:
            return "> 80 days"
        if hours >= 72:
            return f"{hours / 24:.0f} days"
        if hours >= 1:
            return f"{hours:.0f} h"
        return "< 1 h"

    @staticmethod
    def _rul_band(hours: float) -> str:
        if hours < 24:
            return "imminent"
        if hours < 168:
            return "this_week"
        if hours < 720:
            return "this_month"
        return "long_horizon"

    def _persist(self, result: dict[str, Any]) -> int:
        return db.execute(
            "INSERT INTO predictions(machine_id, ts, failure_prob, rul_hours, confidence, "
            "failure_category, root_cause, explanation_json, model_version) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            (
                result["machine_id"],
                result["ts"],
                result["failure_probability"],
                result["rul_hours"],
                result["confidence"],
                result["failure_category"],
                result["root_cause"],
                json.dumps(result["explanation"].get("contributions", [])),
                result["model_version"],
            ),
        )


prediction_agent = PredictionAgent()
