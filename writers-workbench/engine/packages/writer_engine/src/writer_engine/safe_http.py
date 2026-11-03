"""An httpx client for user-supplied URLs that checks the address it actually connects to.

``url_safety.check_public_https_url`` resolves a host and checks the answer, but the request that
follows resolves it again — and a DNS server that answers "public" to the first lookup and
"169.254.169.254" to the second (DNS rebinding) walks straight past the check. The Workbench server
closes that gap with a custom socket ``lookup`` (``server/src/lib/url-safety.ts``); this module is
the engine's equivalent:

* :class:`PublicOnlyBackend` is an httpcore network backend. When httpcore opens a TCP connection
  it resolves the host **itself**, refuses the connection unless every answer is a public address
  (``url_safety.is_public_ip``), and then connects to one of those validated IPs — never to the
  hostname, so there is no second lookup to rebind. TLS still runs against the hostname (httpcore
  passes the origin host as SNI and certificate hostname) and the ``Host`` header is untouched.
* :class:`SafeTransport` is an ``httpx.AsyncHTTPTransport`` whose connection pool uses that backend
  and which also refuses, before any network call, a disallowed scheme, credentials in the URL, or a
  host name that is internal by name (``localhost``, ``*.internal``, ``*.local``, ``metadata``).
* Redirects need nothing extra: httpx sends every hop through the same transport, so each hop's
  connection is checked the same way. Callers that attach a credential still pass
  ``follow_redirects=False``.

Use :func:`safe_async_client` for anything that fetches a URL a user typed (blog endpoints, feed
URLs, radar feed overrides). Fixed provider hosts (ScraperAPI, Anthropic, Gemini, Supabase) do not
need it.
"""

from __future__ import annotations

import ipaddress
from collections.abc import Iterable
from typing import Any

import anyio
import httpcore
import httpx

from writer_engine.url_safety import Resolver, is_public_ip, system_resolve

_BLOCKED_HOSTS = frozenset({"localhost", "metadata.google.internal", "metadata"})
_BLOCKED_SUFFIXES = (".localhost", ".internal", ".local")
DEFAULT_SCHEMES = ("http", "https")


class UnsafeDestinationError(httpx.ConnectError):
    """The request was refused because its destination is not a public internet address."""


class _BlockedAddress(httpcore.ConnectError):
    """Raised inside httpcore; :class:`SafeTransport` turns it into :class:`UnsafeDestinationError`."""


def host_blocked_by_name(host: str) -> bool:
    h = host.strip().strip("[]").rstrip(".").lower()
    return not h or h in _BLOCKED_HOSTS or h.endswith(_BLOCKED_SUFFIXES)


class PublicOnlyBackend(httpcore.AsyncNetworkBackend):
    """Resolve, validate every answer, connect only to a validated IP."""

    def __init__(
        self, resolve: Resolver | None = None, inner: httpcore.AsyncNetworkBackend | None = None
    ) -> None:
        self._resolve = resolve or system_resolve
        self._inner = inner or httpcore.AnyIOBackend()

    async def public_addresses(self, host: str, port: int, timeout: float | None = None) -> list[str]:  # noqa: ASYNC109
        """The addresses to connect to, or raise when any is not public."""
        bare = host.strip("[]")
        try:
            literal = ipaddress.ip_address(bare.split("%", 1)[0])
        except ValueError:
            literal = None
        if literal is not None:
            if not is_public_ip(bare):
                raise _BlockedAddress(f"{bare} is not a public address")
            return [bare]
        if host_blocked_by_name(bare):
            raise _BlockedAddress(f"{bare} is not a public host")
        try:
            with anyio.fail_after(timeout):
                addresses = await self._resolve(bare, port)
        except TimeoutError as exc:
            raise httpcore.ConnectTimeout(f"{bare}: DNS lookup timed out") from exc
        except (OSError, UnicodeError) as exc:  # socket.gaierror is an OSError
            raise httpcore.ConnectError(f"{bare} does not resolve: {exc}") from exc
        if not addresses:
            raise httpcore.ConnectError(f"{bare} does not resolve")
        # Every answer must be public, not just the one we would pick: the same rule as the save-time
        # check, and it keeps a mixed answer from being a coin toss.
        if any(not is_public_ip(a) for a in addresses):
            raise _BlockedAddress(f"{bare} resolves to a non-public address")
        # IPv4 first: an IPv6 route that is not there costs a connect timeout per attempt.
        return sorted(addresses, key=lambda a: ":" in a)

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,  # noqa: ASYNC109 — httpcore's interface
        local_address: str | None = None,
        socket_options: Iterable[Any] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        last: httpcore.ConnectError | httpcore.ConnectTimeout | None = None
        for ip in await self.public_addresses(host, port, timeout):
            try:
                return await self._inner.connect_tcp(
                    ip,
                    port,
                    timeout=timeout,
                    local_address=local_address,
                    socket_options=socket_options,
                )
            except (httpcore.ConnectError, httpcore.ConnectTimeout) as exc:
                last = exc
        assert last is not None  # public_addresses never returns an empty list
        raise last

    async def connect_unix_socket(
        self,
        path: str,
        timeout: float | None = None,  # noqa: ASYNC109 — httpcore's interface
        socket_options: Iterable[Any] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        raise _BlockedAddress("unix sockets are not allowed")

    async def sleep(self, seconds: float) -> None:
        await self._inner.sleep(seconds)


class SafeTransport(httpx.AsyncHTTPTransport):
    """``AsyncHTTPTransport`` that only reaches public addresses, checked at connect time."""

    def __init__(
        self,
        *,
        resolve: Resolver | None = None,
        schemes: Iterable[str] = DEFAULT_SCHEMES,
        network_backend: httpcore.AsyncNetworkBackend | None = None,
        **kwargs: Any,
    ) -> None:
        kwargs.pop("proxy", None)  # a proxy would connect for us and bypass the backend
        kwargs.pop("uds", None)
        super().__init__(**kwargs)
        pool = self._pool
        if not isinstance(pool, httpcore.AsyncConnectionPool) or not hasattr(pool, "_network_backend"):
            raise RuntimeError("httpx/httpcore layout changed: SafeTransport cannot install its backend")
        # httpx does not expose the pool's network backend; this is the one private attribute we
        # rely on, and tests/test_safe_http.py fails loudly if an httpx upgrade moves it.
        pool._network_backend = PublicOnlyBackend(resolve, inner=network_backend)
        self._schemes = frozenset(s.lower() for s in schemes)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        if url.scheme.lower() not in self._schemes:
            raise UnsafeDestinationError(f"{url.scheme}:// URLs are not allowed", request=request)
        if url.userinfo:
            raise UnsafeDestinationError("the URL must not contain a username or password", request=request)
        if host_blocked_by_name(url.host):
            raise UnsafeDestinationError(f"{url.host or '(no host)'} is not a public host", request=request)
        try:
            return await super().handle_async_request(request)
        except httpx.ConnectError as exc:
            if isinstance(exc.__cause__, _BlockedAddress):
                raise UnsafeDestinationError(str(exc), request=request) from exc
            raise


def safe_async_client(
    *,
    resolve: Resolver | None = None,
    schemes: Iterable[str] = DEFAULT_SCHEMES,
    network_backend: httpcore.AsyncNetworkBackend | None = None,
    **client_kwargs: Any,
) -> httpx.AsyncClient:
    """An ``httpx.AsyncClient`` for user-supplied URLs (see the module docstring)."""
    transport = SafeTransport(resolve=resolve, schemes=schemes, network_backend=network_backend)
    return httpx.AsyncClient(transport=transport, **client_kwargs)


__all__ = [
    "DEFAULT_SCHEMES",
    "PublicOnlyBackend",
    "SafeTransport",
    "UnsafeDestinationError",
    "host_blocked_by_name",
    "safe_async_client",
]
