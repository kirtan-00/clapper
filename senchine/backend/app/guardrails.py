"""Guardrails for the AI layer.

Four independent controls, applied at different points:

1. **Output redaction** — strip credentials, keys and personal contact details
   from anything leaving the system, whether authored by a model or a human.
2. **Unsafe-recommendation blocking** — the Copilot must never tell an operator
   to bypass an interlock, disable a trip, or run a machine to failure. These
   are the recommendations that injure people, so they are refused structurally
   rather than left to prompt discipline.
3. **Authority limits** — the AI proposes; a human disposes. Work orders above a
   cost/impact threshold, and anything touching a critical asset, require human
   approval before they can be scheduled. Encoded here, enforced in the router.
4. **Grounding enforcement** — a Copilot answer must cite retrieved evidence.
   An answer with no citations is downgraded and labelled, so an ungrounded
   claim can never present with the same authority as a grounded one.

These run regardless of whether the answer came from Claude or from the
deterministic fallback composer, so the safety properties do not depend on which
path served the request.
"""

from __future__ import annotations

import re
from typing import Any

# --- 1. Sensitive-data redaction ------------------------------------------

REDACTION_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\b(sk-ant-[A-Za-z0-9_\-]{8,})"), "[REDACTED_API_KEY]"),
    (re.compile(r"\b(sk-[A-Za-z0-9]{20,})"), "[REDACTED_API_KEY]"),
    (re.compile(r"(?i)\b(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*\S+"),
     r"\1: [REDACTED]"),
    (re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b"), "[REDACTED_EMAIL]"),
    (re.compile(r"\b(?:\+?\d{1,3}[ -]?)?(?:\(\d{2,4}\)[ -]?)?\d{3,4}[ -]?\d{4}\b"),
     "[REDACTED_PHONE]"),
    (re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b"), "[REDACTED_IP]"),
]


def redact(text: str) -> str:
    """Remove secrets and personal contact details from outbound text."""
    if not text:
        return text
    out = text
    for pattern, replacement in REDACTION_PATTERNS:
        out = pattern.sub(replacement, out)
    return out


# --- 2. Unsafe recommendations --------------------------------------------

UNSAFE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(?i)\b(bypass|disable|override|defeat|jumper)\b.{0,40}"
                r"\b(interlock|safety|guard|e-?stop|emergency stop|trip|protection|relay)\b"),
     "bypassing a safety interlock or protective trip"),
    (re.compile(r"(?i)\b(ignore|suppress|silence|mute)\b.{0,30}"
                r"\b(alarm|trip|shutdown|protection)\b"),
     "suppressing a protective alarm or trip"),
    (re.compile(r"(?i)\brun (it |the machine )?(to|until) (failure|destruction|it breaks)\b"),
     "running an asset to destruction"),
    (re.compile(r"(?i)\b(raise|increase|lift)\b.{0,30}\b(trip|limit|setpoint)\b.{0,30}"
                r"\b(to (avoid|prevent|stop))\b.{0,20}\b(trip|alarm|shutdown)\b"),
     "raising a protective setpoint to mask a fault"),
    (re.compile(r"(?i)\bwork on\b.{0,30}\b(live|energi[sz]ed|running)\b.{0,20}"
                r"\b(machine|equipment|panel|motor)\b"),
     "working on live or running equipment"),
    (re.compile(r"(?i)\b(skip|omit|forgo)\b.{0,30}\b(lockout|tagout|loto|isolation|permit)\b"),
     "skipping lockout/tagout or isolation"),
]

SAFETY_REFUSAL = (
    "I can't recommend that. It would involve {reason}, which is a personnel-safety "
    "control. If the protection is tripping, the correct path is to treat the trip "
    "as a genuine fault: isolate the asset under lockout/tagout, raise a work order, "
    "and have a qualified technician investigate the root cause. I can raise that "
    "work order now if you want."
)


def screen_recommendation(text: str) -> tuple[bool, str | None]:
    """Return `(is_safe, reason)` for a proposed recommendation."""
    for pattern, reason in UNSAFE_PATTERNS:
        if pattern.search(text or ""):
            return False, reason
    return True, None


def safe_or_refusal(text: str) -> tuple[str, bool]:
    """Return `(text, was_blocked)`, substituting a refusal when unsafe."""
    ok, reason = screen_recommendation(text)
    if ok:
        return redact(text), False
    return SAFETY_REFUSAL.format(reason=reason), True


# --- 3. Autonomy / authority limits ---------------------------------------

# Above these thresholds the platform will not act on its own.
AUTO_APPROVE_MAX_COST = 2500.0
AUTO_APPROVE_MAX_DOWNTIME_H = 4.0
HUMAN_APPROVAL_CRITICALITY = {"critical"}


def requires_human_approval(
    *,
    estimated_cost: float,
    estimated_downtime_h: float,
    criticality: str,
    confidence: float,
    priority: str,
) -> tuple[bool, str]:
    """Decide whether a proposed work order can be auto-scheduled.

    The bar is deliberately conservative. An autonomous system that schedules
    downtime on a critical asset off a low-confidence prediction destroys trust
    the first time it is wrong, and trust is the actual adoption constraint for
    this category of product.
    """
    reasons: list[str] = []
    if criticality in HUMAN_APPROVAL_CRITICALITY:
        reasons.append("asset is business-critical")
    if estimated_cost > AUTO_APPROVE_MAX_COST:
        reasons.append(f"estimated cost {estimated_cost:,.0f} exceeds auto-approval limit")
    if estimated_downtime_h > AUTO_APPROVE_MAX_DOWNTIME_H:
        reasons.append(
            f"estimated downtime {estimated_downtime_h:.1f} h exceeds auto-approval limit"
        )
    if confidence < 0.6:
        reasons.append(f"model confidence {confidence:.0%} is below the autonomy threshold")
    if priority == "P1":
        reasons.append("P1 interventions always require a planner sign-off")

    if reasons:
        return True, "; ".join(reasons)
    return False, "within autonomous scheduling limits"


# --- 4. Grounding enforcement ---------------------------------------------

MIN_CITATIONS = 1
UNGROUNDED_NOTICE = (
    "\n\n*No supporting record was retrieved for this question, so this answer is "
    "general guidance rather than a statement about your fleet. Treat it as "
    "unverified.*"
)


def enforce_grounding(answer: str, citations: list[dict[str, Any]]) -> dict[str, Any]:
    """Attach a grounding verdict to a Copilot answer."""
    grounded = len(citations) >= MIN_CITATIONS
    text = answer if grounded else answer.rstrip() + UNGROUNDED_NOTICE
    return {
        "answer": text,
        "grounded": grounded,
        "citation_count": len(citations),
        "confidence_label": "grounded" if grounded else "unverified",
    }


# --- Numeric-claim verification -------------------------------------------

NUMBER_RE = re.compile(r"\b\d+(?:\.\d+)?\b")


def unverified_numbers(answer: str, evidence: str) -> list[str]:
    """Find numbers in an answer that do not appear in the retrieved evidence.

    A language model paraphrasing telemetry is exactly where a plausible-looking
    wrong number gets introduced, and on a maintenance floor a wrong number is
    acted on. Any figure not traceable to the evidence is surfaced to the caller
    so the UI can flag it rather than render it as fact.
    """
    if not answer:
        return []
    evidence_numbers = set(NUMBER_RE.findall(evidence or ""))
    suspect: list[str] = []
    for token in NUMBER_RE.findall(answer):
        if token in evidence_numbers:
            continue
        # Ignore small integers — they are almost always counts, list indices or
        # rounded restatements rather than novel factual claims.
        try:
            if float(token) <= 24 and "." not in token:
                continue
        except ValueError:
            continue
        # Tolerate rounding of a figure that is present in the evidence.
        if any(ev.startswith(token[:3]) for ev in evidence_numbers if len(token) >= 3):
            continue
        suspect.append(token)
    return sorted(set(suspect))
