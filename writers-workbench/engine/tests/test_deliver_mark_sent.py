"""deliver-svc send-row lifecycle guard.

After a successful send the step advances newsletter_sends_v2 status→sent (sent_at,
recipient_count, provider_message_id) — but ONLY when send_id is the real row UUID. In local mode
send_id is `local-<exec>` / an `edition-date` composite, which must NOT trigger a DB update.
"""

from __future__ import annotations

from deliver_step.main import _is_uuid


def test_real_uuid_is_recognised() -> None:
    assert _is_uuid("ea4d6b11-edd1-449f-b540-01929c908afb") is True


def test_composite_and_local_send_ids_rejected() -> None:
    assert _is_uuid("ai-news-2026-05-31") is False
    assert _is_uuid("local-abc123") is False
    assert _is_uuid("") is False
