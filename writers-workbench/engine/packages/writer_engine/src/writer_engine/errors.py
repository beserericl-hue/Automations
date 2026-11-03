"""What the engine's external dependencies raise, so a failure handler can name it.

A handler that catches ``Exception`` around a database call treats a ``KeyError`` in the code that
built the row exactly like a network blip: logged as "write failed" and swallowed. Catching these
tuples instead lets the outage path stay soft while a programming error fails loudly where it
happened. ``ruff``'s BLE001 rule keeps new blanket handlers out; one that is deliberately broad says
why in a ``# noqa: BLE001 - <reason>`` comment.

Each tuple is the closed set a call into that dependency raises, checked against the installed
libraries (postgrest/supabase 2.30, redis 5.3, httpx 0.28):

* **Supabase** (postgrest, storage3, supabase-py): ``APIError`` for any PostgREST error response and
  for a body it cannot parse; ``StorageException`` from storage; ``SupabaseException`` from client
  construction; ``httpx.HTTPError`` for transport failures (timeouts, resets, protocol errors);
  ``httpx.InvalidURL`` for a malformed project URL. ``RuntimeError`` is what
  :func:`writer_engine.supabase.client.get_supabase_admin` raises when the project is not
  configured. ``ValueError`` covers pydantic ``ValidationError`` from response models and JSON
  decoding. ``OSError`` covers socket errors and the builtin ``TimeoutError``.
* **Redis** (redis-py asyncio): every client error derives from ``RedisError`` (``ConnectionError``,
  ``TimeoutError``, ``WatchError``, ``ResponseError``). ``OSError`` covers a socket error raised
  before redis-py wraps it and ``asyncio.wait_for`` timeouts (the builtin ``TimeoutError``).
  ``ValueError`` is a malformed ``REDIS_URL`` rejected by ``from_url``. ``RuntimeError`` is a pooled
  connection used from a closed or different event loop ("Event loop is closed", "attached to a
  different loop"), which happens to the process-wide client across arq jobs and test loops.
* **HTTP** (httpx): ``HTTPError`` (transport, timeout, status from ``raise_for_status``, decoding),
  ``InvalidURL`` (not an ``HTTPError``), ``OSError``, and ``RuntimeError``: ``StreamError`` is one,
  and so is "Cannot send a request, as the client has been closed". ``ValueError`` covers
  ``Response.json()`` on a body that is not JSON. The engine's SSRF guard
  (:mod:`writer_engine.safe_http`) raises ``UnsafeDestinationError``, an ``httpx.ConnectError``.
"""

from __future__ import annotations

import httpx
from postgrest.exceptions import APIError
from redis.exceptions import RedisError
from storage3.exceptions import StorageException
from supabase import AsyncSupabaseException, SupabaseException

ErrorTypes = tuple[type[BaseException], ...]

SUPABASE_ERRORS: ErrorTypes = (
    APIError,
    StorageException,
    AsyncSupabaseException,  # the async client's own class, not a subclass of the sync one
    SupabaseException,
    httpx.HTTPError,
    httpx.InvalidURL,
    RuntimeError,
    ValueError,
    OSError,
)

REDIS_ERRORS: ErrorTypes = (RedisError, OSError, ValueError, RuntimeError)

HTTP_ERRORS: ErrorTypes = (httpx.HTTPError, httpx.InvalidURL, RuntimeError, ValueError, OSError)

__all__ = ["HTTP_ERRORS", "REDIS_ERRORS", "SUPABASE_ERRORS", "ErrorTypes"]
