"""Alerts, work orders, notifications and feedback — the human workflow surface.

Every state change here is audited and pushed to subscribed clients, so the
alert tracker and work-order board stay live without polling.
"""

from __future__ import annotations

import json
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from .. import db
from ..agents.notifier import notify_user
from ..realtime import hub
from ..schemas import AlertActionRequest, FeedbackRequest, WorkOrderUpdateRequest
from ..security import current_user, require_role

router = APIRouter(prefix="/api", tags=["workflow"])

SEVERITY_ORDER = (
    "CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 "
    "WHEN 'medium' THEN 2 ELSE 3 END"
)


# --- alerts ----------------------------------------------------------------


@router.get("/alerts")
def list_alerts(
    user: dict = Depends(current_user),
    status: str | None = Query(default=None),
    severity: str | None = Query(default=None),
    machine_id: int | None = None,
    limit: int = Query(default=100, ge=1, le=500),
) -> dict:
    sql = (
        "SELECT a.id, a.ts, a.severity, a.title, a.detail, a.status, a.machine_id, "
        "a.ack_at, a.resolved_at, a.evidence_json, a.prediction_id, "
        "m.code AS machine_code, m.name AS machine_name, m.criticality, m.retrofit, "
        "p.name AS plant_name, "
        "ack.name AS ack_by_name, res.name AS resolved_by_name, "
        "(SELECT code FROM work_orders w WHERE w.alert_id = a.id "
        " ORDER BY w.created_at DESC LIMIT 1) AS work_order_code "
        "FROM alerts a JOIN machines m ON m.id = a.machine_id "
        "JOIN plants p ON p.id = m.plant_id "
        "LEFT JOIN users ack ON ack.id = a.ack_by "
        "LEFT JOIN users res ON res.id = a.resolved_by WHERE 1=1 "
    )
    params: list[Any] = []
    if status:
        sql += "AND a.status = ? "
        params.append(status)
    if severity:
        sql += "AND a.severity = ? "
        params.append(severity)
    if machine_id:
        sql += "AND a.machine_id = ? "
        params.append(machine_id)
    sql += f"ORDER BY {SEVERITY_ORDER}, a.ts DESC LIMIT ?"
    params.append(limit)

    alerts = db.rows_to_dicts(db.query(sql, params))
    for alert in alerts:
        try:
            alert["evidence"] = json.loads(alert.pop("evidence_json") or "{}")
        except json.JSONDecodeError:
            alert["evidence"] = {}
        alert["retrofit"] = bool(alert["retrofit"])

    counts = db.query_one(
        "SELECT COUNT(*) AS total, "
        "SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open, "
        "SUM(CASE WHEN status='acknowledged' THEN 1 ELSE 0 END) AS acknowledged, "
        "SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) AS resolved, "
        "SUM(CASE WHEN severity='critical' AND status IN ('open','acknowledged') "
        "THEN 1 ELSE 0 END) AS critical_open FROM alerts"
    )
    return {"alerts": alerts, "counts": dict(counts) if counts else {}}


def _alert_or_404(alert_id: int) -> dict[str, Any]:
    row = db.query_one(
        "SELECT a.*, m.code AS machine_code, m.name AS machine_name "
        "FROM alerts a JOIN machines m ON m.id = a.machine_id WHERE a.id = ?",
        (alert_id,),
    )
    if row is None:
        raise HTTPException(404, "alert not found")
    return dict(row)


@router.post("/alerts/{alert_id}/acknowledge")
def acknowledge_alert(
    alert_id: int,
    payload: AlertActionRequest,
    user: dict = Depends(require_role("technician")),
) -> dict:
    alert = _alert_or_404(alert_id)
    if alert["status"] in ("resolved", "suppressed"):
        raise HTTPException(409, f"alert is already {alert['status']}")

    db.execute(
        "UPDATE alerts SET status='acknowledged', ack_by=?, ack_at=? WHERE id=?",
        (user["id"], time.time(), alert_id),
    )
    db.audit(
        "alert.acknowledged", f"alert:{alert_id}", user_id=user["id"],
        actor=user["email"], detail=payload.note[:200],
    )
    hub.publish_soon(
        "alerts", "alert.acknowledged",
        {"id": alert_id, "by": user["name"], "machine_code": alert["machine_code"]},
    )
    return {"ok": True, "alert_id": alert_id, "status": "acknowledged"}


@router.post("/alerts/{alert_id}/resolve")
def resolve_alert(
    alert_id: int,
    payload: AlertActionRequest,
    user: dict = Depends(require_role("technician")),
) -> dict:
    alert = _alert_or_404(alert_id)
    if alert["status"] == "resolved":
        raise HTTPException(409, "alert is already resolved")

    db.execute(
        "UPDATE alerts SET status='resolved', resolved_by=?, resolved_at=? WHERE id=?",
        (user["id"], time.time(), alert_id),
    )
    db.audit(
        "alert.resolved", f"alert:{alert_id}", user_id=user["id"],
        actor=user["email"], detail=payload.note[:200],
    )
    hub.publish_soon(
        "alerts", "alert.resolved",
        {"id": alert_id, "by": user["name"], "machine_code": alert["machine_code"]},
    )
    return {"ok": True, "alert_id": alert_id, "status": "resolved"}


# --- work orders -----------------------------------------------------------


@router.get("/work-orders")
def list_work_orders(
    user: dict = Depends(current_user),
    status: str | None = None,
    machine_id: int | None = None,
    assignee_id: int | None = None,
    limit: int = Query(default=200, ge=1, le=500),
) -> dict:
    sql = (
        "SELECT w.*, m.code AS machine_code, m.name AS machine_name, "
        "m.criticality, m.retrofit, p.name AS plant_name, "
        "u.name AS assignee_name, u.email AS assignee_email, "
        "app.name AS approved_by_name, a.severity AS alert_severity "
        "FROM work_orders w JOIN machines m ON m.id = w.machine_id "
        "JOIN plants p ON p.id = m.plant_id "
        "LEFT JOIN users u ON u.id = w.assignee_id "
        "LEFT JOIN users app ON app.id = w.approved_by "
        "LEFT JOIN alerts a ON a.id = w.alert_id WHERE 1=1 "
    )
    params: list[Any] = []
    if status:
        sql += "AND w.status = ? "
        params.append(status)
    if machine_id:
        sql += "AND w.machine_id = ? "
        params.append(machine_id)
    if assignee_id:
        sql += "AND w.assignee_id = ? "
        params.append(assignee_id)
    sql += (
        "ORDER BY CASE w.priority WHEN 'P1' THEN 0 WHEN 'P2' THEN 1 "
        "WHEN 'P3' THEN 2 ELSE 3 END, w.created_at DESC LIMIT ?"
    )
    params.append(limit)

    orders = db.rows_to_dicts(db.query(sql, params))
    for order in orders:
        try:
            order["parts"] = json.loads(order.pop("parts_json") or "[]")
        except json.JSONDecodeError:
            order["parts"] = []
        order["retrofit"] = bool(order["retrofit"])

    counts = db.query_one(
        "SELECT COUNT(*) AS total, "
        "SUM(CASE WHEN status='pending_approval' THEN 1 ELSE 0 END) AS pending_approval, "
        "SUM(CASE WHEN status='scheduled' THEN 1 ELSE 0 END) AS scheduled, "
        "SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END) AS in_progress, "
        "SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed, "
        "SUM(CASE WHEN status NOT IN ('completed','cancelled') THEN est_cost ELSE 0 END) "
        "AS open_cost FROM work_orders"
    )
    return {"work_orders": orders, "counts": dict(counts) if counts else {}}


def _work_order_or_404(work_order_id: int) -> dict[str, Any]:
    row = db.query_one(
        "SELECT w.*, m.code AS machine_code, m.name AS machine_name "
        "FROM work_orders w JOIN machines m ON m.id = w.machine_id WHERE w.id = ?",
        (work_order_id,),
    )
    if row is None:
        raise HTTPException(404, "work order not found")
    return dict(row)


@router.post("/work-orders/{work_order_id}/approve")
def approve_work_order(
    work_order_id: int, user: dict = Depends(require_role("manager"))
) -> dict:
    """Human approval gate. Only managers and admins may cross it."""
    order = _work_order_or_404(work_order_id)
    if order["status"] != "pending_approval":
        raise HTTPException(409, f"work order is {order['status']}, not pending approval")

    db.execute(
        "UPDATE work_orders SET status='scheduled', approved_by=?, approved_at=? WHERE id=?",
        (user["id"], time.time(), work_order_id),
    )
    db.audit(
        "work_order.approved", f"work_order:{work_order_id}", user_id=user["id"],
        actor=user["email"], detail=f"{order['code']} on {order['machine_code']}",
    )
    if order["assignee_id"]:
        notify_user(
            order["assignee_id"],
            f"{order['code']} approved — proceed with the work",
            f"{user['name']} approved {order['code']} on {order['machine_code']}. "
            f"Scheduled action: {order['action']}",
            severity="high", ref_type="work_order", ref_id=work_order_id,
        )
    hub.publish_soon(
        "workorders", "workorder.approved",
        {"id": work_order_id, "code": order["code"], "by": user["name"]},
    )
    return {"ok": True, "work_order_id": work_order_id, "status": "scheduled"}


@router.post("/work-orders/{work_order_id}/reject")
def reject_work_order(
    work_order_id: int,
    payload: AlertActionRequest,
    user: dict = Depends(require_role("manager")),
) -> dict:
    order = _work_order_or_404(work_order_id)
    if order["status"] in ("completed", "cancelled"):
        raise HTTPException(409, f"work order is already {order['status']}")

    db.execute(
        "UPDATE work_orders SET status='cancelled', approved_by=?, approved_at=?, "
        "resolution_notes=? WHERE id=?",
        (user["id"], time.time(), f"Rejected: {payload.note}", work_order_id),
    )
    # A rejection is a signal that the prediction was wrong. Recording it as
    # feedback is what closes the loop back to model improvement.
    db.execute(
        "INSERT INTO feedback(ts, user_id, ref_type, ref_id, verdict, note) "
        "VALUES(?,?,?,?,?,?)",
        (time.time(), user["id"], "work_order", work_order_id,
         "wrong_action", payload.note[:1000]),
    )
    db.audit(
        "work_order.rejected", f"work_order:{work_order_id}", user_id=user["id"],
        actor=user["email"], detail=payload.note[:200],
    )
    hub.publish_soon(
        "workorders", "workorder.rejected",
        {"id": work_order_id, "code": order["code"], "by": user["name"]},
    )
    return {"ok": True, "work_order_id": work_order_id, "status": "cancelled"}


@router.patch("/work-orders/{work_order_id}")
def update_work_order(
    work_order_id: int,
    payload: WorkOrderUpdateRequest,
    user: dict = Depends(require_role("technician")),
) -> dict:
    order = _work_order_or_404(work_order_id)

    # A technician may progress work but may not cross the approval gate.
    if (
        payload.status == "scheduled"
        and order["status"] == "pending_approval"
        and user["role"] not in ("manager", "admin")
    ):
        raise HTTPException(
            403, "approving a held work order requires the manager role"
        )

    fields: list[str] = []
    params: list[Any] = []
    for column, value in (
        ("status", payload.status),
        ("assignee_id", payload.assignee_id),
        ("scheduled_start", payload.scheduled_start),
        ("resolution_notes", payload.resolution_notes),
        ("actual_downtime_h", payload.actual_downtime_h),
        ("actual_cost", payload.actual_cost),
    ):
        if value is not None:
            fields.append(f"{column} = ?")
            params.append(value)

    if not fields:
        raise HTTPException(400, "no fields to update")

    if payload.status == "completed":
        fields.append("completed_at = ?")
        params.append(time.time())

    params.append(work_order_id)
    db.execute(f"UPDATE work_orders SET {', '.join(fields)} WHERE id = ?", params)

    # Completing a work order writes maintenance history and closes its alert —
    # the loop from prediction to recorded outcome closes here.
    if payload.status == "completed":
        _complete_work_order(order, payload, user)

    db.audit(
        "work_order.updated", f"work_order:{work_order_id}", user_id=user["id"],
        actor=user["email"], detail=f"status={payload.status}",
    )
    hub.publish_soon(
        "workorders", "workorder.updated",
        {"id": work_order_id, "code": order["code"], "status": payload.status},
    )
    return {"ok": True, "work_order_id": work_order_id}


def _complete_work_order(
    order: dict[str, Any], payload: WorkOrderUpdateRequest, user: dict[str, Any]
) -> None:
    """Write history, close the alert, and heal the machine in the simulator."""
    from ..sim.simulator import simulator

    prediction = db.query_one(
        "SELECT failure_category FROM predictions WHERE machine_id = ? "
        "ORDER BY ts DESC LIMIT 1",
        (order["machine_id"],),
    )
    db.execute(
        "INSERT INTO maintenance_history(machine_id, work_order_id, ts, kind, "
        "description, downtime_hours, cost, technician, parts_json, outcome, "
        "failure_mode) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (
            order["machine_id"], order["id"], time.time(), "predictive",
            payload.resolution_notes or order["action"],
            payload.actual_downtime_h if payload.actual_downtime_h is not None
            else order["est_downtime_h"],
            payload.actual_cost if payload.actual_cost is not None else order["est_cost"],
            user["name"], order["parts_json"], "completed",
            prediction["failure_category"] if prediction else None,
        ),
    )
    if order["alert_id"]:
        db.execute(
            "UPDATE alerts SET status='resolved', resolved_by=?, resolved_at=? "
            "WHERE id = ? AND status != 'resolved'",
            (user["id"], time.time(), order["alert_id"]),
        )

    # The repair actually fixes the machine — the health score recovers on the
    # next cycle, which is what makes the workflow demonstrably end-to-end.
    try:
        simulator.clear_fault(order["machine_id"])
    except KeyError:
        pass

    hub.publish_soon(
        "alerts", "alert.resolved",
        {"id": order["alert_id"], "by": user["name"], "via": order["code"]},
    )


# --- notifications ---------------------------------------------------------


@router.get("/notifications")
def list_notifications(
    user: dict = Depends(current_user),
    unread_only: bool = False,
    limit: int = Query(default=50, ge=1, le=200),
) -> dict:
    sql = "SELECT * FROM notifications WHERE user_id = ? "
    params: list[Any] = [user["id"]]
    if unread_only:
        sql += "AND read_at IS NULL "
    sql += "ORDER BY created_at DESC LIMIT ?"
    params.append(limit)

    notifications = db.rows_to_dicts(db.query(sql, params))
    unread = db.query_one(
        "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL",
        (user["id"],),
    )
    return {
        "notifications": notifications,
        "unread": unread["n"] if unread else 0,
    }


@router.post("/notifications/{notification_id}/read")
def mark_read(notification_id: int, user: dict = Depends(current_user)) -> dict:
    owned = db.query_one(
        "SELECT id FROM notifications WHERE id = ? AND user_id = ?",
        (notification_id, user["id"]),
    )
    if owned is None:
        raise HTTPException(404, "notification not found")
    db.execute(
        "UPDATE notifications SET read_at = ? WHERE id = ?",
        (time.time(), notification_id),
    )
    return {"ok": True}


@router.post("/notifications/read-all")
def mark_all_read(user: dict = Depends(current_user)) -> dict:
    db.execute(
        "UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL",
        (time.time(), user["id"]),
    )
    return {"ok": True}


# --- feedback (the adaptation loop) ---------------------------------------


@router.post("/feedback")
def submit_feedback(
    payload: FeedbackRequest, user: dict = Depends(current_user)
) -> dict:
    """Capture human judgement on an AI output.

    This is the platform's adaptation mechanism: false positives and missed
    failures are recorded against the specific prediction, aggregated in the
    analytics view, and are the training signal for the next model refit.
    """
    feedback_id = db.execute(
        "INSERT INTO feedback(ts, user_id, ref_type, ref_id, verdict, note) "
        "VALUES(?,?,?,?,?,?)",
        (time.time(), user["id"], payload.ref_type, payload.ref_id,
         payload.verdict, payload.note),
    )
    db.audit(
        "feedback.submitted", f"{payload.ref_type}:{payload.ref_id}",
        user_id=user["id"], actor=user["email"], detail=payload.verdict,
    )

    # A false positive suppresses the alert so it stops re-firing on the same
    # evidence — otherwise the engineer has told us and nothing changed.
    if payload.ref_type == "alert" and payload.verdict == "false_positive":
        db.execute("UPDATE alerts SET status='suppressed' WHERE id = ?", (payload.ref_id,))
        hub.publish_soon("alerts", "alert.suppressed", {"id": payload.ref_id})

    return {"ok": True, "feedback_id": feedback_id}


@router.get("/feedback/summary")
def feedback_summary(user: dict = Depends(require_role("engineer"))) -> dict:
    rows = db.query(
        "SELECT ref_type, verdict, COUNT(*) AS n FROM feedback "
        "GROUP BY ref_type, verdict ORDER BY n DESC"
    )
    recent = db.rows_to_dicts(db.query(
        "SELECT f.ts, f.ref_type, f.ref_id, f.verdict, f.note, u.name AS user_name "
        "FROM feedback f JOIN users u ON u.id = f.user_id "
        "ORDER BY f.ts DESC LIMIT 25"
    ))
    totals = db.query_one("SELECT COUNT(*) AS total FROM feedback")
    false_positives = db.query_one(
        "SELECT COUNT(*) AS n FROM feedback WHERE verdict = 'false_positive'"
    )
    total = totals["total"] if totals else 0
    fps = false_positives["n"] if false_positives else 0
    return {
        "breakdown": db.rows_to_dicts(rows),
        "recent": recent,
        "total": total,
        "false_positive_rate": round(fps / total, 3) if total else 0.0,
    }


@router.get("/technicians")
def list_technicians(user: dict = Depends(current_user)) -> dict:
    rows = db.query(
        "SELECT u.id, u.name, u.email, u.role, u.skills, u.shift, "
        "(SELECT COUNT(*) FROM work_orders w WHERE w.assignee_id = u.id "
        " AND w.status IN ('scheduled','in_progress','pending_approval')) AS open_jobs "
        "FROM users u WHERE u.active = 1 AND u.role IN ('technician','engineer') "
        "ORDER BY open_jobs ASC"
    )
    technicians = db.rows_to_dicts(rows)
    for technician in technicians:
        technician["skills"] = json.loads(technician["skills"] or "[]")
    return {"technicians": technicians}
