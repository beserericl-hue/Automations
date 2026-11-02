"""Hub conversation memory (``writer_engine.hub.memory``) — "list my outlines" then "pick #3".

The router always read ``context.last_list``; nothing wrote it, so a numbered follow-up could never
resolve. These tests pin the store (Redis, per user + conversation, TTL), what a turn records, and
the end-to-end gateway behaviour: a second ``/internal/hub`` call in the same conversation picks
from the list the first call returned — on chat and on voice.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from writer_engine.config import get_settings
from writer_engine.hub import memory
from writer_engine.hub.router import route_message
from writer_engine.hub.schemas import HubRequest, HubResponse
from writer_engine.llm.router import LLMRouter

OUTLINES = {
    "payload": {
        "op": "list-outlines",
        "result": {
            "items": [
                {"id": "p-a", "title": "The Burial Mound", "outline": {"big": "blob"}},
                {"id": "p-b", "title": "The Last Signal", "outline": {}},
                {"id": "p-c", "title": "The Seed Vault", "outline": {}},
            ]
        },
    }
}


@pytest.fixture
def memory_on(monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setenv("HUB_MEMORY_ENABLED", "true")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


class _DictRedis:
    """A loop-agnostic stand-in for the two Redis calls memory makes (GET / SET EX), for the
    TestClient tests, whose requests run on the client's own event loop."""

    def __init__(self) -> None:
        self.data: dict[str, str] = {}
        self.ttl: dict[str, int] = {}

    async def get(self, key: str) -> str | None:
        return self.data.get(key)

    async def set(self, key: str, value: str, ex: int | None = None) -> bool:
        self.data[key] = value
        self.ttl[key] = ex or 0
        return True


@pytest.fixture
def dict_redis(monkeypatch: pytest.MonkeyPatch) -> _DictRedis:
    store = _DictRedis()

    async def _get() -> _DictRedis:
        return store

    monkeypatch.setattr(memory, "_redis", _get)
    return store


# --------------------------------------------------------------------------- the store


@pytest.mark.asyncio
async def test_round_trip_over_redis_with_ttl(memory_on: Any, fake_redis: Any) -> None:
    req = HubRequest(message="list all my outlines", user_id="u1", conversation_id="c-1")
    state = await memory.load_state(req)
    assert state is not None and state.last_list == []
    memory.record_turn(
        state, req=req, resp=HubResponse(kind="data", tool="library", op="list-outlines", data=OUTLINES)
    )
    assert await memory.save_state(req, state)

    key = memory.conversation_key("u1", "c-1")
    assert 0 < await fake_redis.ttl(key) <= get_settings().hub_conversation_ttl_seconds
    again = await memory.load_state(req)
    assert again is not None
    assert [i["title"] for i in again.last_list] == ["The Burial Mound", "The Last Signal", "The Seed Vault"]
    assert again.last_list[0] == {
        "title": "The Burial Mound",
        "project_title": "The Burial Mound",
        "project_id": "p-a",
        "content_type": "outline",
    }  # compacted: no outline blob in Redis
    assert [t["role"] for t in again.turns] == ["user", "assistant"]


@pytest.mark.asyncio
async def test_conversations_and_users_are_isolated(memory_on: Any, fake_redis: Any) -> None:
    a = HubRequest(message="m", user_id="u1", conversation_id="c-1")
    st = await memory.load_state(a)
    assert st is not None
    st.project_title = "The Last Signal"
    await memory.save_state(a, st)
    for other in (
        HubRequest(message="m", user_id="u1", conversation_id="c-2"),
        HubRequest(message="m", user_id="u2", conversation_id="c-1"),
    ):
        got = await memory.load_state(other)
        assert got is not None and got.project_title is None


def test_voice_without_an_id_gets_the_short_default(memory_on: Any) -> None:
    voice = HubRequest(message="m", user_id="u1", source="voice")
    assert memory.conversation_id_for(voice) == "voice:default"
    assert memory.ttl_for(voice) == get_settings().hub_voice_conversation_ttl_seconds
    with_id = HubRequest(message="m", user_id="u1", source="voice", conversation_id="conv_abc")
    assert memory.conversation_id_for(with_id) == "conv_abc"
    assert memory.ttl_for(with_id) == get_settings().hub_conversation_ttl_seconds
    assert memory.conversation_id_for(HubRequest(message="m", user_id="u1")) == "chat:default"


@pytest.mark.asyncio
async def test_disabled_or_anonymous_touches_nothing(fake_redis: Any) -> None:
    # HUB_MEMORY_ENABLED is false in the suite by default
    assert await memory.load_state(HubRequest(message="m", user_id="u1")) is None


@pytest.mark.asyncio
async def test_a_broken_redis_means_a_turn_without_memory(
    memory_on: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _dead() -> Any:
        raise ConnectionError("redis down")

    monkeypatch.setattr(memory, "_redis", _dead)
    req = HubRequest(message="m", user_id="u1")
    assert await memory.load_state(req) is None
    assert await memory.save_state(req, memory.ConversationState(conversation_id="x")) is False


def test_explicit_context_beats_memory() -> None:
    st = memory.ConversationState(conversation_id="c", project_id="p-old", project_title="Old")
    req = HubRequest(
        message="m", user_id="u1", context={"project_id": "p-page", "project_title": "Page Book"}
    )
    merged = memory.with_memory(req, st).context
    assert merged["project_id"] == "p-page" and merged["project_title"] == "Page Book"
    assert merged["last_project_title"] == "Old"  # the pronoun anchor still remembers


def test_record_turn_anchors() -> None:
    st = memory.ConversationState(conversation_id="c")
    req = HubRequest(message="research roman roads", user_id="u1")
    memory.record_turn(
        st,
        req=req,
        resp=HubResponse(kind="queued", tool="research", op="run", job_id="j1"),
        body={"topic": "roman roads"},
    )
    assert st.last_research_title == "roman roads" and st.turns[-1]["job_id"] == "j1"
    bible = {
        "payload": {
            "result": {
                "entries": [{"id": "e1", "name": "Mara Voss", "entry_type": "character", "project_id": "p1"}],
                "project_id": "p1",
            }
        }
    }
    memory.record_turn(
        st,
        req=req,
        resp=HubResponse(kind="data", tool="story_bible", op="list", data=bible),
        body={"project_title": "The Last Signal"},
    )
    assert st.project_id == "p1" and st.project_title == "The Last Signal"
    assert st.last_list[0]["content_type"] == "story_bible_entry"


def test_turns_are_capped() -> None:
    st = memory.ConversationState(conversation_id="c")
    for i in range(20):
        memory.record_turn(st, req=HubRequest(message=f"m{i}", user_id="u1"), resp=HubResponse(kind="reply"))
    assert len(st.turns) == memory.MAX_TURNS and st.turns[-2]["text"] == "m19"


# --------------------------------------------------------------------------- numbered selection


def _route(message: str, ctx: dict[str, Any]) -> Any:
    return asyncio.run(
        route_message(HubRequest(message=message, user_id="u1", context=ctx), llm_router=LLMRouter())
    )


def test_pick_number_resolves_against_the_remembered_list() -> None:
    items = memory.extract_list("library", "list-outlines", OUTLINES)
    d = _route("pick #3", {"last_list": items})
    assert (d.tool, d.op) == ("library", "retrieve")
    assert d.params["project_title"] == "The Seed Vault" and d.params["project_id"] == "p-c"


def test_pick_from_a_content_list_searches_by_title() -> None:
    data = {
        "payload": {
            "result": {
                "items": [
                    {"id": "c1", "title": "Chapter 1: Ash", "content_type": "chapter", "project_id": "p1"},
                    {"id": "c2", "title": "Chapter 2: Embers", "content_type": "chapter", "project_id": "p1"},
                ]
            }
        }
    }
    d = _route("the second one", {"last_list": memory.extract_list("library", "retrieve", data)})
    assert d.params == {"content_type": "chapter", "search_term": "Chapter 2: Embers", "project_id": "p1"}


def test_pick_from_a_bible_list_shows_that_entry() -> None:
    items = [
        {"title": "Mara Voss", "name": "Mara Voss", "content_type": "story_bible_entry", "project_id": "p1"}
    ]
    d = _route("1", {"last_list": items})
    assert (d.tool, d.op) == ("story_bible", "list") and d.params == {"name": "Mara Voss", "project_id": "p1"}


# --------------------------------------------------------------------------- through the gateway


def _patch_orch(monkeypatch: pytest.MonkeyPatch, calls: list[dict[str, Any]]) -> None:
    class _Fake:
        def __init__(self, *a: object, **k: object) -> None:
            pass

        async def __aenter__(self) -> _Fake:
            return self

        async def __aexit__(self, *a: object) -> None:
            return None

        async def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
            body = kwargs.get("json") or {}
            calls.append({"url": url, "body": body})
            if body.get("op") == "list-outlines":
                return httpx.Response(200, json=OUTLINES)
            return httpx.Response(
                200, json={"payload": {"op": body.get("op"), "result": {"items": [], "found": True}}}
            )

    monkeypatch.setattr("gateway.routes.internal.httpx.AsyncClient", _Fake)


def test_chat_list_then_pick_number_three(
    memory_on: Any, dict_redis: _DictRedis, monkeypatch: pytest.MonkeyPatch
) -> None:
    from gateway.main import app

    calls: list[dict[str, Any]] = []
    _patch_orch(monkeypatch, calls)
    client = TestClient(app)
    h = {"x-service-secret": "test-secret"}
    first = client.post(
        "/internal/hub",
        json={"message": "list all my outlines", "user_id": "u1", "conversation_id": "drawer-1"},
        headers=h,
    )
    assert first.status_code == 200 and first.json()["conversation_id"] == "drawer-1"
    second = client.post(
        "/internal/hub",
        json={"message": "pick #3", "user_id": "u1", "conversation_id": "drawer-1"},
        headers=h,
    )
    assert second.status_code == 200
    assert calls[-1]["body"]["op"] == "retrieve"
    assert calls[-1]["body"]["project_title"] == "The Seed Vault" and calls[-1]["body"]["project_id"] == "p-c"
    stored = json.loads(dict_redis.data[memory.conversation_key("u1", "drawer-1")])
    assert len(stored["turns"]) == 4 and stored["project_title"] == "The Seed Vault"

    # A different conversation has no list to pick from: "pick #3" does not resolve to The Seed Vault.
    calls.clear()
    client.post(
        "/internal/hub",
        json={"message": "pick #3", "user_id": "u1", "conversation_id": "drawer-2"},
        headers=h,
    )
    assert not any(c["body"].get("project_title") == "The Seed Vault" for c in calls)


def test_voice_remembers_within_a_call(
    memory_on: Any, dict_redis: _DictRedis, monkeypatch: pytest.MonkeyPatch
) -> None:
    from gateway.main import app

    calls: list[dict[str, Any]] = []
    _patch_orch(monkeypatch, calls)
    client = TestClient(app)
    h = {"x-service-secret": "test-secret"}
    caller = "+14105914612"
    client.post(
        "/internal/hub/voice",
        json={"user_message_request": "list all my outlines", "user_id": caller},
        headers=h,
    )
    out = client.post(
        "/internal/hub/voice", json={"user_message_request": "the second one", "user_id": caller}, headers=h
    )
    assert out.status_code == 200 and out.json()["conversation_id"] == "voice:default"
    assert calls[-1]["body"]["project_title"] == "The Last Signal"
    key = memory.conversation_key(caller, "voice:default")
    assert dict_redis.ttl[key] == get_settings().hub_voice_conversation_ttl_seconds
