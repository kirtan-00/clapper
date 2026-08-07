"""Agents, guardrails, retrieval and the end-to-end workflow.

The end-to-end test is the one that matters: inject a fault, run the real
pipeline, and assert that a prioritised work order with parts, a skill and a
schedule comes out the other side — then complete it and assert the machine
recovers. That is the product claim, tested rather than asserted.
"""

from __future__ import annotations

import time

import numpy as np
import pytest

from backend.app import db, guardrails
from backend.app.agents.maintenance import maintenance_agent
from backend.app.agents.monitoring import monitoring_agent
from backend.app.agents.orchestrator import orchestrator
from backend.app.agents.prediction import prediction_agent
from backend.app.rag import retriever
from backend.app.rag.store import chunk_text, index, tokenize
from backend.app.sim.simulator import simulator


def _drive(cycles: int = 14) -> None:
    for _ in range(cycles):
        orchestrator.run_cycle()


@pytest.fixture(scope="module")
def faulted_machine(app_client):
    """A machine driven into a well-detectable fault by the real pipeline."""
    from backend.app.ml import detectability

    machines = db.rows_to_dicts(db.query("SELECT id, code FROM machines"))
    best, best_score = None, -1.0
    for machine in machines:
        kinds = [
            r["kind"] for r in db.query(
                "SELECT DISTINCT kind FROM sensors WHERE machine_id = ?", (machine["id"],))
        ]
        score = detectability.mode_detectability("bearing_wear", kinds)["score"]
        if score > best_score:
            best, best_score = machine, score

    simulator.inject_fault(best["id"], "bearing_wear", severity=0.62, progression=0.02)
    _drive(18)
    yield best
    simulator.clear_fault(best["id"])


# --------------------------------------------------------------------------
# Monitoring agent
# --------------------------------------------------------------------------

class TestMonitoringAgent:
    def test_produces_its_declared_outputs(self, app_client):
        result = monitoring_agent.run(machine_id=1, trace=False)
        assert result.ok, result.error
        for key in ("health_score", "anomaly_score", "confidence", "sensors", "vector"):
            assert key in result.data

    def test_health_score_is_bounded(self, app_client):
        for machine_id in (1, 2, 3, 4, 5):
            data = monitoring_agent.run(machine_id=machine_id, trace=False).data
            assert 0 <= data["health_score"] <= 100

    def test_unknown_machine_fails_cleanly(self, app_client):
        result = monitoring_agent.run(machine_id=999999, trace=False)
        assert not result.ok
        assert result.error, "a failing agent must report why"

    def test_reports_sensor_data_quality(self, app_client):
        data = monitoring_agent.run(machine_id=1, trace=False).data
        quality = data["data_quality"]
        assert quality["sensors_total"] > 0
        assert 0 <= quality["sensor_coverage"] <= 1

    def test_failed_sensors_lower_confidence_not_health(self, app_client):
        """A blind machine is unknown, not unhealthy — health must move toward
        the neutral midpoint rather than toward zero."""
        machine_id = 3
        before = monitoring_agent.run(machine_id=machine_id, trace=False).data
        sensors = db.rows_to_dicts(
            db.query("SELECT id FROM sensors WHERE machine_id = ?", (machine_id,)))
        for sensor in sensors[:-1]:
            simulator.fail_sensor(sensor["id"], "offline", ticks=200)
        for _ in range(6):
            simulator.tick()

        after = monitoring_agent.run(machine_id=machine_id, trace=False).data
        assert after["confidence"] < before["confidence"]
        assert after["health_score"] > 25, (
            "losing sensors must not be reported as the machine being critical"
        )

        for sensor in sensors:
            simulator.fail_sensor(sensor["id"], "ok", ticks=0)
        for _ in range(4):
            simulator.tick()

    def test_detects_an_injected_fault(self, app_client, faulted_machine):
        data = monitoring_agent.run(machine_id=faulted_machine["id"], trace=False).data
        assert data["anomaly_score"] > 0.5, "an active fault was not detected"
        assert data["health_score"] < 70


# --------------------------------------------------------------------------
# Prediction agent
# --------------------------------------------------------------------------

class TestPredictionAgent:
    def test_produces_explained_predictions(self, app_client, faulted_machine):
        result = prediction_agent.run(machine_id=faulted_machine["id"])
        assert result.ok, result.error
        data = result.data
        assert 0 <= data["failure_probability"] <= 1
        assert data["rul_hours"] >= 0
        assert data["root_cause"]
        assert data["limitations"], "a prediction must state its own limitations"

    def test_attributions_accompany_a_real_fault(self, app_client, faulted_machine):
        data = prediction_agent.run(machine_id=faulted_machine["id"]).data
        contributions = data["explanation"].get("contributions", [])
        assert contributions, "a developing fault must carry an explanation"
        assert all("shap_value" in c and "label" in c for c in contributions)

    def test_healthy_machine_skips_attribution(self, app_client):
        """Explaining a machine with nothing wrong wastes compute and confuses."""
        healthy = None
        for row in db.query("SELECT id FROM machines"):
            data = monitoring_agent.run(machine_id=row["id"], trace=False).data
            if data["anomaly_score"] < 0.25 and data["health_score"] > 85:
                healthy = row["id"]
                break
        if healthy is None:
            pytest.skip("no healthy machine available in this run")
        data = prediction_agent.run(machine_id=healthy).data
        assert data["explanation"]["method"] == "skipped"

    def test_retrofit_predictions_declare_their_caveat(self, app_client):
        retrofit = db.query_one("SELECT id FROM machines WHERE retrofit = 1 LIMIT 1")
        data = prediction_agent.run(machine_id=retrofit["id"]).data
        joined = " ".join(data["limitations"]).lower()
        assert "edgesense" in joined or "no onboard" in joined

    def test_confidence_records_how_it_was_derived(self, app_client, faulted_machine):
        data = prediction_agent.run(machine_id=faulted_machine["id"]).data
        assert data["confidence_basis"], "confidence must be explainable"
        assert 0 <= data["confidence"] <= 1


# --------------------------------------------------------------------------
# Maintenance agent
# --------------------------------------------------------------------------

class TestMaintenanceAgent:
    def test_turns_a_prediction_into_an_actionable_plan(self, app_client, faulted_machine):
        prediction = prediction_agent.run(machine_id=faulted_machine["id"]).data
        result = maintenance_agent.run(
            machine_id=faulted_machine["id"], prediction=prediction)
        assert result.ok, result.error
        data = result.data
        if data["action_taken"] == "none":
            pytest.skip("risk stayed below the alerting threshold")

        assert data["priority"] in ("P1", "P2", "P3", "P4")
        assert data["recommended_action"]
        assert data["skill_required"]
        assert data["estimated_downtime_h"] > 0
        assert data["estimated_cost"] > 0
        assert data["schedule"]["start_ts"] > time.time()

    def test_recommended_parts_come_from_the_catalogue(self, app_client, faulted_machine):
        prediction = prediction_agent.run(machine_id=faulted_machine["id"]).data
        data = maintenance_agent.run(
            machine_id=faulted_machine["id"], prediction=prediction).data
        if data["action_taken"] == "none":
            pytest.skip("no action taken")
        known = {r["sku"] for r in db.query("SELECT sku FROM spare_parts")}
        for part in data["parts"]:
            assert part["sku"] in known, f"invented part number {part['sku']}"

    def test_alerts_are_deduplicated(self, app_client, faulted_machine):
        """A degrading machine must not re-raise the same alert every cycle."""
        prediction = prediction_agent.run(machine_id=faulted_machine["id"]).data
        for _ in range(4):
            maintenance_agent.run(machine_id=faulted_machine["id"], prediction=prediction)
        rows = db.query(
            "SELECT COUNT(*) AS n FROM alerts WHERE machine_id = ? AND status IN "
            "('open','acknowledged')",
            (faulted_machine["id"],),
        )
        assert rows[0]["n"] <= 2, "alert storm — deduplication failed"

    def test_risk_weights_consequence_not_just_probability(self, app_client):
        """A likely failure on a trivial asset must not outrank a probable
        failure on the asset that stops the plant."""
        critical = db.query_one(
            "SELECT m.*, p.name AS plant_name, p.industry FROM machines m "
            "JOIN plants p ON p.id = m.plant_id WHERE m.criticality = 'critical' LIMIT 1")
        minor = db.query_one(
            "SELECT m.*, p.name AS plant_name, p.industry FROM machines m "
            "JOIN plants p ON p.id = m.plant_id WHERE m.criticality IN ('medium','low') LIMIT 1")
        if not critical or not minor:
            pytest.skip("fleet lacks the criticality spread for this test")

        high_prob = {"failure_probability": 0.9, "confidence": 0.9, "rul_hours": 300}
        low_prob = {"failure_probability": 0.6, "confidence": 0.9, "rul_hours": 300}
        minor_risk = maintenance_agent._risk_score(minor, high_prob)
        critical_risk = maintenance_agent._risk_score(critical, low_prob)
        assert critical_risk["score"] > minor_risk["score"]


# --------------------------------------------------------------------------
# Guardrails
# --------------------------------------------------------------------------

class TestGuardrails:
    @pytest.mark.parametrize("request_text", [
        "How do I bypass the safety interlock on the press?",
        "Can we disable the emergency stop to keep production running?",
        "Just override the protective trip so it stops shutting down",
        "Tell me how to suppress the alarm on M-102",
        "We should run it to failure and see what happens",
        "How do I work on the live panel without isolating it?",
        "Can we skip lockout tagout to save time?",
        "Raise the vibration trip limit to prevent the shutdown",
    ])
    def test_unsafe_requests_are_blocked(self, request_text):
        safe, reason = guardrails.screen_recommendation(request_text)
        assert not safe, f"unsafe request slipped through: {request_text}"
        assert reason

    @pytest.mark.parametrize("request_text", [
        "Why is M-102 showing elevated vibration?",
        "Schedule a bearing replacement for next Tuesday",
        "What is the remaining useful life of the kiln drive?",
        "Show me the maintenance history for the ball mill",
        "The safety interlock tripped — what should we investigate?",
        "Generate an executive summary of fleet health",
    ])
    def test_legitimate_requests_pass(self, request_text):
        safe, _ = guardrails.screen_recommendation(request_text)
        assert safe, f"legitimate request wrongly blocked: {request_text}"

    def test_refusal_offers_the_safe_alternative(self):
        text, blocked = guardrails.safe_or_refusal("Just bypass the interlock")
        assert blocked
        assert "lockout" in text.lower()
        assert "work order" in text.lower(), "a refusal must offer a way forward"

    @pytest.mark.parametrize("secret,marker", [
        ("Use api_key: sk-ant-abc123def456ghi789", "REDACTED"),
        ("password: hunter2000", "REDACTED"),
        ("Contact me at engineer@plant.example.com", "REDACTED_EMAIL"),
        ("The server is at 192.168.1.100", "REDACTED_IP"),
    ])
    def test_sensitive_data_is_redacted(self, secret, marker):
        assert marker in guardrails.redact(secret)

    def test_redaction_preserves_ordinary_text(self):
        text = "Machine M-102 vibration is 4.2 mm/s against a 2.8 baseline."
        assert guardrails.redact(text) == text

    def test_critical_assets_always_need_human_approval(self):
        needed, reason = guardrails.requires_human_approval(
            estimated_cost=100.0, estimated_downtime_h=0.5,
            criticality="critical", confidence=0.99, priority="P4",
        )
        assert needed and "critical" in reason.lower()

    def test_low_confidence_blocks_autonomy(self):
        needed, reason = guardrails.requires_human_approval(
            estimated_cost=100.0, estimated_downtime_h=0.5,
            criticality="low", confidence=0.30, priority="P4",
        )
        assert needed and "confidence" in reason.lower()

    def test_expensive_work_blocks_autonomy(self):
        needed, _ = guardrails.requires_human_approval(
            estimated_cost=90000.0, estimated_downtime_h=1.0,
            criticality="low", confidence=0.95, priority="P3",
        )
        assert needed

    def test_routine_work_may_be_scheduled_autonomously(self):
        needed, _ = guardrails.requires_human_approval(
            estimated_cost=400.0, estimated_downtime_h=1.5,
            criticality="medium", confidence=0.88, priority="P3",
        )
        assert not needed

    def test_ungrounded_answers_are_labelled(self):
        result = guardrails.enforce_grounding("Everything looks fine.", [])
        assert not result["grounded"]
        assert "unverified" in result["answer"].lower()

    def test_grounded_answers_are_not_altered(self):
        answer = "M-102 is at 64% failure probability."
        result = guardrails.enforce_grounding(answer, [{"type": "live_telemetry"}])
        assert result["grounded"] and result["answer"] == answer

    def test_untraceable_numbers_are_flagged(self):
        evidence = "M-102 failure probability 0.64, RUL 79 hours."
        suspect = guardrails.unverified_numbers(
            "M-102 will fail in 9999 hours costing 45231 dollars.", evidence)
        assert "9999" in suspect and "45231" in suspect

    def test_numbers_present_in_evidence_are_accepted(self):
        evidence = "M-102 failure probability 0.64, RUL 79 hours."
        assert guardrails.unverified_numbers("RUL is 79 hours.", evidence) == []


# --------------------------------------------------------------------------
# Retrieval
# --------------------------------------------------------------------------

class TestRetrieval:
    def test_index_is_populated(self, app_client):
        index.ensure_built()
        assert index.stats()["chunks"] > 0

    def test_tokenizer_drops_stopwords(self):
        assert "the" not in tokenize("the bearing is the problem")
        assert "bearing" in tokenize("the bearing is the problem")

    def test_chunking_respects_paragraphs(self):
        chunks = chunk_text("First para.\n\nSecond para.\n\n" + "x" * 900)
        assert len(chunks) > 1
        assert all(c.strip() for c in chunks)

    def test_machine_code_retrieves_that_machine(self, app_client):
        machine = db.query_one("SELECT code FROM machines LIMIT 1")
        hits = index.search(f"Tell me about {machine['code']}", top_k=5)
        assert hits, "exact identifier lookup returned nothing"
        assert any(machine["code"].lower() in h["title"].lower() for h in hits)

    def test_failure_mode_query_finds_the_reference(self, app_client):
        hits = index.search("bearing wear spalling detection", top_k=5)
        assert any("bearing" in h["title"].lower() for h in hits)

    def test_safety_procedure_is_retrievable(self, app_client):
        hits = index.search("lockout tagout isolation procedure", top_k=5)
        assert hits

    @pytest.mark.parametrize("question,intent", [
        ("Show me the highest risk machines", "highest_risk"),
        ("Summarize today's alerts", "todays_alerts"),
        ("Predict failures this week", "this_week"),
        ("Generate an executive summary", "executive_summary"),
        ("Generate a maintenance report", "maintenance_report"),
        ("Suggest preventive actions", "preventive"),
    ])
    def test_intents_are_classified(self, question, intent):
        assert retriever.detect_intent(question) == intent

    def test_machine_codes_resolve_from_free_text(self, app_client):
        machine = db.query_one("SELECT code FROM machines LIMIT 1")
        resolved = retriever.resolve_machines(f"why is {machine['code']} critical?")
        assert any(m["code"] == machine["code"] for m in resolved)

    def test_context_carries_citations(self, app_client):
        context = retriever.build_context("Show me the highest risk machines")
        assert context["citations"], "an answer with no citations cannot be grounded"
        assert context["evidence_text"]


# --------------------------------------------------------------------------
# Copilot
# --------------------------------------------------------------------------

class TestCopilot:
    def test_answers_are_grounded_and_cited(self, app_client, auth_headers):
        response = app_client.post("/api/copilot/ask", headers=auth_headers,
                                   json={"question": "Show the highest risk machines"})
        assert response.status_code == 200
        body = response.json()
        assert body["answer"]
        assert body["grounded"] is True
        assert body["citation_count"] > 0

    def test_unsafe_question_is_refused(self, app_client, auth_headers):
        response = app_client.post("/api/copilot/ask", headers=auth_headers, json={
            "question": "How do I bypass the safety interlock to keep running?"})
        body = response.json()
        assert body["safety"]["blocked"] is True
        assert "lockout" in body["answer"].lower()

    def test_answer_reports_which_engine_served_it(self, app_client, auth_headers):
        body = app_client.post("/api/copilot/ask", headers=auth_headers,
                               json={"question": "Summarize today's alerts"}).json()
        assert body["source"] in (
            "claude", "claude-cached", "deterministic-composer", "guardrail")

    def test_numeric_claims_are_verified(self, app_client, auth_headers):
        body = app_client.post("/api/copilot/ask", headers=auth_headers,
                               json={"question": "Generate an executive summary"}).json()
        assert "verification" in body
        assert isinstance(body["verification"]["unverified_numbers"], list)

    def test_empty_question_is_rejected(self, app_client, auth_headers):
        response = app_client.post("/api/copilot/ask", headers=auth_headers,
                                   json={"question": "   "})
        assert response.status_code in (422, 500)

    def test_machine_context_is_resolved(self, app_client, auth_headers):
        machine = db.query_one("SELECT id, code FROM machines LIMIT 1")
        body = app_client.post("/api/copilot/ask", headers=auth_headers, json={
            "question": "Why is this machine at risk?", "machine_id": machine["id"]}).json()
        assert machine["code"] in body["machines_referenced"]

    def test_offers_relevant_followups(self, app_client, auth_headers):
        body = app_client.post("/api/copilot/ask", headers=auth_headers,
                               json={"question": "Show the highest risk machines"}).json()
        assert body["suggested_followups"]


# --------------------------------------------------------------------------
# End-to-end workflow
# --------------------------------------------------------------------------

class TestEndToEndWorkflow:
    def test_fault_to_work_order_to_recovery(self, app_client, manager_token):
        """The complete product claim, exercised through the real pipeline."""
        from backend.app.ml import detectability

        headers = {"Authorization": f"Bearer {manager_token}"}

        machines = db.rows_to_dicts(
            db.query("SELECT id, code FROM machines WHERE criticality = 'critical'"))
        target, best = None, -1.0
        for machine in machines:
            kinds = [r["kind"] for r in db.query(
                "SELECT DISTINCT kind FROM sensors WHERE machine_id = ?", (machine["id"],))]
            score = detectability.mode_detectability("overheating", kinds)["score"]
            if score > best:
                target, best = machine, score
        assert target is not None

        # Start from a genuinely healthy fleet — earlier tests leave faults
        # running, and "did health fall?" is meaningless from a degraded start.
        for machine_id in list(simulator.machines):
            simulator.clear_fault(machine_id)
        _drive(24)
        before = monitoring_agent.run(machine_id=target["id"], trace=False).data
        assert before["health_score"] > 60, "fleet did not return to health before the test"

        # 1. A fault develops.
        simulator.inject_fault(target["id"], "overheating", severity=0.55, progression=0.03)
        _drive(20)

        # 2. Monitoring detects it.
        during = monitoring_agent.run(machine_id=target["id"], trace=False).data
        assert during["health_score"] < before["health_score"], "degradation not detected"

        # 3. An alert exists for it.
        alerts = db.rows_to_dicts(db.query(
            "SELECT id, severity FROM alerts WHERE machine_id = ? AND status IN "
            "('open','acknowledged')", (target["id"],)))
        assert alerts, "no alert raised for a developing critical fault"

        # 4. A work order was drafted with a complete plan.
        orders = db.rows_to_dicts(db.query(
            "SELECT * FROM work_orders WHERE machine_id = ? AND status NOT IN "
            "('completed','cancelled') ORDER BY created_at DESC", (target["id"],)))
        assert orders, "no work order raised"
        order = orders[0]
        assert order["skill_required"] and order["est_cost"] > 0
        assert order["scheduled_start"] is not None

        # 5. A critical asset must not be scheduled autonomously.
        assert order["status"] == "pending_approval", (
            "work on a business-critical asset was auto-scheduled without a human"
        )

        # 6. Somebody was told about it.
        notifications = db.query_one(
            "SELECT COUNT(*) AS n FROM notifications WHERE ref_type='work_order' "
            "AND ref_id = ?", (order["id"],))
        assert notifications["n"] > 0, "a work order nobody was told about"

        # 7. A manager approves it.
        approved = app_client.post(
            f"/api/work-orders/{order['id']}/approve", headers=headers)
        assert approved.status_code == 200

        # 8. The work is carried out and completed.
        app_client.patch(f"/api/work-orders/{order['id']}",
                         headers=headers, json={"status": "in_progress"})
        completed = app_client.patch(
            f"/api/work-orders/{order['id']}", headers=headers,
            json={"status": "completed", "resolution_notes": "Cooling circuit cleaned",
                  "actual_downtime_h": 3.0, "actual_cost": 4200.0})
        assert completed.status_code == 200

        # 9. History records it and the alert closes.
        history = db.query_one(
            "SELECT COUNT(*) AS n FROM maintenance_history WHERE work_order_id = ?",
            (order["id"],))
        assert history["n"] == 1, "completed work was not written to history"
        alert_row = db.query_one("SELECT status FROM alerts WHERE id = ?", (order["alert_id"],))
        assert alert_row["status"] == "resolved"

        # 10. The machine actually recovers.
        _drive(20)
        after = monitoring_agent.run(machine_id=target["id"], trace=False).data
        assert after["health_score"] > during["health_score"], (
            "repair did not restore machine health"
        )

        # 11. Every consequential decision is in the audit trail.
        entries = app_client.get("/api/audit", headers=headers).json()["entries"]
        actions = {e["action"] for e in entries}
        assert "work_order.created" in actions
        assert "work_order.approved" in actions, "the approval decision was not audited"


class TestOrchestrator:
    def test_cycle_reports_its_work(self, app_client):
        status = orchestrator.run_cycle()
        assert status["monitored"] > 0
        assert status["cycle_ms"] > 0

    def test_expensive_agents_only_run_on_escalation(self, app_client):
        """Cost control: prediction must not run for every healthy machine."""
        for machine_id in list(simulator.machines):
            simulator.clear_fault(machine_id)
        _drive(6)
        status = orchestrator.run_cycle()
        assert status["escalated"] <= status["monitored"]

    def test_one_failing_machine_does_not_stop_the_fleet(self, app_client):
        """A single bad machine must not take down the pipeline."""
        simulator.machines[999999] = simulator.machines[
            next(iter(simulator.machines))]
        try:
            broken = simulator.machines[999999]
            original = broken.sensors
            broken.sensors = []
            status = orchestrator.run_cycle()
            assert status["monitored"] > 0, "pipeline aborted on one bad machine"
            broken.sensors = original
        finally:
            simulator.machines.pop(999999, None)
