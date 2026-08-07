"""Hybrid retrieval — live structured state plus the unstructured knowledge corpus.

A Copilot for a live plant cannot answer from documents alone. "Why is M-102
critical?" is answered by *this second's* telemetry, prediction and alerts — not
by a manual. Equally, "what does bearing spalling look like?" is answered by the
corpus, not by telemetry.

So retrieval runs two channels and merges them:

* **Structured** — deterministic SQL against the live tables. Exact, current,
  never paraphrased. This is what supplies every number the answer quotes.
* **Unstructured** — BM25 over manuals, SOPs, failure-mode references and
  maintenance history, for the procedural and explanatory context.

Both channels produce *citations*. Every fact the Copilot states is traceable to
one of them, which is what makes the grounding guarantee enforceable rather than
aspirational.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any

from .. import db
from ..ml.mlp import CATEGORY_LABELS
from .store import extract_identifiers, index

MACHINE_CODE_RE = re.compile(r"\b([A-Z]{1,3}-\d{2,4})\b", re.IGNORECASE)

# Question intents the structured channel knows how to serve directly.
INTENT_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("highest_risk", re.compile(
        r"(?i)\b(highest|top|worst|most)\s+(risk|critical|urgent|dangerous|at.risk)|"
        r"\brisk(iest)?\s+machines?\b|\bwhich machines?\b.*\b(risk|attention|fail)")),
    ("this_week", re.compile(
        r"(?i)\b(this|next|coming)\s+(week|7\s*days)\b|\bpredict.*\bweek\b")),
    ("todays_alerts", re.compile(
        r"(?i)\b(today|todays|today's|current|open|active)\b.*\balerts?\b|"
        r"\balerts?\b.*\b(today|now|open|active)\b")),
    ("executive_summary", re.compile(
        r"(?i)\b(executive|management|board)\b.*\b(summary|brief|report)\b|"
        r"\bsummar(y|ise|ize)\b.*\b(fleet|plant|operations?)\b")),
    ("maintenance_report", re.compile(
        r"(?i)\bmaintenance\s+(report|history|record)|\bwork\s+orders?\b.*\breport\b")),
    # Plurals matter: "suggest preventive actions" is the phrasing users
    # actually type, and `\baction\b` does not match "actions".
    ("preventive", re.compile(
        r"(?i)\b(preventive|preventative|proactive)\b.*"
        r"\b(actions?|measures?|steps?|maintenance|recommendations?)\b|"
        r"\bhow (do|can) (i|we) (prevent|avoid)\b")),
    ("explain_signal", re.compile(
        r"(?i)\bexplain\b.*\b(vibration|temperature|current|spike|reading|anomaly|trend)\b|"
        r"\b(vibration|temperature|current)\s+spike\b")),
    ("machine_detail", re.compile(
        r"(?i)\bwhy\b.*\b(critical|failing|risk|alert|degraded)\b|\bwhat.s wrong\b|"
        r"\bstatus of\b|\btell me about\b")),
    ("cost", re.compile(
        r"(?i)\b(cost|budget|spend|savings?|roi|downtime cost)\b")),
]


def detect_intent(question: str) -> str:
    for name, pattern in INTENT_PATTERNS:
        if pattern.search(question):
            return name
    return "general"


def resolve_machines(question: str) -> list[dict[str, Any]]:
    """Find machines referenced by code or by name in the question."""
    found: dict[int, dict[str, Any]] = {}

    for code in {c.upper() for c in MACHINE_CODE_RE.findall(question)} | set(
        extract_identifiers(question)
    ):
        row = db.query_one(
            "SELECT m.*, p.name AS plant_name, p.industry FROM machines m "
            "JOIN plants p ON p.id = m.plant_id WHERE UPPER(m.code) = ?",
            (code,),
        )
        if row:
            found[row["id"]] = dict(row)

    if not found:
        # Fall back to a name match, so "the Pune weld cell" resolves too.
        lowered = question.lower()
        for row in db.query(
            "SELECT m.*, p.name AS plant_name, p.industry FROM machines m "
            "JOIN plants p ON p.id = m.plant_id"
        ):
            if row["name"].lower() in lowered:
                found[row["id"]] = dict(row)
    return list(found.values())


# --- structured retrieval --------------------------------------------------


def machine_state(machine_id: int) -> dict[str, Any] | None:
    """Current live state of one machine, assembled from the durable tables."""
    machine = db.query_one(
        "SELECT m.*, p.name AS plant_name, p.industry FROM machines m "
        "JOIN plants p ON p.id = m.plant_id WHERE m.id = ?",
        (machine_id,),
    )
    if machine is None:
        return None

    health = db.query_one(
        "SELECT * FROM health_snapshots WHERE machine_id = ? ORDER BY ts DESC LIMIT 1",
        (machine_id,),
    )
    prediction = db.query_one(
        "SELECT * FROM predictions WHERE machine_id = ? ORDER BY ts DESC LIMIT 1",
        (machine_id,),
    )
    alerts = db.query(
        "SELECT id, ts, severity, title, detail, status FROM alerts "
        "WHERE machine_id = ? AND status IN ('open','acknowledged') ORDER BY ts DESC LIMIT 5",
        (machine_id,),
    )
    work_orders = db.query(
        "SELECT code, priority, status, action, est_downtime_h, est_cost, "
        "scheduled_start, skill_required FROM work_orders "
        "WHERE machine_id = ? AND status NOT IN ('completed','cancelled') "
        "ORDER BY created_at DESC LIMIT 5",
        (machine_id,),
    )
    history = db.query(
        "SELECT ts, kind, description, downtime_hours, cost, failure_mode "
        "FROM maintenance_history WHERE machine_id = ? ORDER BY ts DESC LIMIT 5",
        (machine_id,),
    )

    return {
        "machine": dict(machine),
        "health": dict(health) if health else None,
        "prediction": dict(prediction) if prediction else None,
        "alerts": db.rows_to_dicts(alerts),
        "work_orders": db.rows_to_dicts(work_orders),
        "history": db.rows_to_dicts(history),
    }


def fleet_risk_table(limit: int = 8) -> list[dict[str, Any]]:
    """Machines ranked by current risk, from the latest prediction per machine."""
    rows = db.query(
        """
        SELECT m.id, m.code, m.name, m.criticality, m.retrofit, p.name AS plant_name,
               pr.failure_prob, pr.rul_hours, pr.confidence, pr.failure_category,
               pr.root_cause, pr.ts AS pred_ts, hs.health_score, hs.anomaly_score
        FROM machines m
        JOIN plants p ON p.id = m.plant_id
        LEFT JOIN predictions pr ON pr.id = (
            SELECT id FROM predictions WHERE machine_id = m.id ORDER BY ts DESC LIMIT 1)
        LEFT JOIN health_snapshots hs ON hs.id = (
            SELECT id FROM health_snapshots WHERE machine_id = m.id ORDER BY ts DESC LIMIT 1)
        WHERE pr.failure_prob IS NOT NULL
        ORDER BY pr.failure_prob DESC, hs.health_score ASC
        LIMIT ?
        """,
        (limit,),
    )
    return db.rows_to_dicts(rows)


def open_alerts(limit: int = 12, since_hours: float | None = None) -> list[dict[str, Any]]:
    params: list[Any] = []
    sql = (
        "SELECT a.id, a.ts, a.severity, a.title, a.detail, a.status, "
        "m.code AS machine_code, m.name AS machine_name, p.name AS plant_name "
        "FROM alerts a JOIN machines m ON m.id = a.machine_id "
        "JOIN plants p ON p.id = m.plant_id "
        "WHERE a.status IN ('open','acknowledged') "
    )
    if since_hours:
        sql += "AND a.ts >= ? "
        params.append(time.time() - since_hours * 3600)
    sql += (
        "ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 "
        "WHEN 'medium' THEN 2 ELSE 3 END, a.ts DESC LIMIT ?"
    )
    params.append(limit)
    return db.rows_to_dicts(db.query(sql, params))


def predictions_within(hours: float, limit: int = 12) -> list[dict[str, Any]]:
    rows = db.query(
        """
        SELECT m.code, m.name, m.criticality, p.name AS plant_name,
               pr.failure_prob, pr.rul_hours, pr.confidence, pr.failure_category, pr.ts
        FROM predictions pr
        JOIN machines m ON m.id = pr.machine_id
        JOIN plants p ON p.id = m.plant_id
        WHERE pr.id = (SELECT id FROM predictions WHERE machine_id = m.id
                       ORDER BY ts DESC LIMIT 1)
          AND pr.rul_hours <= ? AND pr.failure_prob >= 0.25
        ORDER BY pr.rul_hours ASC LIMIT ?
        """,
        (hours, limit),
    )
    return db.rows_to_dicts(rows)


def fleet_summary() -> dict[str, Any]:
    """Portfolio-level numbers used by the executive-summary intent."""
    totals = db.query_one(
        "SELECT COUNT(*) AS machines, SUM(retrofit) AS retrofits FROM machines"
    )
    health = db.query_one(
        """
        SELECT AVG(hs.health_score) AS avg_health,
               SUM(CASE WHEN hs.health_score < 42 THEN 1 ELSE 0 END) AS critical_count,
               SUM(CASE WHEN hs.health_score < 62 THEN 1 ELSE 0 END) AS degraded_count
        FROM health_snapshots hs
        WHERE hs.id = (SELECT id FROM health_snapshots WHERE machine_id = hs.machine_id
                       ORDER BY ts DESC LIMIT 1)
        """
    )
    alerts = db.query_one(
        "SELECT COUNT(*) AS open_alerts, "
        "SUM(CASE WHEN severity='critical' THEN 1 ELSE 0 END) AS critical_alerts "
        "FROM alerts WHERE status IN ('open','acknowledged')"
    )
    work = db.query_one(
        "SELECT COUNT(*) AS open_wo, "
        "SUM(CASE WHEN status='pending_approval' THEN 1 ELSE 0 END) AS pending, "
        "SUM(est_cost) AS planned_cost, SUM(est_downtime_h) AS planned_downtime "
        "FROM work_orders WHERE status NOT IN ('completed','cancelled')"
    )
    completed = db.query_one(
        "SELECT COUNT(*) AS n, SUM(cost) AS spend, SUM(downtime_hours) AS downtime "
        "FROM maintenance_history WHERE ts >= ?",
        (time.time() - 90 * 86400,),
    )
    return {
        "machines": totals["machines"] if totals else 0,
        "retrofitted": (totals["retrofits"] or 0) if totals else 0,
        "avg_health": round(health["avg_health"] or 0, 1) if health else 0,
        "critical_machines": (health["critical_count"] or 0) if health else 0,
        "degraded_machines": (health["degraded_count"] or 0) if health else 0,
        "open_alerts": (alerts["open_alerts"] or 0) if alerts else 0,
        "critical_alerts": (alerts["critical_alerts"] or 0) if alerts else 0,
        "open_work_orders": (work["open_wo"] or 0) if work else 0,
        "pending_approval": (work["pending"] or 0) if work else 0,
        "planned_cost": round((work["planned_cost"] or 0), 2) if work else 0,
        "planned_downtime_h": round((work["planned_downtime"] or 0), 1) if work else 0,
        "completed_90d": (completed["n"] or 0) if completed else 0,
        "spend_90d": round((completed["spend"] or 0), 2) if completed else 0,
        "downtime_90d_h": round((completed["downtime"] or 0), 1) if completed else 0,
    }


# --- assembly --------------------------------------------------------------


def _fmt_ts(ts: float | None) -> str:
    if not ts:
        return "unknown"
    return time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(ts))


def build_context(question: str, max_docs: int = 5) -> dict[str, Any]:
    """Assemble everything needed to answer, with citations attached."""
    intent = detect_intent(question)
    machines = resolve_machines(question)
    citations: list[dict[str, Any]] = []
    blocks: list[str] = []
    structured: dict[str, Any] = {"intent": intent}

    # --- structured channel ---
    if machines:
        states = []
        for machine in machines[:3]:
            state = machine_state(machine["id"])
            if not state:
                continue
            states.append(state)
            blocks.append(_render_machine_state(state))
            citations.append(
                {
                    "type": "live_telemetry",
                    "ref": state["machine"]["code"],
                    "title": f"Live state — {state['machine']['name']} ({state['machine']['code']})",
                    "as_of": _fmt_ts(state["health"]["ts"] if state["health"] else None),
                }
            )
        structured["machines"] = states

    if intent in ("highest_risk", "general", "executive_summary") and not machines:
        table = fleet_risk_table()
        if table:
            structured["risk_table"] = table
            blocks.append(_render_risk_table(table))
            citations.append(
                {"type": "live_prediction", "ref": "fleet", "title": "Fleet risk ranking",
                 "as_of": _fmt_ts(time.time())}
            )

    if intent in ("todays_alerts", "executive_summary"):
        alerts = open_alerts(since_hours=24 if intent == "todays_alerts" else None)
        structured["alerts"] = alerts
        if alerts:
            blocks.append(_render_alerts(alerts))
            citations.append(
                {"type": "alert_register", "ref": "alerts", "title": "Open alert register",
                 "as_of": _fmt_ts(time.time())}
            )

    if intent == "this_week":
        upcoming = predictions_within(168)
        structured["this_week"] = upcoming
        blocks.append(_render_upcoming(upcoming))
        citations.append(
            {"type": "live_prediction", "ref": "7d", "title": "Predictions inside 7 days",
             "as_of": _fmt_ts(time.time())}
        )

    if intent in ("executive_summary", "cost", "maintenance_report", "general"):
        summary = fleet_summary()
        structured["fleet_summary"] = summary
        blocks.append(_render_fleet_summary(summary))
        citations.append(
            {"type": "fleet_kpi", "ref": "fleet", "title": "Fleet KPI rollup",
             "as_of": _fmt_ts(time.time())}
        )

    if intent == "maintenance_report":
        history = db.rows_to_dicts(db.query(
            "SELECT h.ts, h.kind, h.description, h.downtime_hours, h.cost, h.failure_mode, "
            "m.code AS machine_code FROM maintenance_history h "
            "JOIN machines m ON m.id = h.machine_id ORDER BY h.ts DESC LIMIT 12"
        ))
        structured["history"] = history
        if history:
            blocks.append(_render_history(history))
            citations.append(
                {"type": "maintenance_history", "ref": "history",
                 "title": "Recent maintenance history", "as_of": _fmt_ts(time.time())}
            )

    # --- unstructured channel ---
    machine_id = machines[0]["id"] if len(machines) == 1 else None
    hits = index.search(question, top_k=max_docs, machine_id=machine_id)
    for hit in hits:
        blocks.append(
            f"[KNOWLEDGE — {hit['title']} ({hit['source']})]\n{hit['text']}"
        )
        citations.append(
            {
                "type": "document",
                "ref": f"doc:{hit['doc_id']}#{hit['chunk_id']}",
                "title": hit["title"],
                "source": hit["source"],
                "score": hit["score"],
            }
        )
    structured["documents"] = hits

    return {
        "intent": intent,
        "evidence_text": "\n\n---\n\n".join(blocks),
        "citations": citations,
        "structured": structured,
        "machines_referenced": [m["code"] for m in machines],
    }


# --- renderers (deterministic, so numbers are never paraphrased) -----------


def _render_machine_state(state: dict[str, Any]) -> str:
    machine = state["machine"]
    health = state["health"]
    prediction = state["prediction"]

    lines = [
        f"[LIVE MACHINE STATE — {machine['code']}]",
        f"Name: {machine['name']} | Type: {machine['machine_type']} | "
        f"Plant: {machine['plant_name']} ({machine['industry']})",
        f"Criticality: {machine['criticality']} | "
        f"Instrumentation: {'EdgeSense retrofit (no onboard sensors)' if machine['retrofit'] else 'onboard IoT'}",
        f"Rated power: {machine['rated_power_kw']} kW | Installed: {machine['install_year']}",
    ]
    if health:
        lines.append(
            f"Health score: {health['health_score']:.1f}/100 | "
            f"Anomaly score: {health['anomaly_score']:.2f} | "
            f"Evidence confidence: {health['confidence']:.2f} "
            f"(as of {_fmt_ts(health['ts'])})"
        )
    if prediction:
        lines.append(
            f"Failure probability: {prediction['failure_prob']:.0%} | "
            f"RUL: {prediction['rul_hours']:.0f} h | "
            f"Predicted mode: {CATEGORY_LABELS.get(prediction['failure_category'], prediction['failure_category'])} | "
            f"Model confidence: {prediction['confidence']:.0%}"
        )
        lines.append(f"Root cause analysis: {prediction['root_cause']}")
        try:
            factors = json.loads(prediction["explanation_json"] or "[]")
            if factors:
                lines.append(
                    "Top contributing signals: "
                    + "; ".join(
                        f"{f['label']} {f['shap_value']:+.3f} "
                        f"(observed {f['observed']:.2f}x nominal)"
                        for f in factors[:4]
                    )
                )
        except (json.JSONDecodeError, KeyError, TypeError):
            pass

    if state["alerts"]:
        lines.append("Open alerts:")
        for alert in state["alerts"]:
            lines.append(
                f"  - [{alert['severity']}] {alert['title']} "
                f"(raised {_fmt_ts(alert['ts'])}, status {alert['status']})"
            )
    if state["work_orders"]:
        lines.append("Open work orders:")
        for wo in state["work_orders"]:
            lines.append(
                f"  - {wo['code']} [{wo['priority']}/{wo['status']}] {wo['action'][:110]} "
                f"| {wo['est_downtime_h']:.1f} h | {wo['est_cost']:,.0f} | "
                f"skill: {wo['skill_required']}"
            )
    if state["history"]:
        lines.append("Recent maintenance history:")
        for h in state["history"]:
            lines.append(
                f"  - {_fmt_ts(h['ts'])} [{h['kind']}] {h['description']} "
                f"({h['downtime_hours']:.1f} h, {h['cost']:,.0f}"
                + (f", mode: {h['failure_mode']}" if h["failure_mode"] else "")
                + ")"
            )
    return "\n".join(lines)


def _render_risk_table(rows: list[dict[str, Any]]) -> str:
    lines = ["[FLEET RISK RANKING — highest predicted failure probability first]"]
    for r in rows:
        lines.append(
            f"  {r['code']} ({r['name']}, {r['plant_name']}): "
            f"P(fail)={r['failure_prob']:.0%}, RUL={r['rul_hours']:.0f} h, "
            f"health={r['health_score']:.0f}/100, "
            f"mode={CATEGORY_LABELS.get(r['failure_category'], r['failure_category'])}, "
            f"criticality={r['criticality']}, confidence={r['confidence']:.0%}"
            + (" [EdgeSense retrofit]" if r["retrofit"] else "")
        )
    return "\n".join(lines)


def _render_alerts(rows: list[dict[str, Any]]) -> str:
    lines = ["[OPEN ALERT REGISTER]"]
    for a in rows:
        lines.append(
            f"  #{a['id']} [{a['severity']}] {a['machine_code']} — {a['title']} "
            f"| status {a['status']} | raised {_fmt_ts(a['ts'])}"
        )
    return "\n".join(lines)


def _render_upcoming(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return (
            "[PREDICTIONS WITHIN 7 DAYS]\n  None. No machine currently has a "
            "failure probability at or above 25% with remaining useful life "
            "inside 168 hours."
        )
    lines = ["[PREDICTIONS WITHIN 7 DAYS]"]
    for r in rows:
        lines.append(
            f"  {r['code']} ({r['plant_name']}): {r['failure_prob']:.0%} probability, "
            f"RUL {r['rul_hours']:.0f} h, "
            f"{CATEGORY_LABELS.get(r['failure_category'], r['failure_category'])}, "
            f"criticality {r['criticality']}, confidence {r['confidence']:.0%}"
        )
    return "\n".join(lines)


def _render_fleet_summary(s: dict[str, Any]) -> str:
    return (
        "[FLEET KPI ROLLUP]\n"
        f"  Machines monitored: {s['machines']} ({s['retrofitted']} via EdgeSense retrofit)\n"
        f"  Average health score: {s['avg_health']}/100\n"
        f"  Machines in critical band: {s['critical_machines']}; degraded or worse: "
        f"{s['degraded_machines']}\n"
        f"  Open alerts: {s['open_alerts']} (critical: {s['critical_alerts']})\n"
        f"  Open work orders: {s['open_work_orders']} "
        f"(awaiting human approval: {s['pending_approval']})\n"
        f"  Planned maintenance cost: {s['planned_cost']:,.0f}; "
        f"planned downtime: {s['planned_downtime_h']} h\n"
        f"  Completed in last 90 days: {s['completed_90d']} jobs, "
        f"spend {s['spend_90d']:,.0f}, downtime {s['downtime_90d_h']} h"
    )


def _render_history(rows: list[dict[str, Any]]) -> str:
    lines = ["[RECENT MAINTENANCE HISTORY]"]
    for h in rows:
        lines.append(
            f"  {_fmt_ts(h['ts'])} {h['machine_code']} [{h['kind']}] {h['description']} "
            f"({h['downtime_hours']:.1f} h, {h['cost']:,.0f})"
        )
    return "\n".join(lines)
