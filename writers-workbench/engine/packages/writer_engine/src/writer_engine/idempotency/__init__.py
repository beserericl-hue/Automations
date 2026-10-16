"""Two different idempotency mechanisms, for two different units of work.

* ``idempotent_call`` — a Redis result cache keyed by the caller, used *inside* a step so a replayed
  step call does not redo an expensive fetch. Short-lived (hours), and only three steps use it.
* the **run ledger** (``claim_run``/``complete_run``/``fail_run``) — a durable Postgres record of
  whether an async JOB has already persisted its work, so an arq retry after a worker restart does
  not insert a second research report or a second billing row. B6; migration 028.

The first is a cache and may be lost without consequence. The second must not be, which is why it is
in Postgres and not in the Redis instance whose restart causes the retries in the first place.
"""

from .decorator import idempotent_call
from .run_ledger import (
    MAX_RESULT_BYTES,
    STATUS_COMPLETE,
    STATUS_ERROR,
    STATUS_IN_PROGRESS,
    RunClaim,
    claim_run,
    complete_run,
    fail_run,
)

__all__ = [
    "MAX_RESULT_BYTES",
    "STATUS_COMPLETE",
    "STATUS_ERROR",
    "STATUS_IN_PROGRESS",
    "RunClaim",
    "claim_run",
    "complete_run",
    "fail_run",
    "idempotent_call",
]
