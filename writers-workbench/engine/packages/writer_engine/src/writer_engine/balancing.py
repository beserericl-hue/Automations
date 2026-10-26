"""Spread calls across a service's replicas on Railway's private network (CR-010 C1).

Railway load-balances a service's PUBLIC domain across its replicas. The private name
(``<service>.railway.internal``) has no load balancer in front of it: it resolves to the replicas'
addresses, and a client that connects to the first one, as every HTTP client does, sends everything
to one replica. Measured on DEV 2026-10-26 with two gateway and two runtime replicas: the public
gateway domain split 14/6, while 30 of 30 Workbench → gateway → runtime calls landed on the same
gateway and the same runtime.

Queued work was never affected, since every worker pulls from the same Redis queues. Synchronous
calls (hub routing, sync tools, job polls) were: one replica of each service took all of them.

So the caller picks a replica: it resolves the private name, picks one address at random and
connects to it directly. Resolution is cached for a few seconds, so a replica added by the autoscaler
starts taking calls within that window, and one removed stops being picked once its address is gone.
Callers retry once by hostname on a connection error, so an address that stops answering costs a
retry, never a failed call. Anything that is not a ``*.railway.internal`` name (localhost, docker-compose, a public URL) is
returned unchanged, as is everything when the lookup fails or finds only one address.
"""

from __future__ import annotations

import asyncio
import random
import socket
import time
from urllib.parse import urlsplit, urlunsplit

from writer_engine.telemetry.logging import get_logger

logger = get_logger("balancing")

PRIVATE_SUFFIX = ".railway.internal"
CACHE_S = 5.0

_cache: dict[tuple[str, int], tuple[float, list[str]]] = {}


async def addresses(host: str, port: int) -> list[str]:
    """Every address ``host`` resolves to, cached for CACHE_S. ``[]`` when it does not resolve."""
    key = (host, port)
    hit = _cache.get(key)
    now = time.monotonic()
    if hit and now - hit[0] < CACHE_S:
        return hit[1]
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
        v4 = sorted({str(i[4][0]) for i in infos if i[0] == socket.AF_INET})
        v6 = sorted({str(i[4][0]) for i in infos if i[0] == socket.AF_INET6})
        # One family only. Each replica answers on an IPv4 AND an IPv6 address, and the engine binds
        # 0.0.0.0, so an IPv6 pick was refused: 21 of 30 calls failed on DEV the first time this
        # shipped. IPv4 when the name has any (that is what the services listen on), else IPv6.
        found = v4 or v6
    except Exception as exc:
        logger.debug("balancing.resolve_failed", host=host, error=f"{type(exc).__name__}: {exc}"[:120])
        found = []
    _cache[key] = (now, found)
    return found


async def spread(url: str) -> str:
    """``url`` with its private hostname replaced by one replica's address, picked at random."""
    parts = urlsplit(url)
    host = parts.hostname or ""
    if not host.endswith(PRIVATE_SUFFIX):
        return url
    port = parts.port or (443 if parts.scheme == "https" else 80)
    found = await addresses(host, port)
    if len(found) < 2:
        return url
    ip = random.choice(found)
    netloc = f"[{ip}]:{port}" if ":" in ip else f"{ip}:{port}"
    return urlunsplit(parts._replace(netloc=netloc))


async def replica_count(url: str) -> int:
    """How many addresses the URL's host resolves to (0 if it does not). Shown in the fleet view so
    "is this hop being spread" can be read rather than inferred."""
    parts = urlsplit(url)
    if not parts.hostname:
        return 0
    return len(await addresses(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80)))


__all__ = ["CACHE_S", "PRIVATE_SUFFIX", "addresses", "replica_count", "spread"]
