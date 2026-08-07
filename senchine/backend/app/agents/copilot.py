"""Agent 4 — AI Copilot.

Responsibilities
----------------
Natural-language assistant for engineers and managers, aware of live dashboard
context, answering with human-friendly explanations grounded in real records.

The answer pipeline
-------------------
    question
      -> intent detection + entity resolution
      -> hybrid retrieval (live structured state + BM25 knowledge corpus)
      -> safety pre-screen on the *question*
      -> generation (Claude, or the deterministic composer)
      -> guardrails: redaction, safety screen, numeric-claim verification
      -> grounding verdict + citations
      -> answer

The guardrail stage runs on the output of *both* generation paths. That matters:
the safety properties of this agent do not depend on which path served the
request, so an outage cannot silently downgrade them.

Dashboard context awareness: the UI passes the machine the user is currently
looking at, so "why is this one critical?" resolves without the user retyping a
machine code.
"""

from __future__ import annotations

import time
from typing import Any

from .. import db
from ..guardrails import (
    enforce_grounding,
    redact,
    safe_or_refusal,
    screen_recommendation,
    unverified_numbers,
)
from ..llm.client import llm_client
from ..llm.composer import compose
from ..rag.retriever import build_context
from .base import Agent

SUGGESTED_QUESTIONS: list[str] = [
    "Show the highest risk machines",
    "Summarize today's alerts",
    "Predict failures this week",
    "Generate an executive summary",
    "Generate a maintenance report",
    "Suggest preventive actions",
]


class CopilotAgent(Agent):
    name = "copilot"
    description = (
        "Natural-language assistant answering questions about equipment health, "
        "predictions and maintenance, grounded in live records with citations."
    )
    consumes = ("question", "dashboard_context")
    produces = ("answer", "citations", "grounding_verdict")

    def execute(
        self,
        *,
        question: str,
        user: dict[str, Any],
        machine_id: int | None = None,
        **_: Any,
    ) -> tuple[dict[str, Any], str]:
        started = time.perf_counter()
        question = (question or "").strip()
        if not question:
            raise ValueError("question must not be empty")
        if len(question) > 2000:
            question = question[:2000]

        # Dashboard context: resolve "this machine" without the user retyping it.
        enriched = question
        if machine_id:
            row = db.query_one("SELECT code, name FROM machines WHERE id = ?", (machine_id,))
            if row and row["code"].lower() not in question.lower():
                enriched = f"{question} (regarding machine {row['code']} — {row['name']})"

        context = build_context(enriched)

        # Pre-screen the *question*. A user asking how to bypass an interlock gets
        # a safe answer without ever reaching the model.
        question_safe, unsafe_reason = screen_recommendation(question)
        if not question_safe:
            answer, _ = safe_or_refusal(question)
            result = self._envelope(
                question=question,
                answer=answer,
                context=context,
                source="guardrail",
                blocked=True,
                block_reason=unsafe_reason,
                started=started,
            )
            return result, f"blocked unsafe request: {unsafe_reason}"

        role = user.get("role", "engineer")
        model_result = llm_client.complete(
            question=enriched,
            evidence=context["evidence_text"],
            role=role,
            intent=context["intent"],
        )

        if model_result:
            raw_answer = model_result["answer"]
            source = "claude-cached" if model_result.get("cached") else "claude"
            usage = model_result.get("usage")
            model_name = model_result.get("model")
        else:
            raw_answer = compose(enriched, context, role)
            source = "deterministic-composer"
            usage = None
            model_name = None

        # Guardrails run identically on both paths.
        answer, blocked = safe_or_refusal(raw_answer)
        answer = redact(answer)
        suspect_numbers = (
            unverified_numbers(answer, context["evidence_text"]) if not blocked else []
        )

        result = self._envelope(
            question=question,
            answer=answer,
            context=context,
            source=source,
            blocked=blocked,
            block_reason="unsafe recommendation removed" if blocked else None,
            started=started,
            usage=usage,
            model=model_name,
            suspect_numbers=suspect_numbers,
        )

        summary = (
            f"[{context['intent']}] {source} -> "
            f"{len(context['citations'])} citations, "
            f"{'grounded' if result['grounded'] else 'unverified'}"
        )
        return result, summary

    # -- helpers ------------------------------------------------------------

    def _envelope(
        self,
        *,
        question: str,
        answer: str,
        context: dict[str, Any],
        source: str,
        blocked: bool,
        block_reason: str | None,
        started: float,
        usage: dict[str, Any] | None = None,
        model: str | None = None,
        suspect_numbers: list[str] | None = None,
    ) -> dict[str, Any]:
        grounding = enforce_grounding(answer, context["citations"])
        suspect = suspect_numbers or []

        return {
            "question": question,
            "answer": grounding["answer"],
            "grounded": grounding["grounded"],
            "confidence_label": grounding["confidence_label"],
            "citations": context["citations"],
            "citation_count": len(context["citations"]),
            "intent": context["intent"],
            "machines_referenced": context["machines_referenced"],
            "source": source,
            "model": model,
            "usage": usage,
            "safety": {
                "blocked": blocked,
                "reason": block_reason,
            },
            "verification": {
                # Figures in the answer that could not be traced back to the
                # retrieved evidence. Surfaced, not silently accepted.
                "unverified_numbers": suspect,
                "verified": not suspect,
            },
            "latency_ms": round((time.perf_counter() - started) * 1000, 1),
            "suggested_followups": self._followups(context),
            "ts": time.time(),
        }

    @staticmethod
    def _followups(context: dict[str, Any]) -> list[str]:
        """Context-aware next questions, so the UI can offer real continuations."""
        intent = context["intent"]
        machines = context["machines_referenced"]

        if machines:
            code = machines[0]
            return [
                f"What preventive actions should we take on {code}?",
                f"Explain the top contributing signal on {code}",
                f"Show the maintenance history for {code}",
            ]
        by_intent = {
            "highest_risk": [
                "Predict failures this week",
                "Generate an executive summary",
                "What preventive actions should we take?",
            ],
            "todays_alerts": [
                "Show the highest risk machines",
                "Which alerts are still unacknowledged?",
                "Generate a maintenance report",
            ],
            "executive_summary": [
                "Which work orders need my approval?",
                "Show the highest risk machines",
                "What is our planned maintenance spend?",
            ],
            "this_week": [
                "Suggest preventive actions",
                "Generate a maintenance report",
                "Show the highest risk machines",
            ],
        }
        return by_intent.get(intent, SUGGESTED_QUESTIONS[:3])


copilot_agent = CopilotAgent()
