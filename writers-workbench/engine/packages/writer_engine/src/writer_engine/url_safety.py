"""Is this user-supplied URL safe for the engine to call? (SSRF guard)

A blog channel's endpoint is typed by a user. Without a check, "post my blog" is a way to make the
engine send a request — with a token attached — to ``http://169.254.169.254/`` (cloud metadata),
to ``localhost``, or to another service on Railway's private network. The rule, the same one the
server applies when the URL is saved (``server/src/lib/url-safety.ts``):

* ``https`` only, no credentials in the URL;
* the host must resolve, and **every** address it resolves to must be public — not private,
  loopback, link-local (which is where metadata lives), CGNAT, multicast, reserved, unspecified,
  or an IPv4 address smuggled inside IPv6.

It is checked again here at send time because DNS can change after the URL was saved.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from collections.abc import Awaitable, Callable
from urllib.parse import urlsplit

Resolver = Callable[[str, int], Awaitable[list[str]]]

_BLOCKED_HOSTS = frozenset({"localhost", "metadata.google.internal", "metadata"})
_CGNAT = ipaddress.ip_network("100.64.0.0/10")


async def system_resolve(host: str, port: int) -> list[str]:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return sorted({str(info[4][0]) for info in infos})


def is_public_ip(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address):
        mapped = ip.ipv4_mapped or ip.sixtofour
        if mapped is not None:
            return is_public_ip(str(mapped))
        if ip.teredo is not None:
            return False
    if isinstance(ip, ipaddress.IPv4Address) and ip in _CGNAT:
        return False
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
        or not ip.is_global
    )


async def check_public_https_url(url: str, *, resolve: Resolver | None = None) -> str | None:
    """None when ``url`` is safe to call; otherwise the reason, fit for a user to read."""
    try:
        parts = urlsplit((url or "").strip())
    except ValueError:
        return "not a valid URL"
    if parts.scheme != "https":
        return "the URL must start with https://"
    if parts.username or parts.password:
        return "the URL must not contain a username or password"
    host = (parts.hostname or "").strip().rstrip(".").lower()
    if not host:
        return "the URL has no host"
    if host in _BLOCKED_HOSTS or host.endswith((".localhost", ".internal", ".local")):
        return f"{host} is not a public host"
    try:
        port = parts.port or 443
    except ValueError:
        return "the URL has an invalid port"
    try:
        literal = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        literal = None
    if literal is not None:
        return None if is_public_ip(str(literal)) else f"{host} is not a public address"
    try:
        addresses = await (resolve or system_resolve)(host, port)
    except Exception:
        return f"{host} does not resolve"
    if not addresses:
        return f"{host} does not resolve"
    bad = [a for a in addresses if not is_public_ip(a)]
    if bad:
        return f"{host} resolves to a non-public address"
    return None


__all__ = ["Resolver", "check_public_https_url", "is_public_ip", "system_resolve"]
