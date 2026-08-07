"""Analytics, Copilot, agent telemetry and simulation control."""

from __future__ import annotations

import json
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from .. import db
from ..agents.copilot import SUGGESTED_QUESTIONS, copilot_agent
from ..agents.orchestrator import orchestrator
from ..config import settings
from ..llm.client import llm_client
from ..ml import detectability
from ..ml.mlp import CATEGORY_LABELS
from ..ml.registry import registry
from ..rag.store import index
from ..realtime import hub
from ..schemas import CopilotRequest, InjectFaultRequest, SensorFaultRequest
from ..security import current_user, require_role
from ..sim.simulator import simulator

router = APIRouter(prefix="/api", tags=["insights"])


# --- Copilot ---------------------------------------------------------------


@router.post("/copilot/ask")
def copilot_ask(payload: CopilotRequest, user: dict = Depends(current_user)) -> dict:
    outcome = copilot_agent.run(
        question=payload.question,
        user=user,
        machine_id=payload.machine_id,
    )
    if not outcome.ok:
        raise HTTPException(500, f"copilot failed: {outcome.error}")

    db.audit(
        "copilot.query", "copilot", user_id=user["id"], actor=user["email"],
        detail=payload.question[:200],
    )
    return outcome.data


@router.get("/copilot/suggestions")
def copilot_suggestions(user: dict = Depends(current_user)) -> dict:
    return {
        "suggestions": SUGGESTED_QUESTIONS,
        "llm": {
            "enabled": llm_client.available,
            "model": settings.llm_model if llm_client.available else None,
            "mode": "claude" if llm_client.available else "deterministic-composer",
        },
    }


# --- analytics -------------------------------------------------------------


@router.get("/analytics/overview")
def analytics_overview(user: dict = Depends(current_user)) -> dict:
    """Dashboard KPIs. Every figure is computed from persisted records."""
    now = time.time()

    machines = db.query_one(
        "SELECT COUNT(*) AS total, SUM(retrofit) AS retrofit FROM machines"
    )
    health = db.query_one(
        """
        SELECT AVG(health_score) AS avg_health, MIN(health_score) AS worst,
               SUM(CASE WHEN health_score < 42 THEN 1 ELSE 0 END) AS critical,
               SUM(CASE WHEN health_score >= 42 AND health_score < 62 THEN 1 ELSE 0 END) AS degraded,
               SUM(CASE WHEN health_score >= 62 AND health_score < 80 THEN 1 ELSE 0 END) AS watch,
               SUM(CASE WHEN health_score >= 80 THEN 1 ELSE 0 END) AS healthy,
               AVG(confidence) AS avg_confidence
        FROM health_snapshots hs
        WHERE hs.id = (SELECT id FROM health_snapshots
                       WHERE machine_id = hs.machine_id ORDER BY ts DESC LIMIT 1)
        """
    )
    alerts = db.query_one(
        "SELECT COUNT(*) AS total, "
        "SUM(CASE WHEN status IN ('open','acknowledged') THEN 1 ELSE 0 END) AS open, "
        "SUM(CASE WHEN severity='critical' AND status IN ('open','acknowledged') "
        "  THEN 1 ELSE 0 END) AS critical_open, "
        "SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS last_24h FROM alerts",
        (now - 86400,),
    )
    work = db.query_one(
        "SELECT COUNT(*) AS total, "
        "SUM(CASE WHEN status='pending_approval' THEN 1 ELSE 0 END) AS pending, "
        "SUM(CASE WHEN status IN ('scheduled','in_progress') THEN 1 ELSE 0 END) AS active, "
        "SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed, "
        "SUM(CASE WHEN status NOT IN ('completed','cancelled') THEN est_cost ELSE 0 END) "
        "  AS open_cost, "
        "SUM(CASE WHEN status NOT IN ('completed','cancelled') THEN est_downtime_h ELSE 0 END) "
        "  AS open_downtime FROM work_orders"
    )
    history = db.query_one(
        "SELECT COUNT(*) AS jobs, SUM(cost) AS spend, SUM(downtime_hours) AS downtime, "
        "SUM(CASE WHEN kind='corrective' THEN 1 ELSE 0 END) AS reactive, "
        "SUM(CASE WHEN kind IN ('predictive','preventive') THEN 1 ELSE 0 END) AS planned "
        "FROM maintenance_history WHERE ts >= ?",
        (now - 90 * 86400,),
    )

    # Downtime avoided: predicted failures that were caught and planned. Labelled
    # an estimate everywhere it is shown, because it is one.
    avoided = db.query_one(
        "SELECT COUNT(*) AS n, SUM(w.est_downtime_h) AS planned_h, SUM(w.est_cost) AS planned_cost "
        "FROM work_orders w WHERE w.status IN ('scheduled','in_progress','completed')"
    )

    jobs = (history["jobs"] or 0) if history else 0
    reactive = (history["reactive"] or 0) if history else 0
    planned = (history["planned"] or 0) if history else 0

    return {
        "machines": {
            "total": machines["total"] if machines else 0,
            "retrofit": (machines["retrofit"] or 0) if machines else 0,
            "retrofit_pct": round(
                100 * (machines["retrofit"] or 0) / machines["total"], 1
            ) if machines and machines["total"] else 0,
        },
        "health": {
            "avg": round(health["avg_health"], 1) if health and health["avg_health"] else None,
            "worst": round(health["worst"], 1) if health and health["worst"] else None,
            "avg_confidence": round(health["avg_confidence"], 3)
            if health and health["avg_confidence"] else None,
            "bands": {
                "healthy": (health["healthy"] or 0) if health else 0,
                "watch": (health["watch"] or 0) if health else 0,
                "degraded": (health["degraded"] or 0) if health else 0,
                "critical": (health["critical"] or 0) if health else 0,
            },
        },
        "alerts": dict(alerts) if alerts else {},
        "work_orders": {
            **(dict(work) if work else {}),
            "open_cost": round((work["open_cost"] or 0), 2) if work else 0,
            "open_downtime": round((work["open_downtime"] or 0), 1) if work else 0,
        },
        "maintenance_90d": {
            "jobs": jobs,
            "spend": round((history["spend"] or 0), 2) if history else 0,
            "downtime_h": round((history["downtime"] or 0), 1) if history else 0,
            "reactive": reactive,
            "planned": planned,
            # The headline adoption metric: share of work that was planned rather
            # than a response to a breakdown.
            "planned_ratio": round(planned / jobs, 3) if jobs else 0.0,
        },
        "impact_estimate": {
            "interventions_planned": (avoided["n"] or 0) if avoided else 0,
            "planned_downtime_h": round((avoided["planned_h"] or 0), 1) if avoided else 0,
            "planned_cost": round((avoided["planned_cost"] or 0), 2) if avoided else 0,
            "note": (
                "Avoided-cost figures are model estimates derived from predicted "
                "failure probability and each asset's hourly downtime cost. They are "
                "a planning aid, not booked savings."
            ),
        },
        "pipeline": orchestrator.status(),
    }


@router.get("/analytics/trends")
def analytics_trends(
    hours: float = Query(default=6.0, ge=0.25, le=168.0),
    user: dict = Depends(current_user),
) -> dict:
    """Fleet health over time, bucketed for charting."""
    since = time.time() - hours * 3600
    rows = db.query(
        "SELECT ts, health_score, anomaly_score, confidence FROM health_snapshots "
        "WHERE ts >= ? ORDER BY ts ASC",
        (since,),
    )
    if not rows:
        return {"buckets": [], "hours": hours}

    bucket_count = 40
    span = max(1e-6, rows[-1]["ts"] - rows[0]["ts"])
    width = span / bucket_count
    buckets: list[dict[str, Any]] = []
    start = rows[0]["ts"]

    for i in range(bucket_count):
        low, high = start + i * width, start + (i + 1) * width
        window = [r for r in rows if low <= r["ts"] < high] or (
            [rows[-1]] if i == bucket_count - 1 else []
        )
        if not window:
            continue
        buckets.append(
            {
                "ts": low + width / 2,
                "health": round(sum(r["health_score"] for r in window) / len(window), 2),
                "anomaly": round(sum(r["anomaly_score"] for r in window) / len(window), 4),
                "confidence": round(sum(r["confidence"] for r in window) / len(window), 4),
                "samples": len(window),
            }
        )

    categories = db.query(
        "SELECT failure_category, COUNT(*) AS n FROM predictions "
        "WHERE ts >= ? AND failure_prob >= 0.3 GROUP BY failure_category ORDER BY n DESC",
        (since,),
    )
    return {
        "buckets": buckets,
        "hours": hours,
        "failure_mix": [
            {
                "category": r["failure_category"],
                "label": CATEGORY_LABELS.get(r["failure_category"], r["failure_category"]),
                "count": r["n"],
            }
            for r in categories
        ],
    }


@router.get("/analytics/industries")
def analytics_industries(user: dict = Depends(current_user)) -> dict:
    """Cross-industry rollup — evidence the platform is genuinely reusable."""
    rows = db.query(
        """
        SELECT m.industry,
               COUNT(DISTINCT m.id) AS machines,
               SUM(m.retrofit) AS retrofits,
               AVG(hs.health_score) AS avg_health,
               AVG(hs.confidence) AS avg_confidence,
               (SELECT COUNT(*) FROM alerts a JOIN machines m2 ON m2.id = a.machine_id
                WHERE m2.industry = m.industry AND a.status IN ('open','acknowledged'))
               AS open_alerts
        FROM machines m
        LEFT JOIN health_snapshots hs ON hs.id = (
            SELECT id FROM health_snapshots WHERE machine_id = m.id ORDER BY ts DESC LIMIT 1)
        GROUP BY m.industry ORDER BY m.industry
        """
    )
    return {
        "industries": [
            {
                "industry": r["industry"],
                "machines": r["machines"],
                "retrofits": r["retrofits"] or 0,
                "avg_health": round(r["avg_health"], 1) if r["avg_health"] else None,
                "avg_confidence": round(r["avg_confidence"], 3) if r["avg_confidence"] else None,
                "open_alerts": r["open_alerts"],
            }
            for r in rows
        ]
    }


# --- agent + model telemetry ----------------------------------------------


@router.get("/agents")
def agents_status(user: dict = Depends(current_user)) -> dict:
    recent = db.rows_to_dicts(db.query(
        "SELECT ar.ts, ar.agent, ar.machine_id, ar.duration_ms, ar.status, ar.summary, "
        "m.code AS machine_code FROM agent_runs ar "
        "LEFT JOIN machines m ON m.id = ar.machine_id "
        "ORDER BY ar.ts DESC LIMIT 40"
    ))
    stats = db.rows_to_dicts(db.query(
        "SELECT agent, COUNT(*) AS runs, AVG(duration_ms) AS avg_ms, "
        "SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors "
        "FROM agent_runs WHERE ts >= ? GROUP BY agent",
        (time.time() - 3600,),
    ))
    for stat in stats:
        stat["avg_ms"] = round(stat["avg_ms"], 2) if stat["avg_ms"] else 0

    return {
        "manifest": orchestrator.agent_manifest(),
        "pipeline": orchestrator.status(),
        "recent_runs": recent,
        "stats_1h": stats,
        "realtime": hub.stats(),
    }


@router.get("/models")
def models_status(user: dict = Depends(current_user)) -> dict:
    return {
        "registry": registry.metrics(),
        "llm": llm_client.stats(),
        "retrieval": index.stats(),
        "cost_controls": {
            "prompt_caching": "system prompt cached; volatile content after the breakpoint",
            "effort": settings.llm_effort,
            "response_cache_ttl_s": settings.llm_cache_ttl,
            "escalation_gating": (
                "prediction and maintenance run only for machines the monitoring "
                "agent escalates"
            ),
            "retrieval": "BM25 lexical retrieval — no embedding model, no vector store",
        },
    }


@router.get("/audit")
def audit_log(
    user: dict = Depends(require_role("manager")),
    limit: int = Query(default=100, ge=1, le=500),
) -> dict:
    rows = db.query(
        "SELECT ts, actor, action, resource, detail, ip FROM audit_log "
        "ORDER BY ts DESC LIMIT ?",
        (limit,),
    )
    return {"entries": db.rows_to_dicts(rows)}


# --- simulation control (demo surface) ------------------------------------


def _sensor_kinds(machine_id: int) -> list[str]:
    return [
        r["kind"]
        for r in db.query(
            "SELECT DISTINCT kind FROM sensors WHERE machine_id = ?", (machine_id,)
        )
    ]


@router.get("/machines/{machine_id}/detectability")
def machine_detectability(machine_id: int, user: dict = Depends(current_user)) -> dict:
    """Which failure modes this machine's sensor kit can actually resolve."""
    machine = db.query_one(
        "SELECT id, code, name, retrofit FROM machines WHERE id = ?", (machine_id,)
    )
    if machine is None:
        raise HTTPException(404, "machine not found")

    report = detectability.assess(_sensor_kinds(machine_id))
    report["modes"] = [
        {**mode, "label": CATEGORY_LABELS.get(mode["mode"], mode["mode"])}
        for mode in report["modes"]
    ]
    return {
        "machine": {
            "id": machine["id"], "code": machine["code"],
            "name": machine["name"], "retrofit": bool(machine["retrofit"]),
        },
        **report,
    }


def _best_machine_for(
    machines: list[dict[str, Any]], mode: str, retrofit: bool | None = None
) -> dict[str, Any] | None:
    """Pick the machine that can best demonstrate a given failure mode.

    Injecting bearing wear into an asset with no ultrasonic probe produces a
    defensible but muddled diagnosis. Presets should show the platform working,
    so each one targets an asset instrumented to resolve that mode.
    """
    candidates = [
        m for m in machines
        if retrofit is None or bool(m["retrofit"]) is retrofit
    ] or machines
    if not candidates:
        return None

    scored = [
        (
            detectability.mode_detectability(mode, _sensor_kinds(m["id"]))["score"],
            # Prefer a critical asset when detectability ties — a bigger story.
            1 if m["criticality"] == "critical" else 0,
            m,
        )
        for m in candidates
    ]
    scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return scored[0][2]


@router.get("/sim/scenarios")
def scenarios(user: dict = Depends(current_user)) -> dict:
    """Pre-built demo scenarios, so a walkthrough is one click rather than typing."""
    machines = db.rows_to_dicts(db.query(
        "SELECT id, code, name, criticality, retrofit, machine_type FROM machines "
        "ORDER BY retrofit DESC, criticality, code"
    ))

    specs = [
        (
            "bearing_slow", "Bearing wear — gradual", "bearing_wear", False, 0.18, 0.006,
            "The classic predictable failure. Impulsive vibration and ultrasonic "
            "emission rise long before temperature moves. Watch the health score "
            "decay, SHAP isolate the crest factor, and a work order get scheduled "
            "inside the remaining useful life.",
        ),
        (
            "lube_fast", "Lubrication failure — rapid", "lubrication_failure", False, 0.35, 0.018,
            "The fastest mode the platform tracks. Ultrasonic emission spikes first "
            "and remaining life collapses within hours, driving a P1 alert and an "
            "immediate human approval request.",
        ),
        (
            "retrofit_electrical", "EdgeSense retrofit — electrical fault",
            "electrical_fault", True, 0.32, 0.010,
            "A legacy machine with no onboard sensors at all. The fault is detected "
            "purely from fused external devices, and the platform reports lower "
            "confidence to match the weaker evidence rather than hiding it.",
        ),
        (
            "thermal_runaway", "Thermal overload", "overheating", False, 0.30, 0.012,
            "Cooling loss. Temperature rise over ambient dominates the attribution, "
            "showing that the explanation tracks the physical mechanism rather than "
            "the loudest raw signal.",
        ),
    ]

    presets = []
    for preset_id, title, category, retrofit, severity, progression, description in specs:
        machine = _best_machine_for(machines, category, retrofit=retrofit)
        if machine is None:
            continue
        coverage = detectability.mode_detectability(category, _sensor_kinds(machine["id"]))
        presets.append(
            {
                "id": preset_id,
                "title": title,
                "description": description,
                "machine_id": machine["id"],
                "machine_code": machine["code"],
                "machine_name": machine["name"],
                "retrofit": bool(machine["retrofit"]),
                "category": category,
                "category_label": CATEGORY_LABELS.get(category, category),
                "severity": severity,
                "progression": progression,
                "detectability": coverage,
            }
        )

    return {
        "failure_categories": [
            {"value": key, "label": label}
            for key, label in CATEGORY_LABELS.items()
            if key != "healthy"
        ],
        "machines": machines,
        "presets": presets,
    }


@router.post("/sim/inject")
def inject_fault(
    payload: InjectFaultRequest, user: dict = Depends(require_role("engineer"))
) -> dict:
    try:
        state = simulator.inject_fault(
            payload.machine_id, payload.category,
            severity=payload.severity, progression=payload.progression,
            label=payload.label,
        )
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    db.audit(
        "sim.inject", f"machine:{payload.machine_id}", user_id=user["id"],
        actor=user["email"],
        detail=f"{payload.category} severity={payload.severity}",
    )
    hub.publish_soon("fleet", "sim.fault_injected", state)
    return {"ok": True, "state": state}


@router.post("/sim/clear/{machine_id}")
def clear_fault(machine_id: int, user: dict = Depends(require_role("engineer"))) -> dict:
    try:
        state = simulator.clear_fault(machine_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc

    db.audit(
        "sim.clear", f"machine:{machine_id}", user_id=user["id"], actor=user["email"]
    )
    hub.publish_soon("fleet", "sim.fault_cleared", state)
    return {"ok": True, "state": state}


@router.post("/sim/sensor-fault")
def fail_sensor(
    payload: SensorFaultRequest, user: dict = Depends(require_role("engineer"))
) -> dict:
    """Fail a sensor deliberately, to demonstrate degradation handling."""
    try:
        simulator.fail_sensor(payload.sensor_id, payload.status, payload.ticks)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc

    db.audit(
        "sim.sensor_fault", f"sensor:{payload.sensor_id}", user_id=user["id"],
        actor=user["email"], detail=payload.status,
    )
    return {"ok": True, "sensor_id": payload.sensor_id, "status": payload.status}


@router.post("/sim/pause")
def pause_pipeline(
    paused: bool = True, user: dict = Depends(require_role("engineer"))
) -> dict:
    orchestrator.paused = paused
    db.audit(
        "pipeline.pause" if paused else "pipeline.resume", "pipeline",
        user_id=user["id"], actor=user["email"],
    )
    return {"ok": True, "paused": orchestrator.paused}


@router.get("/sim/state")
def sim_state(user: dict = Depends(current_user)) -> dict:
    return {
        "fleet": simulator.fleet_summary(),
        "machines": [
            simulator.machine_state(mid) for mid in simulator.machines
        ],
        "pipeline": orchestrator.status(),
    }
