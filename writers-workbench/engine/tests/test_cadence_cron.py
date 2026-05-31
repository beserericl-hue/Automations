"""L0 — cadence cron endpoint: auth required + returns ``{enqueued, skipped, ...}``."""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_cron_requires_secret() -> None:
    from orchestrator.main import app

    client = TestClient(app)
    r = client.post("/cron/newsletter-cadence")
    assert r.status_code == 401


def test_cron_runs_with_secret() -> None:
    from orchestrator.main import app

    client = TestClient(app)
    r = client.post("/cron/newsletter-cadence", headers={"x-cron-secret": "test-admin-token"})
    assert r.status_code == 200
    body = r.json()
    # Without Supabase configured (the conftest force-empties keys), it short-circuits.
    assert "enqueued" in body
    assert body["enqueued"] == 0
