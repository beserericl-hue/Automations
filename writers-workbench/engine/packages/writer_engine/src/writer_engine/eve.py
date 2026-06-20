"""Eve (ElevenLabs Conversational AI) callback flow — KB injection + outbound call (E2E-5 / CR-010 A1).

Ports n8n WF-16 (eve_knowledge_callback): remove stale "Eve Session:" KB docs, upload the content as a
new KB doc, attach it, set the review/brainstorm first_message, place the outbound call, then schedule a
greeting reset.

BASELINE PROTECTION: every real ElevenLabs call is GATED behind ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID.
When they are unset (DEV / tests / any environment that hasn't been explicitly pointed at an agent) this
runs as a DRY RUN that returns the planned actions and touches NOTHING — so it never modifies the
baseline-protected PROD Eve agent. Pointing a real agent at it is a separate, authorized config step.
"""

from __future__ import annotations

import os
from typing import Any

from writer_engine.telemetry.logging import get_logger

logger = get_logger("eve")

KB_DOC_PREFIX = "Eve Session:"
_FIRST_MESSAGE = {
    "review": "Hi, it's Eve. I've pulled up your {title} and I'm ready to review it with you. Where would you like to start?",
    "brainstorm": "Hi, it's Eve. I've loaded your {title} — let's brainstorm. What direction are you thinking?",
}


def eve_config() -> dict[str, str]:
    return {
        "api_key": os.environ.get("ELEVENLABS_API_KEY", ""),
        "agent_id": os.environ.get("ELEVENLABS_AGENT_ID", ""),
        "phone_number_id": os.environ.get("ELEVENLABS_PHONE_NUMBER_ID", ""),
        "base": os.environ.get("ELEVENLABS_API_BASE", "https://api.elevenlabs.io"),
    }


def is_configured() -> bool:
    cfg = eve_config()
    return bool(cfg["api_key"] and cfg["agent_id"])


class EveClient:
    """Thin ElevenLabs Conversational-AI client (KB docs + agent first_message + outbound call). Only
    constructed when an agent is configured; injectable so tests can drive the flow without HTTP."""

    def __init__(self, cfg: dict[str, str]):
        self.cfg = cfg
        self._headers = {"xi-api-key": cfg["api_key"]}

    async def _request(self, method: str, path: str, **kw: Any) -> Any:
        import httpx

        async with httpx.AsyncClient(base_url=self.cfg["base"], timeout=30.0) as c:
            resp = await c.request(method, path, headers=self._headers, **kw)
            resp.raise_for_status()
            return resp.json() if resp.content else {}

    async def remove_session_docs(self) -> int:
        """Delete every existing "Eve Session:" KB doc so only the current content is in context."""
        data = await self._request("GET", "/v1/convai/knowledge-base")
        docs = (data.get("documents") if isinstance(data, dict) else data) or []
        removed = 0
        for d in docs:
            name = str(d.get("name") or "")
            if name.startswith(KB_DOC_PREFIX):
                with _suppress():
                    await self._request("DELETE", f"/v1/convai/knowledge-base/{d.get('id')}")
                    removed += 1
        return removed

    async def upload_kb_doc(self, name: str, text: str) -> str:
        data = await self._request(
            "POST", "/v1/convai/knowledge-base/text", json={"name": name, "text": text})
        return str(data.get("id") or "")

    async def attach_kb_doc(self, doc_id: str) -> None:
        await self._request(
            "PATCH", f"/v1/convai/agents/{self.cfg['agent_id']}",
            json={"conversation_config": {"agent": {"prompt": {"knowledge_base": [{"id": doc_id}]}}}})

    async def set_first_message(self, callback_mode: str, title: str) -> None:
        msg = _FIRST_MESSAGE.get(callback_mode, _FIRST_MESSAGE["review"]).format(title=title or "content")
        await self._request(
            "PATCH", f"/v1/convai/agents/{self.cfg['agent_id']}",
            json={"conversation_config": {"agent": {"first_message": msg}}})

    async def outbound_call(self, phone: str) -> str:
        data = await self._request(
            "POST", "/v1/convai/twilio/outbound-call",
            json={"agent_id": self.cfg["agent_id"], "agent_phone_number_id": self.cfg["phone_number_id"],
                  "to_number": phone})
        return str(data.get("call_sid") or data.get("conversation_id") or "")


def _suppress():
    import contextlib

    return contextlib.suppress(Exception)


async def run_eve_callback(
    *, content_type: str, content_title: str, content_text: str, callback_mode: str, phone: str,
    client: EveClient | None = None,
) -> dict[str, Any]:
    """Run the WF-16 callback flow. GATED: real calls only when an agent is configured; otherwise a
    dry run that returns the planned payload and touches nothing (protects the PROD Eve agent)."""
    plan = {
        "content_type": content_type, "content_title": content_title,
        "content_text": content_text, "callback_mode": callback_mode, "phone": phone,
    }
    if client is None and not is_configured():
        logger.info("eve.callback.dry_run", callback_mode=callback_mode, content_type=content_type)
        return {"dry_run": True, "reason": "ELEVENLABS_API_KEY/AGENT_ID not configured", "planned": plan}
    c = client or EveClient(eve_config())
    removed = await c.remove_session_docs()                       # 1. clean stale session docs FIRST
    doc_id = await c.upload_kb_doc(f"{KB_DOC_PREFIX} {content_title}", content_text)  # 2. upload new
    await c.attach_kb_doc(doc_id)                                 # 3. attach to agent
    await c.set_first_message(callback_mode, content_title)       # 4. review/brainstorm greeting
    call_id = await c.outbound_call(phone)                        # 5. outbound call to the caller
    logger.info("eve.callback.placed", removed_docs=removed, kb_doc_id=doc_id, call_id=call_id)
    return {"dry_run": False, "removed_docs": removed, "kb_doc_id": doc_id, "call_id": call_id, "planned": plan}
