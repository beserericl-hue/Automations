"""SSE relay — gateway subscribes to ``engine:exec:{id}`` and streams events to the browser.

This is the bridge that lets the existing Express SSE endpoint pass through, and it's also how the engine's
docs page demonstrates live progress directly.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

from fastapi import APIRouter
from sse_starlette.sse import EventSourceResponse

from writer_engine.redis_client.client import get_redis, progress_channel

router = APIRouter()


@router.get("/executions/{execution_id}/events")
async def stream_execution_events(execution_id: str) -> EventSourceResponse:
    """Stream progress events for a given execution as SSE."""

    async def event_source() -> AsyncIterator[dict[str, str]]:
        client = await get_redis()
        pubsub = client.pubsub()
        await pubsub.subscribe(progress_channel(execution_id))
        try:
            yield {"event": "open", "data": "{}"}
            async for message in pubsub.listen():
                if message["type"] != "message":
                    continue
                payload = message["data"]
                yield {"event": "progress", "data": payload}
        finally:
            await pubsub.unsubscribe(progress_channel(execution_id))
            await pubsub.close()

    return EventSourceResponse(event_source())
