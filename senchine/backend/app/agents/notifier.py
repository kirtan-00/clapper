"""Notification routing — getting an alert to the person who can act on it.

An alert nobody sees is not an alert. Routing rules, in order:

1. **Skill match** — the technician who can actually do the job.
2. **Ownership** — engineers and managers at the affected plant.
3. **Escalation by severity** — critical alerts additionally reach plant
   management, because a P1 that sits unacknowledged is the failure mode this
   product exists to prevent.

Channel selection follows severity: everything lands in the in-app inbox; high
and critical also emit email; critical also emits SMS. Email and SMS are recorded
as outbox rows rather than actually dispatched — wiring a real SMTP/Twilio
provider is a credential change in one place, not a design change.
"""

from __future__ import annotations

import json
import time
from typing import Any

from .. import db
from ..guardrails import redact
from ..realtime import hub

SEVERITY_CHANNELS: dict[str, tuple[str, ...]] = {
    "critical": ("inapp", "email", "sms"),
    "high": ("inapp", "email"),
    "medium": ("inapp",),
    "low": ("inapp",),
}


def _recipients_for_machine(
    machine: Any, skill_code: str | None = None, severity: str = "medium"
) -> list[dict[str, Any]]:
    """Resolve who should hear about this, deduplicated by user id."""
    chosen: dict[int, dict[str, Any]] = {}

    def add(row: Any, reason: str) -> None:
        record = dict(row)
        if record["id"] not in chosen:
            record["reason"] = reason
            chosen[record["id"]] = record

    # 1. Skill-matched technicians.
    if skill_code:
        for row in db.query(
            "SELECT id, name, email, role, skills, phone FROM users "
            "WHERE active = 1 AND role IN ('technician','engineer')"
        ):
            if skill_code in json.loads(row["skills"] or "[]"):
                add(row, f"holds required skill '{skill_code}'")

    # 2. Plant owners — engineers and managers responsible for this asset.
    for row in db.query(
        "SELECT id, name, email, role, skills, phone FROM users "
        "WHERE active = 1 AND role IN ('engineer','manager') "
        "AND (plant_id = ? OR plant_id IS NULL)",
        (machine["plant_id"],),
    ):
        add(row, "responsible for this plant")

    # 3. Severity escalation.
    if severity == "critical":
        for row in db.query(
            "SELECT id, name, email, role, skills, phone FROM users "
            "WHERE active = 1 AND role IN ('manager','admin')"
        ):
            add(row, "critical-severity escalation")

    return list(chosen.values())


def _deliver(
    user: dict[str, Any],
    subject: str,
    body: str,
    severity: str,
    ref_type: str,
    ref_id: int,
) -> list[int]:
    """Write one notification row per channel and push the in-app one live."""
    channels = SEVERITY_CHANNELS.get(severity, ("inapp",))
    safe_body = redact(body)
    created: list[int] = []

    for channel in channels:
        # Do not attempt a channel the user has no address for.
        if channel == "sms" and not user.get("phone"):
            continue
        notification_id = db.execute(
            "INSERT INTO notifications(user_id, channel, subject, body, severity, "
            "ref_type, ref_id, created_at, delivered) VALUES(?,?,?,?,?,?,?,?,?)",
            (
                user["id"], channel, subject, safe_body, severity,
                ref_type, ref_id, time.time(), 1,
            ),
        )
        created.append(notification_id)

        if channel == "inapp":
            hub.publish_soon(
                f"user:{user['id']}",
                "notification.new",
                {
                    "id": notification_id,
                    "subject": subject,
                    "body": safe_body,
                    "severity": severity,
                    "ref_type": ref_type,
                    "ref_id": ref_id,
                    "reason": user.get("reason"),
                    "ts": time.time(),
                },
            )
    return created


def notify_alert(
    machine: Any, alert: dict[str, Any], prediction: dict[str, Any]
) -> list[int]:
    """Route a new or escalated alert to the responsible people."""
    severity = alert["severity"]
    recipients = _recipients_for_machine(machine, severity=severity)

    subject = f"[{severity.upper()}] {alert['title']}"
    body = (
        f"Machine: {machine['name']} ({machine['code']}) at {machine['plant_name']}\n"
        f"Predicted failure: {prediction['category_label']}\n"
        f"Probability: {prediction['failure_probability']:.0%} "
        f"(confidence {prediction['confidence']:.0%})\n"
        f"Remaining useful life: {prediction['rul_display']}\n\n"
        f"Root cause: {prediction['root_cause']}\n\n"
        f"Raised by the Senchine Maintenance agent."
    )

    created: list[int] = []
    for user in recipients:
        created.extend(_deliver(user, subject, body, severity, "alert", alert["id"]))

    db.audit(
        "notification.alert",
        f"alert:{alert['id']}",
        actor="notifier",
        detail=f"{len(recipients)} recipients, severity {severity}",
    )
    return created


def notify_work_order(
    machine: Any, work_order: dict[str, Any], assignee: dict[str, Any] | None
) -> list[int]:
    """Notify the assignee, and planners when approval is required."""
    severity = {"P1": "critical", "P2": "high", "P3": "medium", "P4": "low"}.get(
        work_order["priority"], "medium"
    )
    created: list[int] = []

    if assignee:
        subject = f"Work order {work_order['code']} assigned to you — {machine['code']}"
        body = (
            f"Priority: {work_order['priority']}\n"
            f"Machine: {machine['name']} ({machine['code']})\n"
            f"Action: {work_order['action']}\n"
            f"Skill required: {work_order['skill_required']}\n"
            f"Scheduled: {work_order['scheduled_start']} "
            f"({work_order['est_downtime_h']:.1f} h)\n"
            f"Estimated cost: {work_order['est_cost']:,.0f}\n"
            f"Status: {work_order['status']}"
        )
        created.extend(
            _deliver(assignee, subject, body, severity, "work_order", work_order["id"])
        )

    if work_order.get("requires_approval"):
        approvers = db.query(
            "SELECT id, name, email, role, skills, phone FROM users "
            "WHERE active = 1 AND role IN ('manager','admin')"
        )
        subject = f"Approval needed: {work_order['code']} on {machine['code']}"
        body = (
            f"The Maintenance agent has drafted work order {work_order['code']} but "
            f"cannot schedule it autonomously.\n\n"
            f"Priority: {work_order['priority']}\n"
            f"Machine: {machine['name']} ({machine['code']})\n"
            f"Estimated downtime: {work_order['est_downtime_h']:.1f} h\n"
            f"Estimated cost: {work_order['est_cost']:,.0f}\n"
            f"Proposed action: {work_order['action']}\n\n"
            f"Review and approve in the Work Orders board."
        )
        for row in approvers:
            created.extend(
                _deliver(dict(row), subject, body, severity, "work_order", work_order["id"])
            )

    return created


def notify_user(
    user_id: int, subject: str, body: str, severity: str = "medium",
    ref_type: str = "system", ref_id: int = 0,
) -> list[int]:
    """Direct notification, used by human-initiated workflow actions."""
    row = db.query_one(
        "SELECT id, name, email, role, phone FROM users WHERE id = ? AND active = 1",
        (user_id,),
    )
    if row is None:
        return []
    return _deliver(dict(row), subject, body, severity, ref_type, ref_id)
