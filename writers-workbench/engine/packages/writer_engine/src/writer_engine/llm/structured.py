"""LLM structured-output helper used by every LLM-calling step service.

Wraps an :class:`LLMRouter` call, asks the model for strict JSON, and validates against a Pydantic schema. Falls
back to the model's text if it can't parse — the caller decides what to do (most steps will treat that as ``error``
status and let the orchestrator retry).
"""

from __future__ import annotations

import json
import re
from typing import TypeVar

from pydantic import BaseModel, ValidationError

from .router import LLMResponse, LLMRouter

T = TypeVar("T", bound=BaseModel)

_JSON_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


def extract_json(text: str) -> str:
    """Extract the first JSON object/array from a response, tolerant of ```json``` fences."""
    match = _JSON_FENCE.search(text)
    if match:
        return match.group(1).strip()
    start = min((text.find("{"), text.find("[")), key=lambda i: (i == -1, i))
    if start < 0:
        return text
    return text[start:]


async def complete_structured(
    router: LLMRouter,
    *,
    provider: str,
    model: str,
    system: str,
    prompt: str,
    schema: type[T],
    max_tokens: int = 8192,
    temperature: float = 0.4,
    stream: bool = False,
) -> tuple[T, LLMResponse]:
    """Run a single LLM call and validate the JSON output against ``schema``.

    ``max_tokens`` defaults to 8192 (not 4096): structured outputs that contain several
    detailed objects — e.g. pick's ``top_selected_stories`` with per-story summaries — were
    being truncated mid-JSON at 4096 ("Unterminated string"), which then failed json.loads.
    Callers whose output scales with input (pick, segment) should pass a higher value still.

    The "strict JSON" line is a request, not a guarantee. A long brief that asks for a written
    deliverable of its own (the n8n-era newsletter prompts end with "Final Deliverable Structure:
    1. Statement of Deep Consideration ...") wins over it often enough that the subject step was
    failing whole runs on a markdown essay. So a reply that does not parse, or does not fit the
    schema, gets one repair call that hands the model its own reply and the required fields. A
    second failure raises, as before.
    """
    response = await router.complete(
        provider=provider,
        model=model,
        system=system + "\n\nReply with strict JSON only.",
        prompt=prompt,
        max_tokens=max_tokens,
        temperature=temperature,
        stream=stream,
    )
    try:
        return _parse(response.text, schema), response
    except ValueError as first:
        repair = await router.complete(
            provider=provider,
            model=model,
            system="You convert a reply into the JSON object it was supposed to be. Reply with that JSON object only.",
            prompt=_repair_prompt(response.text, schema, str(first)),
            max_tokens=max_tokens,
            temperature=0.0,
            stream=stream,
        )
        return _parse(repair.text, schema), repair


def _parse(text: str, schema: type[T]) -> T:
    raw = extract_json(text)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"LLM did not return valid JSON: {exc}; raw={text[:300]!r}") from exc
    try:
        return schema.model_validate(data)
    except ValidationError as exc:
        raise ValueError(f"LLM JSON failed schema {schema.__name__}: {exc}") from exc


def _repair_prompt(reply: str, schema: type[BaseModel], problem: str) -> str:
    fields = json.dumps(schema.model_json_schema().get("properties", {}), ensure_ascii=False)
    return (
        f"This reply was supposed to be one JSON object, and it was not usable ({problem[:200]}).\n\n"
        f"<reply>\n{reply}\n</reply>\n\n"
        f"Return the same content as one JSON object with these fields: {fields}\n"
        "Use only what the reply says. Put any reasoning or commentary in a reasoning field if the "
        "schema has one; otherwise leave it out. No text before or after the JSON."
    )
