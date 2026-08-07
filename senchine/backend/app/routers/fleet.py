"""Fleet, machine and sensor endpoints."""

from __future__ import annotations

import json
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from .. import db
from ..agents.monitoring import monitoring_agent
from ..agents.prediction import prediction_agent
from ..ml.fusion import confidence_band
from ..ml.mlp import CATEGORY_LABELS
from ..security import current_user
from ..sim.profiles import ARCHETYPE_BY_KEY
from ..sim.simulator import simulator

router = APIRouter(prefix="/api", tags=["fleet"])


def _latest_join_sql() -> str:
    """Machines joined to their most recent health snapshot and prediction."""
    return """
    SELECT m.id, m.code, m.name, m.machine_type, m.industry, m.criticality,
           m.retrofit, m.manufacturer, m.model, m.install_year, m.rated_power_kw,
           m.line, m.status, m.notes, m.plant_id,
           p.name AS plant_name, p.location AS plant_location,
           hs.health_score, hs.anomaly_score, hs.confidence, hs.ts AS health_ts,
           pr.failure_prob, pr.rul_hours, pr.confidence AS pred_confidence,
           pr.failure_category, pr.root_cause, pr.ts AS pred_ts,
           (SELECT COUNT(*) FROM alerts a WHERE a.machine_id = m.id
            AND a.status IN ('open','acknowledged')) AS open_alerts,
           (SELECT COUNT(*) FROM work_orders w WHERE w.machine_id = m.id
            AND w.status NOT IN ('completed','cancelled')) AS open_work_orders
    FROM machines m
    JOIN plants p ON p.id = m.plant_id
    LEFT JOIN health_snapshots hs ON hs.id = (
        SELECT id FROM health_snapshots WHERE machine_id = m.id ORDER BY ts DESC LIMIT 1)
    LEFT JOIN predictions pr ON pr.id = (
        SELECT id FROM predictions WHERE machine_id = m.id ORDER BY ts DESC LIMIT 1)
    """


def _decorate(row: dict[str, Any]) -> dict[str, Any]:
    """Add presentation fields the UI needs without recomputing them client-side."""
    health = row.get("health_score")
    row["retrofit"] = bool(row["retrofit"])
    row["health_band"] = (
        "unknown" if health is None
        else "healthy" if health >= 80
        else "watch" if health >= 62
        else "degraded" if health >= 42
        else "critical"
    )
    row["confidence_band"] = (
        confidence_band(row["confidence"]) if row.get("confidence") is not None else "unknown"
    )
    if row.get("failure_category"):
        row["category_label"] = CATEGORY_LABELS.get(
            row["failure_category"], row["failure_category"]
        )
    archetype = ARCHETYPE_BY_KEY.get(row["machine_type"])
    if archetype:
        row["hourly_downtime_cost"] = archetype.hourly_downtime_cost
        row["mtbf_hours"] = archetype.mtbf_hours
    return row


@router.get("/fleet")
def fleet(
    user: dict = Depends(current_user),
    plant_id: int | None = None,
    industry: str | None = None,
    band: str | None = None,
    retrofit: bool | None = None,
    search: str | None = None,
) -> dict:
    """The fleet grid. Every field is read from persisted state."""
    rows = db.rows_to_dicts(db.query(_latest_join_sql() + " ORDER BY m.code"))
    machines = [_decorate(r) for r in rows]

    if plant_id is not None:
        machines = [m for m in machines if m["plant_id"] == plant_id]
    if industry:
        machines = [m for m in machines if m["industry"] == industry]
    if band:
        machines = [m for m in machines if m["health_band"] == band]
    if retrofit is not None:
        machines = [m for m in machines if m["retrofit"] is retrofit]
    if search:
        needle = search.lower()
        machines = [
            m for m in machines
            if needle in m["code"].lower()
            or needle in m["name"].lower()
            or needle in m["plant_name"].lower()
        ]

    scored = [m for m in machines if m["health_score"] is not None]
    return {
        "machines": machines,
        "summary": {
            "total": len(machines),
            "monitored": len(scored),
            "retrofit": sum(1 for m in machines if m["retrofit"]),
            "avg_health": round(
                sum(m["health_score"] for m in scored) / len(scored), 1
            ) if scored else None,
            "bands": {
                band_name: sum(1 for m in machines if m["health_band"] == band_name)
                for band_name in ("healthy", "watch", "degraded", "critical", "unknown")
            },
            "open_alerts": sum(m["open_alerts"] for m in machines),
            "open_work_orders": sum(m["open_work_orders"] for m in machines),
        },
    }


@router.get("/plants")
def plants(user: dict = Depends(current_user)) -> dict:
    rows = db.query(
        "SELECT p.id, p.name, p.industry, p.location, COUNT(m.id) AS machines, "
        "SUM(m.retrofit) AS retrofits FROM plants p "
        "LEFT JOIN machines m ON m.plant_id = p.id GROUP BY p.id ORDER BY p.name"
    )
    return {"plants": db.rows_to_dicts(rows)}


@router.get("/machines/{machine_id}")
def machine_detail(machine_id: int, user: dict = Depends(current_user)) -> dict:
    row = db.query_one(_latest_join_sql() + " WHERE m.id = ?", (machine_id,))
    if row is None:
        raise HTTPException(404, "machine not found")
    machine = _decorate(dict(row))

    sensors = db.rows_to_dicts(db.query(
        "SELECT id, tag, kind, unit, source, device, placement, distance_m, nominal, "
        "warn_high, crit_high, status, last_seen FROM sensors WHERE machine_id = ? "
        "ORDER BY kind",
        (machine_id,),
    ))

    # Attach the live window from the hot ring buffer.
    for sensor in sensors:
        window = simulator.sensor_window(sensor["id"])
        sensor["series"] = [
            {"ts": ts, "value": value, "quality": quality}
            for ts, value, quality in window[-48:]
        ]
        present = [v for _, v, _ in window if v is not None]
        sensor["current"] = round(present[-1], 3) if present else None

    history = db.rows_to_dicts(db.query(
        "SELECT ts, health_score, anomaly_score, confidence FROM health_snapshots "
        "WHERE machine_id = ? ORDER BY ts DESC LIMIT 120",
        (machine_id,),
    ))
    history.reverse()

    alerts = db.rows_to_dicts(db.query(
        "SELECT id, ts, severity, title, detail, status, evidence_json "
        "FROM alerts WHERE machine_id = ? ORDER BY ts DESC LIMIT 20",
        (machine_id,),
    ))
    for alert in alerts:
        try:
            alert["evidence"] = json.loads(alert.pop("evidence_json") or "{}")
        except json.JSONDecodeError:
            alert["evidence"] = {}

    work_orders = db.rows_to_dicts(db.query(
        "SELECT w.*, u.name AS assignee_name FROM work_orders w "
        "LEFT JOIN users u ON u.id = w.assignee_id "
        "WHERE w.machine_id = ? ORDER BY w.created_at DESC LIMIT 20",
        (machine_id,),
    ))
    for wo in work_orders:
        try:
            wo["parts"] = json.loads(wo.pop("parts_json") or "[]")
        except json.JSONDecodeError:
            wo["parts"] = []

    maintenance = db.rows_to_dicts(db.query(
        "SELECT ts, kind, description, downtime_hours, cost, technician, outcome, "
        "failure_mode FROM maintenance_history WHERE machine_id = ? "
        "ORDER BY ts DESC LIMIT 40",
        (machine_id,),
    ))

    prediction = db.query_one(
        "SELECT * FROM predictions WHERE machine_id = ? ORDER BY ts DESC LIMIT 1",
        (machine_id,),
    )
    explanation = []
    if prediction:
        try:
            explanation = json.loads(prediction["explanation_json"] or "[]")
        except json.JSONDecodeError:
            explanation = []

    snapshot = db.query_one(
        "SELECT fusion_json, sensors_json, ts FROM health_snapshots "
        "WHERE machine_id = ? ORDER BY ts DESC LIMIT 1",
        (machine_id,),
    )
    fusion = {}
    if snapshot:
        try:
            fusion = json.loads(snapshot["fusion_json"] or "{}")
        except json.JSONDecodeError:
            fusion = {}

    return {
        "machine": machine,
        "sensors": sensors,
        "health_history": history,
        "alerts": alerts,
        "work_orders": work_orders,
        "maintenance_history": maintenance,
        "explanation": explanation,
        "fusion": fusion,
        "simulator_state": (
            simulator.machine_state(machine_id) if machine_id in simulator.machines else None
        ),
    }


@router.post("/machines/{machine_id}/analyze")
def analyze_now(machine_id: int, user: dict = Depends(current_user)) -> dict:
    """Force a full Monitoring -> Prediction pass on demand.

    Exposed so an engineer can re-run the analysis after an intervention rather
    than waiting for the next scheduled cycle.
    """
    if machine_id not in simulator.machines:
        raise HTTPException(404, "machine not found in the live fleet")

    monitoring = monitoring_agent.run(machine_id=machine_id)
    if not monitoring.ok:
        raise HTTPException(500, f"monitoring failed: {monitoring.error}")

    prediction = prediction_agent.run(machine_id=machine_id, snapshot=monitoring.data)
    if not prediction.ok:
        raise HTTPException(500, f"prediction failed: {prediction.error}")

    db.audit(
        "machine.analyze", f"machine:{machine_id}", user_id=user["id"],
        actor=user["email"], detail="on-demand analysis",
    )
    return {
        "monitoring": monitoring.data,
        "prediction": prediction.data,
        "duration_ms": round(monitoring.duration_ms + prediction.duration_ms, 2),
    }


@router.get("/machines/{machine_id}/fusion")
def fusion_detail(machine_id: int, user: dict = Depends(current_user)) -> dict:
    """Live EdgeSense fusion breakdown — the retrofit explainability view."""
    machine = db.query_one(
        "SELECT id, code, name, retrofit FROM machines WHERE id = ?", (machine_id,)
    )
    if machine is None:
        raise HTTPException(404, "machine not found")
    if machine_id not in simulator.machines:
        raise HTTPException(409, "machine is not in the live fleet")

    outcome = monitoring_agent.run(machine_id=machine_id, trace=False)
    if not outcome.ok:
        raise HTTPException(500, f"monitoring failed: {outcome.error}")

    data = outcome.data
    return {
        "machine": {
            "id": machine["id"], "code": machine["code"],
            "name": machine["name"], "retrofit": bool(machine["retrofit"]),
        },
        "mode": data["fusion"]["mode"],
        "confidence": data["confidence"],
        "confidence_band": data["confidence_band"],
        "channels": data["fusion"]["channels"],
        "contributions": data["fusion"]["contributions"],
        "missing_channels": data["fusion"]["missing_channels"],
        "sensors": data["sensors"],
        "features": data["features"],
        "health_score": data["health_score"],
        "anomaly_score": data["anomaly_score"],
        "ts": data["ts"],
    }


@router.get("/sensors/{sensor_id}/readings")
def sensor_readings(
    sensor_id: int,
    limit: int = Query(default=120, ge=1, le=500),
    user: dict = Depends(current_user),
) -> dict:
    sensor = db.query_one(
        "SELECT s.*, m.code AS machine_code FROM sensors s "
        "JOIN machines m ON m.id = s.machine_id WHERE s.id = ?",
        (sensor_id,),
    )
    if sensor is None:
        raise HTTPException(404, "sensor not found")

    rows = db.query(
        "SELECT ts, value, quality FROM readings WHERE sensor_id = ? "
        "ORDER BY ts DESC LIMIT ?",
        (sensor_id, limit),
    )
    readings = db.rows_to_dicts(rows)
    readings.reverse()
    return {"sensor": dict(sensor), "readings": readings}
