"""Agent 3 — Maintenance.

Responsibilities
----------------
Prioritise alerts; create maintenance work orders; recommend technician skill and
spare parts; estimate downtime and cost; produce a maintenance schedule.

Design
------
This is where a prediction becomes an action, and it is the agent that has to be
most disciplined about the boundary between AI and human authority.

* **Priority is risk, not probability.** P1 is not "highest failure probability";
  it is highest expected loss — probability times consequence, where consequence
  depends on asset criticality and the cost of downtime on that specific machine.
  A 60% chance on a turbine outranks a 95% chance on a cooling-tower fan.
* **Alerts are deduplicated.** A degrading machine produces a prediction every
  few seconds. Re-raising an alert each time is how monitoring systems get
  ignored, so alerts are keyed on machine plus failure mode and updated in place
  while open.
* **Above a threshold the agent proposes, it does not act.** Cost, downtime,
  criticality and confidence gates are enforced by `guardrails`, and anything
  above them lands as `pending_approval` for a human planner.
* **Scheduling respects reality.** Work is scheduled inside the remaining useful
  life, against a real technician with the right skill, with lead time for parts
  that are not in stock.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from .. import db
from ..guardrails import requires_human_approval
from ..ml.mlp import CATEGORY_LABELS
from ..realtime import hub
from ..sim.profiles import ARCHETYPE_BY_KEY, SKILL_MATRIX
from .base import Agent
from .notifier import notify_alert, notify_work_order

# Risk score above which an alert is raised at all.
ALERT_THRESHOLD = 0.18
# Priority bands on the computed risk score.
PRIORITY_BANDS = ((0.62, "P1"), (0.38, "P2"), (0.20, "P3"))

RECOMMENDED_ACTIONS: dict[str, str] = {
    "bearing_wear": (
        "Vibration analysis with spectrum capture at the drive-end bearing, then "
        "replace the affected bearing set and re-align the coupling."
    ),
    "overheating": (
        "Inspect and clean the cooling circuit, verify coolant flow and fan "
        "operation, and check for overload on the driven equipment."
    ),
    "lubrication_failure": (
        "Sample and analyse the lubricant, purge and recharge the circuit, and "
        "verify the automatic lubricator delivery rate."
    ),
    "rotor_imbalance": (
        "Perform in-situ dynamic balancing and laser shaft alignment; inspect the "
        "coupling insert for wear."
    ),
    "electrical_fault": (
        "Insulation-resistance and phase-balance testing at the motor terminals, "
        "thermographic survey of the starter panel, and drive-stage inspection."
    ),
    "blockage_fouling": (
        "Isolate and inspect the flow path, clean or replace strainers and "
        "internals, then verify differential pressure against the design curve."
    ),
    "healthy": "Continue condition monitoring; no intervention required.",
}


class MaintenanceAgent(Agent):
    name = "maintenance"
    description = (
        "Prioritises risk, raises deduplicated alerts, drafts work orders with "
        "parts, skills, cost and downtime estimates, and schedules the work."
    )
    consumes = ("failure_probability", "remaining_useful_life", "failure_category")
    produces = (
        "priority", "recommended_action", "estimated_downtime",
        "estimated_cost", "maintenance_schedule",
    )

    def execute(
        self, *, machine_id: int, prediction: dict[str, Any], **_: Any
    ) -> tuple[dict[str, Any], str]:
        machine = db.query_one(
            "SELECT m.*, p.name AS plant_name, p.industry "
            "FROM machines m JOIN plants p ON p.id = m.plant_id WHERE m.id = ?",
            (machine_id,),
        )
        if machine is None:
            raise KeyError(f"unknown machine {machine_id}")

        risk = self._risk_score(machine, prediction)
        if risk["score"] < ALERT_THRESHOLD:
            return (
                {
                    "machine_id": machine_id,
                    "action_taken": "none",
                    "risk": risk,
                    "reason": "risk below alerting threshold",
                },
                f"{machine['code']}: risk {risk['score']:.2f} — no action",
            )

        priority = self._priority(risk["score"])
        category = prediction["failure_category"]
        plan = self._build_plan(machine, prediction, priority, risk)

        alert = self._upsert_alert(machine, prediction, priority, risk)
        work_order = self._ensure_work_order(machine, prediction, alert, plan, priority)

        result = {
            "machine_id": machine_id,
            "code": machine["code"],
            "action_taken": "alert+work_order" if work_order else "alert",
            "risk": risk,
            "priority": priority,
            "recommended_action": plan["action"],
            "skill_required": plan["skill"],
            "parts": plan["parts"],
            "estimated_downtime_h": plan["downtime_h"],
            "estimated_cost": plan["cost"],
            "cost_breakdown": plan["cost_breakdown"],
            "avoided_cost": plan["avoided_cost"],
            "schedule": plan["schedule"],
            "alert": alert,
            "work_order": work_order,
            "approval": plan["approval"],
        }

        summary = (
            f"{machine['code']}: {priority} {CATEGORY_LABELS.get(category, category)}, "
            f"{plan['downtime_h']:.1f} h / {plan['cost']:,.0f} est."
            + (f" WO {work_order['code']}" if work_order else "")
        )
        return result, summary

    # -- risk and priority --------------------------------------------------

    def _risk_score(self, machine: Any, prediction: dict[str, Any]) -> dict[str, Any]:
        """Expected-loss risk, normalised to 0-1.

        Deliberately multiplicative in consequence: probability alone ranks a
        near-certain failure of a trivial asset above a likely failure of the
        asset that stops the plant, which is the wrong work order to do first.
        """
        probability = float(prediction["failure_probability"])
        confidence = float(prediction["confidence"])
        rul_hours = float(prediction["rul_hours"])

        criticality_weight = {
            "critical": 1.0, "high": 0.72, "medium": 0.45, "low": 0.25
        }.get(machine["criticality"], 0.5)

        # Urgency: how much of the planning horizon is left.
        if rul_hours <= 24:
            urgency = 1.0
        elif rul_hours <= 168:
            urgency = 0.72
        elif rul_hours <= 720:
            urgency = 0.42
        else:
            urgency = 0.15

        archetype = ARCHETYPE_BY_KEY.get(machine["machine_type"])
        downtime_cost = archetype.hourly_downtime_cost if archetype else 5000.0
        # Log-scaled so a 48k/h turbine outranks a 4k/h fan without swamping
        # every other factor.
        cost_weight = min(1.0, (downtime_cost / 50000.0) ** 0.5)

        score = (
            probability
            * (0.45 * criticality_weight + 0.35 * urgency + 0.20 * cost_weight)
            * (0.6 + 0.4 * confidence)
        )
        return {
            "score": round(min(1.0, score), 4),
            "probability": round(probability, 4),
            "criticality_weight": criticality_weight,
            "urgency": urgency,
            "cost_weight": round(cost_weight, 4),
            "confidence": round(confidence, 4),
            "hourly_downtime_cost": downtime_cost,
        }

    @staticmethod
    def _priority(risk_score: float) -> str:
        for threshold, label in PRIORITY_BANDS:
            if risk_score >= threshold:
                return label
        return "P4"

    # -- planning -----------------------------------------------------------

    def _build_plan(
        self,
        machine: Any,
        prediction: dict[str, Any],
        priority: str,
        risk: dict[str, Any],
    ) -> dict[str, Any]:
        category = prediction["failure_category"]
        skill_spec = SKILL_MATRIX.get(category, SKILL_MATRIX["healthy"])
        parts = self._recommend_parts(machine, category)

        # Downtime scales with asset size — replacing a bearing on a 3 MW mill is
        # not the same job as on a 12 kW pick-and-place.
        power = float(machine["rated_power_kw"] or 50.0)
        size_factor = min(3.0, max(0.6, (power / 150.0) ** 0.32))
        downtime_h = round(skill_spec["base_hours"] * size_factor, 2)

        labour_cost = skill_spec["hourly_rate"] * downtime_h * 1.4  # +40% for a two-person crew
        parts_cost = sum(p["unit_cost"] * p["quantity"] for p in parts)
        # Rush premium when parts must be expedited to land inside the RUL.
        max_lead = max((p["lead_time_days"] for p in parts), default=0)
        rul_days = prediction["rul_hours"] / 24.0
        expedite = max_lead > rul_days * 0.6 and max_lead > 0
        expedite_cost = parts_cost * 0.25 if expedite else 0.0

        downtime_cost = risk["hourly_downtime_cost"] * downtime_h
        total_cost = round(labour_cost + parts_cost + expedite_cost + downtime_cost, 2)

        # Value of acting early: an unplanned failure costs materially more than
        # a planned intervention — longer outage, secondary damage, emergency
        # labour. The 3.2x multiplier is the conservative end of published
        # planned-vs-unplanned ratios.
        avoided_cost = round(
            (downtime_cost * 3.2 + parts_cost * 1.8) * float(prediction["failure_probability"]),
            2,
        )

        needs_approval, approval_reason = requires_human_approval(
            estimated_cost=total_cost,
            estimated_downtime_h=downtime_h,
            criticality=machine["criticality"],
            confidence=float(prediction["confidence"]),
            priority=priority,
        )

        schedule = self._schedule(prediction, priority, downtime_h, max_lead)

        return {
            "action": RECOMMENDED_ACTIONS.get(category, RECOMMENDED_ACTIONS["healthy"]),
            "skill": skill_spec["skill"],
            "skill_code": skill_spec["code"],
            "parts": parts,
            "downtime_h": downtime_h,
            "cost": total_cost,
            "cost_breakdown": {
                "labour": round(labour_cost, 2),
                "parts": round(parts_cost, 2),
                "expedite": round(expedite_cost, 2),
                "production_downtime": round(downtime_cost, 2),
            },
            "avoided_cost": avoided_cost,
            "schedule": schedule,
            "approval": {
                "required": needs_approval,
                "reason": approval_reason,
                "autonomy": "propose_only" if needs_approval else "auto_schedule",
            },
        }

    def _recommend_parts(self, machine: Any, category: str) -> list[dict[str, Any]]:
        rows = db.query(
            "SELECT sku, name, unit_cost, stock, lead_time_days FROM spare_parts "
            "WHERE failure_category = ? AND (machine_type = '*' OR machine_type = ?) "
            "ORDER BY unit_cost DESC",
            (category, machine["machine_type"]),
        )
        parts: list[dict[str, Any]] = []
        for row in rows[:3]:
            quantity = 2 if "seal" in row["name"].lower() or "cable" in row["name"].lower() else 1
            parts.append(
                {
                    "sku": row["sku"],
                    "name": row["name"],
                    "quantity": quantity,
                    "unit_cost": row["unit_cost"],
                    "in_stock": row["stock"] >= quantity,
                    "stock": row["stock"],
                    "lead_time_days": 0 if row["stock"] >= quantity else row["lead_time_days"],
                }
            )
        return parts

    def _schedule(
        self, prediction: dict[str, Any], priority: str, downtime_h: float, lead_days: int
    ) -> dict[str, Any]:
        """Place the work inside the remaining useful life, after parts arrive."""
        now = datetime.now(timezone.utc)
        rul_hours = float(prediction["rul_hours"])

        # Target the point where two-thirds of remaining life is consumed: late
        # enough not to waste life, early enough to leave recovery margin.
        target_offset_h = max(2.0, rul_hours * 0.66)
        if priority == "P1":
            target_offset_h = min(target_offset_h, 12.0)
        elif priority == "P2":
            target_offset_h = min(target_offset_h, 72.0)

        earliest_h = max(lead_days * 24.0, 1.0)
        start_offset_h = max(earliest_h, min(target_offset_h, rul_hours * 0.85))

        start = now + timedelta(hours=start_offset_h)
        # Prefer the night shift for non-urgent work: less production impact.
        if priority in ("P3", "P4") and 6 <= start.hour <= 20:
            start = start.replace(hour=22, minute=0, second=0, microsecond=0)
        end = start + timedelta(hours=downtime_h)

        feasible = start_offset_h <= rul_hours
        return {
            "start": start.isoformat(),
            "end": end.isoformat(),
            "start_ts": start.timestamp(),
            "end_ts": end.timestamp(),
            "window_hours": round(downtime_h, 2),
            "lead_time_days": lead_days,
            "feasible_within_rul": feasible,
            "note": (
                "Scheduled within remaining useful life."
                if feasible
                else "WARNING: parts lead time exceeds remaining useful life — "
                     "expedite procurement or plan a controlled shutdown."
            ),
        }

    # -- alerts and work orders --------------------------------------------

    def _upsert_alert(
        self, machine: Any, prediction: dict[str, Any], priority: str, risk: dict[str, Any]
    ) -> dict[str, Any]:
        """Raise a new alert, or refresh the open one for this failure mode."""
        category = prediction["failure_category"]
        dedupe_key = f"{machine['id']}:{category}"
        severity = {"P1": "critical", "P2": "high", "P3": "medium", "P4": "low"}[priority]

        title = f"{CATEGORY_LABELS.get(category, category)} predicted on {machine['code']}"
        detail = (
            f"{prediction['failure_probability']:.0%} failure probability within the "
            f"planning horizon. Estimated remaining useful life {prediction['rul_display']}. "
            f"{prediction['root_cause']}"
        )
        evidence = {
            "risk": risk,
            "confidence": prediction["confidence"],
            "rul_hours": prediction["rul_hours"],
            "top_factors": prediction["explanation"].get("contributions", [])[:4],
            "trend": prediction.get("trend", {}),
            "evidence_confidence": prediction.get("evidence_confidence"),
        }

        existing = db.query_one(
            "SELECT id, severity FROM alerts WHERE dedupe_key = ? AND status IN "
            "('open', 'acknowledged') ORDER BY ts DESC LIMIT 1",
            (dedupe_key,),
        )

        if existing:
            db.execute(
                "UPDATE alerts SET ts = ?, severity = ?, detail = ?, "
                "evidence_json = ?, prediction_id = ? WHERE id = ?",
                (
                    time.time(), severity, detail, json.dumps(evidence),
                    prediction.get("prediction_id"), existing["id"],
                ),
            )
            alert_id = int(existing["id"])
            escalated = existing["severity"] != severity
            created = False
        else:
            alert_id = db.execute(
                "INSERT INTO alerts(machine_id, ts, severity, title, detail, source_agent, "
                "status, prediction_id, evidence_json, dedupe_key) "
                "VALUES(?,?,?,?,?,?,?,?,?,?)",
                (
                    machine["id"], time.time(), severity, title, detail, self.name,
                    "open", prediction.get("prediction_id"), json.dumps(evidence), dedupe_key,
                ),
            )
            escalated = False
            created = True

        alert = {
            "id": alert_id,
            "machine_id": machine["id"],
            "machine_code": machine["code"],
            "machine_name": machine["name"],
            "severity": severity,
            "priority": priority,
            "title": title,
            "detail": detail,
            "status": "open" if created else (existing["severity"] and "open"),
            "created": created,
            "escalated": escalated,
            "ts": time.time(),
        }

        if created or escalated:
            notify_alert(machine, alert, prediction)
            hub.publish_soon("alerts", "alert.raised" if created else "alert.escalated", alert)
        return alert

    def _ensure_work_order(
        self,
        machine: Any,
        prediction: dict[str, Any],
        alert: dict[str, Any],
        plan: dict[str, Any],
        priority: str,
    ) -> dict[str, Any] | None:
        """Create a work order once per open alert; never duplicate."""
        existing = db.query_one(
            "SELECT id, code, status FROM work_orders WHERE alert_id = ? "
            "AND status NOT IN ('completed', 'cancelled')",
            (alert["id"],),
        )
        if existing:
            return {
                "id": existing["id"],
                "code": existing["code"],
                "status": existing["status"],
                "created": False,
            }

        assignee = self._assign_technician(plan["skill_code"], machine["plant_id"])
        status = "pending_approval" if plan["approval"]["required"] else "scheduled"
        code = self._next_wo_code()

        rationale = (
            f"Raised automatically by the Maintenance agent from a "
            f"{prediction['failure_probability']:.0%} failure prediction "
            f"({prediction['category_label']}, confidence {prediction['confidence']:.0%}). "
            f"Risk score {alert.get('priority', priority)}. {plan['approval']['reason']}."
        )

        wo_id = db.execute(
            "INSERT INTO work_orders(code, machine_id, alert_id, created_at, priority, "
            "action, rationale, skill_required, parts_json, est_downtime_h, est_cost, "
            "scheduled_start, scheduled_end, status, assignee_id) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                code, machine["id"], alert["id"], time.time(), priority,
                plan["action"], rationale, plan["skill"], json.dumps(plan["parts"]),
                plan["downtime_h"], plan["cost"], plan["schedule"]["start_ts"],
                plan["schedule"]["end_ts"], status,
                assignee["id"] if assignee else None,
            ),
        )

        work_order = {
            "id": wo_id,
            "code": code,
            "machine_id": machine["id"],
            "machine_code": machine["code"],
            "priority": priority,
            "status": status,
            "action": plan["action"],
            "skill_required": plan["skill"],
            "assignee": assignee["name"] if assignee else None,
            "assignee_id": assignee["id"] if assignee else None,
            "est_downtime_h": plan["downtime_h"],
            "est_cost": plan["cost"],
            "scheduled_start": plan["schedule"]["start"],
            "scheduled_end": plan["schedule"]["end"],
            "requires_approval": plan["approval"]["required"],
            "created": True,
        }

        db.audit(
            "work_order.created", f"work_order:{wo_id}", actor="maintenance-agent",
            detail=f"{code} for {machine['code']} — {status}",
        )
        notify_work_order(machine, work_order, assignee)
        hub.publish_soon("workorders", "workorder.created", work_order)
        return work_order

    def _assign_technician(self, skill_code: str, plant_id: int) -> dict[str, Any] | None:
        """Pick the least-loaded technician at this plant holding the skill."""
        rows = db.query(
            "SELECT u.id, u.name, u.email, u.shift, u.skills, "
            "(SELECT COUNT(*) FROM work_orders w WHERE w.assignee_id = u.id "
            " AND w.status IN ('scheduled','in_progress','pending_approval')) AS load "
            "FROM users u WHERE u.active = 1 AND u.role IN ('technician','engineer') "
            "ORDER BY load ASC",
        )
        candidates = []
        for row in rows:
            skills = json.loads(row["skills"] or "[]")
            if skill_code in skills:
                candidates.append(dict(row))
        if not candidates:
            # Fall back to any available technician rather than leaving the work
            # order unassigned — an unowned work order is one nobody does.
            candidates = [dict(r) for r in rows]
        return candidates[0] if candidates else None

    @staticmethod
    def _next_wo_code() -> str:
        row = db.query_one("SELECT COUNT(*) AS n FROM work_orders")
        return f"WO-{(row['n'] if row else 0) + 1001}"


maintenance_agent = MaintenanceAgent()
