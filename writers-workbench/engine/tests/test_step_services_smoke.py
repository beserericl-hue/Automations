"""L0 + L1 smoke for every step service we ship.

For each step:
- ``/admin/health`` returns 200
- ``/run`` requires X-Service-Secret (401 without)
- ``/run`` with secret + matching ``step_name`` returns 200 + a StepOutput envelope
"""

from __future__ import annotations

from importlib import import_module
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

# (pip-installed package name, step_name)
SERVICES: list[tuple[str, str, dict[str, Any]]] = [
    # F0 vertical slice
    ("library_retrieve_step.main", "library_retrieve", {"user_id": "u1", "limit": 2}),
    # F2 newsletter
    ("gather_step.main", "gather", {"send_date": "2026-05-30", "user_id": "+14105914612", "limit": 5}),
    ("pick_step.main", "pick", {"articles": [], "max_stories": 3}),
    ("subject_step.main", "subject", {"top_selected_stories": []}),
    ("scrape_step.main", "scrape", {"urls": []}),
    ("segment_step.main", "segment", {"story": {"title": "x"}, "sources": [], "image_options": []}),
    ("image_step.main", "image", {"story": {"title": "x", "image_urls": ["http://a/1.jpg"]}}),
    ("assemble_step.main", "assemble", {"segments": [], "remaining_items": []}),
    ("render_step.main", "render", {"edition_id": "e1", "subject": "S", "markdown_body": "# Hi"}),
    (
        "persist_step.main",
        "persist",
        {
            "row": {
                "edition_id": "e1",
                "send_date": "2026-05-30",
                "subject": "S",
                "markdown_body": "x",
                "html_body": "<p>x</p>",
            }
        },
    ),
    ("deliver_step.main", "deliver", {"edition_id": "e1", "send_id": "s1", "html_body": "<p>x</p>"}),
    # F1 write-workshop
    ("chapter_step.main", "chapter", {"op": "qa", "chapter_id": "ch1"}),
    ("research_step.main", "research", {"op": "run", "topic": "t"}),
    ("brainstorm_step.main", "brainstorm", {"op": "story", "title": "x"}),
    ("media_step.main", "media", {"op": "cover-art", "project_id": "p1"}),
    ("library_step.main", "library", {"op": "retrieve"}),
    ("story_bible_step.main", "story_bible", {"op": "list", "project_id": "p1"}),
    (
        "approval_step.main",
        "approval",
        {"op": "issue", "execution_id": str(uuid4()), "stage": "test", "payload": {}},
    ),
    ("notify_step.main", "notify", {"op": "email", "to": []}),
]


@pytest.mark.parametrize("module,step_name,payload", SERVICES, ids=[s[1] for s in SERVICES])
def test_step_service_smoke(fake_redis, module: str, step_name: str, payload: dict[str, Any]) -> None:  # type: ignore[no-untyped-def]
    app = import_module(module).app
    client = TestClient(app)

    # L0 contract — health
    r = client.get("/admin/health")
    assert r.status_code == 200, f"{step_name} health: {r.text}"

    # L0 — auth required on /run
    r = client.post("/run", json={"execution_id": str(uuid4()), "step_name": step_name})
    assert r.status_code == 401, f"{step_name} should require X-Service-Secret"

    # L1 — happy path
    r = client.post(
        "/run",
        json={"execution_id": str(uuid4()), "step_name": step_name, "payload": payload},
        headers={"x-service-secret": "test-secret"},
    )
    assert r.status_code == 200, f"{step_name} /run failed: {r.status_code} {r.text}"
    body = r.json()
    assert body["step_name"] == step_name
    # Either ok or error envelope is acceptable; what matters is the contract.
    assert body["status"] in ("ok", "error")
