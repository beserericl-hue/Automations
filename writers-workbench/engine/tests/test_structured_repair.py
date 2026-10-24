"""complete_structured: one repair call when the reply is not the JSON it was asked for.

Found by the newsletter full-send regression: the subject step's live brief (from n8n) ends with a
"Final Deliverable Structure" of a statement, a reasoning breakdown and "Subject Line: ...", and the
model followed it, replying with a markdown essay. json.loads failed at character 0 and the whole
saga stopped after the stories gate. "Reply with strict JSON only" is a request, not a guarantee.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from subject_step import main as subject_main

from writer_engine.llm.router import LLMResponse
from writer_engine.llm.structured import complete_structured
from writer_engine.schemas.newsletter import SubjectLineProposal

ESSAY = (
    "# DEEP CONSIDERATION STATEMENT\n\nThis analysis represents strategic deliberation...\n\n"
    "Subject Line: The data that survived the collapse\nPre-header Text: And who is reading it now"
)
GOOD = (
    '{"subject_line": "The data that survived the collapse", "pre_header_text": "And who is reading it now",'
    ' "additional_subject_lines": ["a", "b", "c"], "subject_line_reasoning": "r", "pre_header_text_reasoning": "p"}'
)


class FakeRouter:
    def __init__(self, *replies: str) -> None:
        self.replies = list(replies)
        self.calls: list[dict[str, Any]] = []

    async def complete(self, **kw: Any) -> LLMResponse:
        self.calls.append(kw)
        return LLMResponse(text=self.replies.pop(0))


def run(router: FakeRouter) -> SubjectLineProposal:
    proposal, _ = asyncio.run(
        complete_structured(
            router,  # type: ignore[arg-type]
            provider="anthropic",
            model="m",
            system="s",
            prompt="p",
            schema=SubjectLineProposal,
        )
    )
    return proposal


def test_a_reply_that_parses_costs_one_call() -> None:
    router = FakeRouter(GOOD)
    assert run(router).subject_line == "The data that survived the collapse"
    assert len(router.calls) == 1


def test_an_essay_is_repaired_from_its_own_text() -> None:
    router = FakeRouter(ESSAY, GOOD)
    assert run(router).pre_header_text == "And who is reading it now"
    assert len(router.calls) == 2
    repair = router.calls[1]
    # The model is handed its own reply and the fields it must produce.
    assert "DEEP CONSIDERATION STATEMENT" in repair["prompt"]
    assert "subject_line" in repair["prompt"] and "pre_header_text" in repair["prompt"]
    assert repair["temperature"] == 0.0


def test_a_reply_that_fails_the_schema_is_repaired_too() -> None:
    router = FakeRouter('{"subject_line": "only half"}', GOOD)
    assert run(router).subject_line == "The data that survived the collapse"
    assert "failed schema" in router.calls[1]["prompt"]


def test_two_bad_replies_still_raise() -> None:
    with pytest.raises(ValueError, match="did not return valid JSON"):
        run(FakeRouter(ESSAY, ESSAY))


def test_the_subject_prompt_says_where_the_deliverable_goes() -> None:
    assert "replaces the Final Deliverable Structure" in subject_main._OUTPUT_FORMAT
    for field in SubjectLineProposal.model_fields:
        assert f'"{field}"' in subject_main._OUTPUT_FORMAT
