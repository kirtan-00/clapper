"""API surface: authentication, authorization, workflow and data integrity.

The authorization tests matter most. "The AI proposes, a human disposes" is only
a real property if the permission boundary is enforced by the server — a UI that
hides a button is not access control.
"""

from __future__ import annotations

import pytest


# --------------------------------------------------------------------------
# Authentication
# --------------------------------------------------------------------------

class TestAuthentication:
    def test_login_succeeds_with_valid_credentials(self, app_client):
        response = app_client.post(
            "/api/auth/login",
            json={"email": "engineer@senchine.ai", "password": "senchine"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["token_type"] == "bearer"
        assert body["user"]["role"] == "engineer"
        assert "password" not in body["user"]
        assert "password_hash" not in body["user"]

    def test_login_is_case_insensitive_on_email(self, app_client):
        response = app_client.post(
            "/api/auth/login",
            json={"email": "ENGINEER@SENCHINE.AI", "password": "senchine"},
        )
        assert response.status_code == 200

    def test_wrong_password_is_rejected(self, app_client):
        response = app_client.post(
            "/api/auth/login",
            json={"email": "engineer@senchine.ai", "password": "wrong"},
        )
        assert response.status_code == 401

    def test_unknown_account_gives_the_same_error(self, app_client):
        """Must not let an attacker enumerate valid email addresses."""
        unknown = app_client.post(
            "/api/auth/login",
            json={"email": "nobody@nowhere.test", "password": "whatever"},
        )
        wrong = app_client.post(
            "/api/auth/login",
            json={"email": "engineer@senchine.ai", "password": "wrong"},
        )
        assert unknown.status_code == wrong.status_code == 401
        assert unknown.json()["detail"] == wrong.json()["detail"]

    def test_protected_route_requires_a_token(self, app_client):
        assert app_client.get("/api/fleet").status_code == 401

    def test_garbage_token_is_rejected(self, app_client):
        response = app_client.get(
            "/api/fleet", headers={"Authorization": "Bearer not-a-real-token"}
        )
        assert response.status_code == 401

    def test_tampered_token_is_rejected(self, app_client, engineer_token):
        head, claims, signature = engineer_token.split(".")
        forged = f"{head}.{claims}.{'A' * len(signature)}"
        response = app_client.get("/api/fleet", headers={"Authorization": f"Bearer {forged}"})
        assert response.status_code == 401

    def test_expired_token_is_rejected(self, app_client):
        from backend.app.security import create_token

        expired = create_token({"sub": "1", "role": "admin"}, ttl_minutes=-10)
        response = app_client.get("/api/fleet", headers={"Authorization": f"Bearer {expired}"})
        assert response.status_code == 401

    def test_password_hashing_is_salted(self):
        from backend.app.security import hash_password, verify_password

        first_hash, first_salt = hash_password("same-password")
        second_hash, second_salt = hash_password("same-password")
        assert first_salt != second_salt
        assert first_hash != second_hash, "identical passwords must not share a hash"
        assert verify_password("same-password", first_hash, first_salt)
        assert not verify_password("other-password", first_hash, first_salt)

    def test_registration_rejects_duplicate_email(self, app_client):
        payload = {
            "email": "newbie@senchine.ai", "name": "New Person",
            "password": "a-strong-password", "role": "viewer",
        }
        assert app_client.post("/api/auth/register", json=payload).status_code == 201
        assert app_client.post("/api/auth/register", json=payload).status_code == 409

    def test_registration_rejects_short_password(self, app_client):
        response = app_client.post("/api/auth/register", json={
            "email": "weak@senchine.ai", "name": "Weak", "password": "short",
        })
        assert response.status_code == 422

    def test_registration_cannot_self_assign_admin(self, app_client):
        response = app_client.post("/api/auth/register", json={
            "email": "escalate@senchine.ai", "name": "Escalator",
            "password": "a-strong-password", "role": "admin",
        })
        assert response.status_code == 422, "privilege escalation via registration"


# --------------------------------------------------------------------------
# Authorization
# --------------------------------------------------------------------------

class TestAuthorization:
    def test_viewer_cannot_inject_faults(self, app_client, viewer_token):
        response = app_client.post(
            "/api/sim/inject",
            headers={"Authorization": f"Bearer {viewer_token}"},
            json={"machine_id": 1, "category": "bearing_wear", "severity": 0.4},
        )
        assert response.status_code == 403

    def test_engineer_cannot_approve_work_orders(self, app_client, engineer_token):
        """The approval gate is the core human-oversight control."""
        orders = app_client.get(
            "/api/work-orders", headers={"Authorization": f"Bearer {engineer_token}"}
        ).json()["work_orders"]
        pending = [w for w in orders if w["status"] == "pending_approval"]
        if not pending:
            pytest.skip("no pending work order in this run")
        response = app_client.post(
            f"/api/work-orders/{pending[0]['id']}/approve",
            headers={"Authorization": f"Bearer {engineer_token}"},
        )
        assert response.status_code == 403

    def test_manager_can_approve_work_orders(self, app_client, manager_token):
        orders = app_client.get(
            "/api/work-orders", headers={"Authorization": f"Bearer {manager_token}"}
        ).json()["work_orders"]
        pending = [w for w in orders if w["status"] == "pending_approval"]
        if not pending:
            pytest.skip("no pending work order in this run")
        response = app_client.post(
            f"/api/work-orders/{pending[0]['id']}/approve",
            headers={"Authorization": f"Bearer {manager_token}"},
        )
        assert response.status_code == 200
        assert response.json()["status"] == "scheduled"

    def test_viewer_cannot_read_the_audit_log(self, app_client, viewer_token):
        response = app_client.get(
            "/api/audit", headers={"Authorization": f"Bearer {viewer_token}"}
        )
        assert response.status_code == 403

    def test_manager_can_read_the_audit_log(self, app_client, manager_token):
        response = app_client.get(
            "/api/audit", headers={"Authorization": f"Bearer {manager_token}"}
        )
        assert response.status_code == 200
        assert isinstance(response.json()["entries"], list)


# --------------------------------------------------------------------------
# Fleet data
# --------------------------------------------------------------------------

class TestFleet:
    def test_fleet_returns_seeded_machines(self, app_client, auth_headers):
        body = app_client.get("/api/fleet", headers=auth_headers).json()
        assert body["summary"]["total"] == 30
        assert body["summary"]["retrofit"] > 0, "no retrofit machines seeded"

    def test_every_machine_has_live_derived_state(self, app_client, auth_headers):
        """Nothing on the dashboard may be a hard-coded placeholder."""
        for machine in app_client.get("/api/fleet", headers=auth_headers).json()["machines"]:
            assert machine["health_score"] is not None, f"{machine['code']} has no health"
            assert 0 <= machine["health_score"] <= 100
            assert machine["health_band"] in ("healthy", "watch", "degraded", "critical")
            assert 0 <= machine["confidence"] <= 1

    def test_all_ten_industries_are_represented(self, app_client, auth_headers):
        industries = app_client.get("/api/analytics/industries", headers=auth_headers).json()
        assert len(industries["industries"]) == 10

    def test_filters_narrow_results(self, app_client, auth_headers):
        everything = app_client.get("/api/fleet", headers=auth_headers).json()
        retrofit = app_client.get(
            "/api/fleet?retrofit=true", headers=auth_headers
        ).json()
        assert retrofit["summary"]["total"] < everything["summary"]["total"]
        assert all(m["retrofit"] for m in retrofit["machines"])

    def test_machine_detail_is_complete(self, app_client, auth_headers):
        body = app_client.get("/api/machines/1", headers=auth_headers).json()
        for key in ("machine", "sensors", "health_history", "alerts",
                    "work_orders", "maintenance_history"):
            assert key in body
        assert len(body["sensors"]) > 0
        assert len(body["maintenance_history"]) > 0, "seeded history is missing"

    def test_unknown_machine_returns_404(self, app_client, auth_headers):
        assert app_client.get("/api/machines/999999", headers=auth_headers).status_code == 404

    def test_retrofit_machines_report_fused_estimates(self, app_client, auth_headers):
        machines = app_client.get(
            "/api/fleet?retrofit=true", headers=auth_headers
        ).json()["machines"]
        body = app_client.get(
            f"/api/machines/{machines[0]['id']}/fusion", headers=auth_headers
        ).json()
        assert body["channels"], "retrofit machine produced no fused channels"
        assert body["contributions"], "no sensor contributions recorded"
        assert 0 <= body["confidence"] <= 1

    def test_every_retrofit_sensor_is_an_external_device(self, app_client, auth_headers):
        machines = app_client.get(
            "/api/fleet?retrofit=true", headers=auth_headers
        ).json()["machines"]
        detail = app_client.get(
            f"/api/machines/{machines[0]['id']}", headers=auth_headers
        ).json()
        assert all(s["source"] == "edge" for s in detail["sensors"])
        assert all(s["distance_m"] > 0 for s in detail["sensors"]), (
            "a retrofit device mounted at zero distance is really an onboard sensor"
        )

    def test_on_demand_analysis_works(self, app_client, auth_headers):
        body = app_client.post("/api/machines/1/analyze", headers=auth_headers).json()
        assert "monitoring" in body and "prediction" in body
        assert 0 <= body["prediction"]["failure_probability"] <= 1


# --------------------------------------------------------------------------
# Workflow
# --------------------------------------------------------------------------

class TestWorkflow:
    def test_alert_lifecycle(self, app_client, auth_headers):
        from backend.app import db
        import time

        machine = db.query_one("SELECT id FROM machines LIMIT 1")
        alert_id = db.execute(
            "INSERT INTO alerts(machine_id, ts, severity, title, detail, source_agent, "
            "status, evidence_json, dedupe_key) VALUES(?,?,?,?,?,?,?,?,?)",
            (machine["id"], time.time(), "high", "Test alert", "detail",
             "test", "open", "{}", "test:lifecycle"),
        )

        ack = app_client.post(f"/api/alerts/{alert_id}/acknowledge",
                              headers=auth_headers, json={"note": "on it"})
        assert ack.status_code == 200

        resolve = app_client.post(f"/api/alerts/{alert_id}/resolve",
                                  headers=auth_headers, json={"note": "fixed"})
        assert resolve.status_code == 200

        # Re-resolving is a conflict, not a silent success.
        again = app_client.post(f"/api/alerts/{alert_id}/resolve",
                                headers=auth_headers, json={"note": ""})
        assert again.status_code == 409

    def test_unknown_alert_returns_404(self, app_client, auth_headers):
        response = app_client.post("/api/alerts/999999/acknowledge",
                                   headers=auth_headers, json={"note": ""})
        assert response.status_code == 404

    def test_false_positive_feedback_suppresses_the_alert(self, app_client, auth_headers):
        from backend.app import db
        import time

        machine = db.query_one("SELECT id FROM machines LIMIT 1")
        alert_id = db.execute(
            "INSERT INTO alerts(machine_id, ts, severity, title, detail, source_agent, "
            "status, evidence_json, dedupe_key) VALUES(?,?,?,?,?,?,?,?,?)",
            (machine["id"], time.time(), "medium", "FP test", "detail",
             "test", "open", "{}", "test:fp"),
        )
        response = app_client.post("/api/feedback", headers=auth_headers, json={
            "ref_type": "alert", "ref_id": alert_id,
            "verdict": "false_positive", "note": "process change, not a fault",
        })
        assert response.status_code == 200
        row = db.query_one("SELECT status FROM alerts WHERE id = ?", (alert_id,))
        assert row["status"] == "suppressed", (
            "reporting a false positive must stop it re-firing"
        )

    def test_feedback_rejects_invalid_verdict(self, app_client, auth_headers):
        response = app_client.post("/api/feedback", headers=auth_headers, json={
            "ref_type": "alert", "ref_id": 1, "verdict": "made-up", "note": "",
        })
        assert response.status_code == 422

    def test_notifications_are_scoped_to_the_user(self, app_client, engineer_token, manager_token):
        engineer = app_client.get(
            "/api/notifications", headers={"Authorization": f"Bearer {engineer_token}"}
        ).json()["notifications"]
        manager = app_client.get(
            "/api/notifications", headers={"Authorization": f"Bearer {manager_token}"}
        ).json()["notifications"]
        engineer_ids = {n["id"] for n in engineer}
        manager_ids = {n["id"] for n in manager}
        assert not (engineer_ids & manager_ids), "notifications leaked across users"

    def test_cannot_read_another_users_notification(self, app_client, engineer_token, manager_token):
        manager_notes = app_client.get(
            "/api/notifications", headers={"Authorization": f"Bearer {manager_token}"}
        ).json()["notifications"]
        if not manager_notes:
            pytest.skip("no notifications to test against")
        response = app_client.post(
            f"/api/notifications/{manager_notes[0]['id']}/read",
            headers={"Authorization": f"Bearer {engineer_token}"},
        )
        assert response.status_code == 404


# --------------------------------------------------------------------------
# Analytics and simulation
# --------------------------------------------------------------------------

class TestAnalytics:
    def test_overview_returns_coherent_numbers(self, app_client, auth_headers):
        body = app_client.get("/api/analytics/overview", headers=auth_headers).json()
        assert body["machines"]["total"] == 30
        bands = body["health"]["bands"]
        assert sum(bands.values()) == 30, "health bands must partition the fleet"
        assert 0 <= body["maintenance_90d"]["planned_ratio"] <= 1

    def test_impact_estimate_is_labelled_as_an_estimate(self, app_client, auth_headers):
        body = app_client.get("/api/analytics/overview", headers=auth_headers).json()
        note = body["impact_estimate"]["note"].lower()
        assert "estimate" in note and "not booked savings" in note, (
            "projected savings must never be presented as realised"
        )

    def test_trends_are_bucketed_for_charting(self, app_client, auth_headers):
        body = app_client.get("/api/analytics/trends?hours=1", headers=auth_headers).json()
        assert isinstance(body["buckets"], list)
        for bucket in body["buckets"]:
            assert 0 <= bucket["health"] <= 100

    def test_trends_rejects_absurd_range(self, app_client, auth_headers):
        assert app_client.get(
            "/api/analytics/trends?hours=99999", headers=auth_headers
        ).status_code == 422

    def test_model_metrics_survive_a_reload(self, app_client, auth_headers):
        """Weights and their reported accuracy are one artefact."""
        body = app_client.get("/api/models", headers=auth_headers).json()
        predictor = body["registry"]["predictor"]
        assert predictor.get("f1") is not None, "model reloaded without its metrics"
        assert predictor.get("category_accuracy") is not None

    def test_agent_manifest_declares_exactly_four_agents(self, app_client, auth_headers):
        body = app_client.get("/api/agents", headers=auth_headers).json()
        names = {a["name"] for a in body["manifest"]}
        assert names == {"monitoring", "prediction", "maintenance", "copilot"}
        for agent in body["manifest"]:
            assert agent["consumes"] and agent["produces"]


class TestSimulation:
    def test_inject_and_clear_a_fault(self, app_client, auth_headers):
        machine = app_client.get("/api/fleet", headers=auth_headers).json()["machines"][0]
        injected = app_client.post("/api/sim/inject", headers=auth_headers, json={
            "machine_id": machine["id"], "category": "overheating",
            "severity": 0.5, "progression": 0.01,
        })
        assert injected.status_code == 200
        assert injected.json()["state"]["injected_fault"] == "overheating"

        cleared = app_client.post(
            f"/api/sim/clear/{machine['id']}", headers=auth_headers)
        assert cleared.status_code == 200
        assert cleared.json()["state"]["injected_fault"] is None

    def test_rejects_unknown_failure_category(self, app_client, auth_headers):
        response = app_client.post("/api/sim/inject", headers=auth_headers, json={
            "machine_id": 1, "category": "alien_invasion", "severity": 0.5,
        })
        assert response.status_code == 422

    def test_rejects_out_of_range_severity(self, app_client, auth_headers):
        response = app_client.post("/api/sim/inject", headers=auth_headers, json={
            "machine_id": 1, "category": "overheating", "severity": 7.5,
        })
        assert response.status_code == 422

    def test_unknown_machine_returns_404(self, app_client, auth_headers):
        response = app_client.post("/api/sim/inject", headers=auth_headers, json={
            "machine_id": 999999, "category": "overheating", "severity": 0.4,
        })
        assert response.status_code == 404

    def test_presets_target_machines_that_can_detect_the_fault(self, app_client, auth_headers):
        """A scenario injected where the sensors cannot see it demos nothing."""
        body = app_client.get("/api/sim/scenarios", headers=auth_headers).json()
        assert body["presets"], "no demo presets available"
        for preset in body["presets"]:
            assert preset["detectability"]["score"] >= 0.6, (
                f"{preset['id']} targets a machine that cannot detect {preset['category']}"
            )

    def test_health_endpoint_reports_readiness(self, app_client):
        body = app_client.get("/api/health").json()
        assert body["models_ready"] is True
        assert body["simulator_loaded"] is True
