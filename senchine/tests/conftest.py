"""Shared test fixtures.

Every test run gets an isolated database and model directory, so tests never
touch a developer's working data and can run in parallel CI shards.
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# Point configuration at throwaway locations *before* the app imports settings.
_TMP = Path(tempfile.mkdtemp(prefix="senchine-tests-"))
os.environ["SENCHINE_DB"] = str(_TMP / "test.db")
os.environ["SENCHINE_MODEL_DIR"] = str(_TMP / "models")
os.environ["SENCHINE_JWT_SECRET"] = "test-secret-do-not-use-in-production"
os.environ["SENCHINE_TICK_SECONDS"] = "0.05"
os.environ.pop("ANTHROPIC_API_KEY", None)  # tests must exercise the fallback path


def pytest_sessionfinish(session, exitstatus):  # noqa: ARG001
    shutil.rmtree(_TMP, ignore_errors=True)


@pytest.fixture(scope="session")
def app_client():
    """A booted application with seeded data, models and a primed pipeline."""
    from fastapi.testclient import TestClient

    from backend.app.main import app

    with TestClient(app) as client:
        yield client


@pytest.fixture(scope="session")
def engineer_token(app_client):
    response = app_client.post(
        "/api/auth/login",
        json={"email": "engineer@senchine.ai", "password": "senchine"},
    )
    assert response.status_code == 200, response.text
    return response.json()["access_token"]


@pytest.fixture(scope="session")
def manager_token(app_client):
    response = app_client.post(
        "/api/auth/login",
        json={"email": "manager@senchine.ai", "password": "senchine"},
    )
    assert response.status_code == 200, response.text
    return response.json()["access_token"]


@pytest.fixture(scope="session")
def viewer_token(app_client):
    response = app_client.post(
        "/api/auth/login",
        json={"email": "viewer@senchine.ai", "password": "senchine"},
    )
    assert response.status_code == 200, response.text
    return response.json()["access_token"]


@pytest.fixture
def auth_headers(engineer_token):
    return {"Authorization": f"Bearer {engineer_token}"}


@pytest.fixture(scope="session")
def trained_registry():
    from backend.app.ml.registry import registry

    registry.load_or_train()
    return registry
