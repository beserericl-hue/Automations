"""SSRF guard at connect time (writer_engine.safe_http).

Every test runs the real httpx client and the real httpcore connection pool; only the bottom layer
is fake — a network backend that records which address it was asked to open and replays a canned
HTTP response — so what is asserted is exactly what would go on the wire.
"""

from __future__ import annotations

from typing import Any

import httpcore
import httpx
import pytest

from writer_engine import safe_http
from writer_engine.ingestion import feeds
from writer_engine.safe_http import (
    PublicOnlyBackend,
    SafeTransport,
    UnsafeDestinationError,
    safe_async_client,
)
from writer_engine.social import channels as ch
from writer_engine.url_safety import check_public_https_url

PUBLIC_V4 = "93.184.216.34"
PUBLIC_V4_B = "93.184.216.35"


def _http(status: int = 200, body: bytes = b"ok", headers: dict[str, str] | None = None) -> bytes:
    hdrs = {"Content-Length": str(len(body)), "Content-Type": "text/plain", **(headers or {})}
    head = "".join(f"{k}: {v}\r\n" for k, v in hdrs.items())
    return f"HTTP/1.1 {status} X\r\n{head}\r\n".encode() + body


class FakeStream(httpcore.AsyncNetworkStream):
    def __init__(self, backend: FakeBackend, ip: str, response: bytes) -> None:
        self.backend, self.ip, self._response = backend, ip, response
        self.written = b""

    async def read(self, max_bytes: int, timeout: float | None = None) -> bytes:  # noqa: ASYNC109
        out, self._response = self._response[:max_bytes], self._response[max_bytes:]
        return out

    async def write(self, buffer: bytes, timeout: float | None = None) -> None:  # noqa: ASYNC109
        self.written += buffer
        self.backend.requests.append((self.ip, buffer))

    async def aclose(self) -> None:
        return None

    async def start_tls(
        self,
        ssl_context: Any,
        server_hostname: str | None = None,
        timeout: float | None = None,  # noqa: ASYNC109
    ) -> httpcore.AsyncNetworkStream:
        self.backend.tls.append((self.ip, server_hostname))
        return self

    def get_extra_info(self, info: str) -> Any:
        return None


class FakeBackend(httpcore.AsyncNetworkBackend):
    """Records every connect; serves ``responses[ip]`` (default 200 ok)."""

    def __init__(self, responses: dict[str, bytes] | None = None) -> None:
        self.responses = responses or {}
        self.connects: list[tuple[str, int]] = []
        self.tls: list[tuple[str, str | None]] = []
        self.requests: list[tuple[str, bytes]] = []

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,  # noqa: ASYNC109
        local_address: str | None = None,
        socket_options: Any = None,
    ) -> httpcore.AsyncNetworkStream:
        self.connects.append((host, port))
        return FakeStream(self, host, self.responses.get(host, _http()))

    async def sleep(self, seconds: float) -> None:
        return None


def _resolver(table: dict[str, list[str]]):
    calls: list[str] = []

    async def resolve(host: str, port: int) -> list[str]:
        calls.append(host)
        if host not in table:
            raise OSError(f"no such host {host}")
        return table[host]

    resolve.calls = calls  # type: ignore[attr-defined]
    return resolve


def _client(resolve, backend: FakeBackend, **kw: Any) -> httpx.AsyncClient:
    return safe_async_client(resolve=resolve, network_backend=backend, **kw)


# --- every blocked address class, reached through DNS ----------------------------------------------

BLOCKED_ANSWERS = [
    "10.0.0.5",  # private
    "172.16.3.4",
    "192.168.1.1",
    "127.0.0.1",  # loopback
    "::1",
    "169.254.169.254",  # link-local / AWS+GCP metadata
    "fe80::1",
    "fd00:ec2::254",  # AWS IMDS over IPv6 (ULA)
    "fd12:3456::1",  # Railway private network (ULA)
    "100.64.0.1",  # CGNAT
    "100.127.255.254",
    "224.0.0.1",  # multicast
    "ff02::1",
    "0.0.0.0",  # unspecified
    "::",
    "240.0.0.1",  # reserved
    "198.18.0.1",  # benchmarking
    "::ffff:127.0.0.1",  # IPv4-mapped
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "::7f00:1",  # IPv4-compatible
    "::a9fe:a9fe",
    "64:ff9b::a9fe:a9fe",  # NAT64-embedded metadata
    "2002:a9fe:a9fe::1",  # 6to4-embedded metadata
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",  # Teredo
]


@pytest.mark.parametrize("answer", BLOCKED_ANSWERS)
async def test_hostname_resolving_to_blocked_address_is_refused(answer: str) -> None:
    backend = FakeBackend()
    async with _client(_resolver({"evil.example.com": [answer]}), backend) as http:
        with pytest.raises(UnsafeDestinationError, match="non-public"):
            await http.get("https://evil.example.com/hook")
    assert backend.connects == []  # nothing ever left the box


@pytest.mark.parametrize(
    "url",
    [
        "http://169.254.169.254/latest/meta-data/",
        "http://[fd00:ec2::254]/latest/meta-data/",
        "http://[::ffff:169.254.169.254]/",
        "http://[::ffff:a9fe:a9fe]/",
        "http://127.0.0.1:8080/internal",
        "http://[::1]/",
        "https://10.1.2.3/",
        "https://100.100.100.100/",
        "http://0.0.0.0/",
    ],
)
async def test_literal_ip_urls_are_refused(url: str) -> None:
    backend = FakeBackend()
    resolve = _resolver({})
    async with _client(resolve, backend) as http:
        with pytest.raises(UnsafeDestinationError):
            await http.get(url)
    assert backend.connects == []
    assert resolve.calls == []  # type: ignore[attr-defined]


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:8000/",
        "https://orchestrator.railway.internal/internal/hub",
        "http://metadata.google.internal/computeMetadata/v1/",
        "http://metadata/",
        "https://printer.local/",
        "https://foo.localhost/",
    ],
)
async def test_internal_host_names_are_refused_before_any_lookup(url: str) -> None:
    backend = FakeBackend()
    resolve = _resolver({})
    async with _client(resolve, backend) as http:
        with pytest.raises(UnsafeDestinationError, match="not a public host"):
            await http.get(url)
    assert resolve.calls == []  # type: ignore[attr-defined]
    assert backend.connects == []


async def test_mixed_answer_is_refused_even_if_one_address_is_public() -> None:
    backend = FakeBackend()
    async with _client(_resolver({"mixed.example.com": [PUBLIC_V4, "10.0.0.1"]}), backend) as http:
        with pytest.raises(UnsafeDestinationError):
            await http.get("https://mixed.example.com/")
    assert backend.connects == []


@pytest.mark.parametrize("url", ["ftp://example.com/x", "file:///etc/passwd"])
async def test_other_schemes_are_refused(url: str) -> None:
    async with _client(_resolver({}), FakeBackend()) as http:
        with pytest.raises((UnsafeDestinationError, httpx.UnsupportedProtocol)):
            await http.get(url)


async def test_https_only_client_refuses_http() -> None:
    backend = FakeBackend()
    http = safe_async_client(
        resolve=_resolver({"example.com": [PUBLIC_V4]}), network_backend=backend, schemes=("https",)
    )
    async with http:
        with pytest.raises(UnsafeDestinationError, match="http://"):
            await http.get("http://example.com/")
    assert backend.connects == []


async def test_credentials_in_url_are_refused() -> None:
    async with _client(_resolver({"example.com": [PUBLIC_V4]}), FakeBackend()) as http:
        with pytest.raises(UnsafeDestinationError, match="username or password"):
            await http.get("https://user:pw@example.com/")


async def test_unresolvable_host_is_a_plain_connect_error() -> None:
    async with _client(_resolver({}), FakeBackend()) as http:
        with pytest.raises(httpx.ConnectError) as info:
            await http.get("https://nope.example.com/")
    assert not isinstance(info.value, UnsafeDestinationError)
    assert "does not resolve" in str(info.value)


# --- the allowed path: connect to the validated IP, TLS + Host still name the host ------------------


async def test_public_host_connects_to_the_validated_ip_with_sni_and_host_header() -> None:
    backend = FakeBackend()
    async with _client(_resolver({"blog.example.com": [PUBLIC_V4]}), backend) as http:
        resp = await http.post("https://blog.example.com/api/posts", json={"a": 1})
    assert resp.status_code == 200
    assert backend.connects == [(PUBLIC_V4, 443)]  # the IP, never the name
    assert backend.tls == [(PUBLIC_V4, "blog.example.com")]  # SNI + cert check against the name
    sent = b"".join(b for _, b in backend.requests)
    assert b"Host: blog.example.com\r\n" in sent
    assert sent.startswith(b"POST /api/posts HTTP/1.1\r\n")


async def test_ipv4_answer_is_tried_before_ipv6() -> None:
    backend = FakeBackend()
    resolve = _resolver({"dual.example.com": ["2606:4700::6810:84e5", PUBLIC_V4]})
    async with _client(resolve, backend) as http:
        await http.get("https://dual.example.com/")
    assert backend.connects[0] == (PUBLIC_V4, 443)


async def test_public_literal_ip_is_allowed() -> None:
    backend = FakeBackend()
    async with _client(_resolver({}), backend) as http:
        resp = await http.get(f"http://{PUBLIC_V4}/feed.xml")
    assert resp.status_code == 200
    assert backend.connects == [(PUBLIC_V4, 80)]


# --- DNS rebinding -----------------------------------------------------------------------------------


def _rebinding_resolver(first: str, then: str):
    """Answers ``first`` to the first lookup and ``then`` to every later one (TTL-0 rebinding)."""
    calls: list[str] = []

    async def resolve(host: str, port: int) -> list[str]:
        calls.append(host)
        return [first] if len(calls) == 1 else [then]

    resolve.calls = calls  # type: ignore[attr-defined]
    return resolve


async def test_rebinding_after_the_save_time_check_is_refused_at_connect() -> None:
    resolve = _rebinding_resolver(PUBLIC_V4, "169.254.169.254")
    backend = FakeBackend()
    # The pre-flight check (what send_website / the server's save check do) sees a public answer...
    assert await check_public_https_url("https://rebind.example.com/hook", resolve=resolve) is None
    # ...and the connection, which resolves again, sees the metadata address and refuses.
    async with _client(resolve, backend) as http:
        with pytest.raises(UnsafeDestinationError, match="non-public"):
            await http.post("https://rebind.example.com/hook", json={})
    assert backend.connects == []
    assert len(resolve.calls) == 2  # type: ignore[attr-defined]


async def test_connection_goes_to_the_address_that_was_validated_not_a_fresh_lookup() -> None:
    # Public both times but different: the connect must use the exact answer it validated — one
    # lookup per connection, no second resolution between check and connect.
    resolve = _rebinding_resolver(PUBLIC_V4, PUBLIC_V4_B)
    backend = FakeBackend()
    async with _client(resolve, backend) as http:
        await http.get("https://rebind.example.com/")
    assert backend.connects == [(PUBLIC_V4, 443)]
    assert len(resolve.calls) == 1  # type: ignore[attr-defined]


async def test_send_website_refuses_a_rebinding_endpoint_and_sends_no_token() -> None:
    resolve = _rebinding_resolver(PUBLIC_V4, "10.0.0.7")
    backend = FakeBackend()
    channel = ch.Channel(
        user_id="u1",
        channel="blog",
        kind="website",
        label="Blog",
        config={"endpoint": "https://rebind.example.com/api"},
    )
    async with _client(resolve, backend) as http:
        result = await ch.send_website(http, channel, {"title": "t"}, token="secret-token", resolve=resolve)
    assert result.status == "failed"
    assert "endpoint refused" in result.detail and "non-public" in result.detail
    assert backend.requests == []  # the token never went anywhere


# --- redirects: every hop is checked -----------------------------------------------------------------


@pytest.mark.parametrize(
    "location",
    [
        "http://169.254.169.254/latest/meta-data/iam/",
        "http://[fd00:ec2::254]/",
        "http://localhost:9000/",
        "https://internal.example.com/",  # resolves private
        "http://[::ffff:10.0.0.1]/",
    ],
)
async def test_redirect_to_a_blocked_destination_is_refused(location: str) -> None:
    backend = FakeBackend({PUBLIC_V4: _http(302, b"", {"Location": location})})
    resolve = _resolver({"feeds.example.com": [PUBLIC_V4], "internal.example.com": ["10.9.9.9"]})
    async with _client(resolve, backend, follow_redirects=True) as http:
        with pytest.raises(UnsafeDestinationError):
            await http.get("https://feeds.example.com/rss")
    assert backend.connects == [(PUBLIC_V4, 443)]  # only the first, public hop


async def test_redirect_to_a_public_host_is_followed() -> None:
    backend = FakeBackend(
        {PUBLIC_V4: _http(301, b"", {"Location": "https://cdn.example.net/rss.xml"}), PUBLIC_V4_B: _http()}
    )
    resolve = _resolver({"feeds.example.com": [PUBLIC_V4], "cdn.example.net": [PUBLIC_V4_B]})
    async with _client(resolve, backend, follow_redirects=True) as http:
        resp = await http.get("https://feeds.example.com/rss")
    assert resp.status_code == 200
    assert backend.connects == [(PUBLIC_V4, 443), (PUBLIC_V4_B, 443)]


# --- wiring ------------------------------------------------------------------------------------------


def test_transport_installs_the_backend_on_httpx_pool() -> None:
    """Fails loudly if an httpx/httpcore upgrade moves the pool's private backend attribute."""
    transport = SafeTransport()
    assert isinstance(transport._pool, httpcore.AsyncConnectionPool)
    assert isinstance(transport._pool._network_backend, PublicOnlyBackend)


def test_proxy_is_never_used() -> None:
    transport = SafeTransport(proxy="http://proxy.example.com:3128")
    assert isinstance(transport._pool, httpcore.AsyncConnectionPool)


async def test_fetch_feed_without_a_client_uses_the_safe_client() -> None:
    with pytest.raises(UnsafeDestinationError):
        await feeds.fetch_feed("http://169.254.169.254/latest/meta-data/")
    with pytest.raises(UnsafeDestinationError):
        await feeds.fetch_feed("http://localhost:8080/feed.xml")


def test_module_exports() -> None:
    assert set(safe_http.__all__) >= {"safe_async_client", "UnsafeDestinationError", "SafeTransport"}
