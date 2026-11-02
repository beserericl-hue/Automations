"""Per-user integration secrets: AES-256-GCM round trip, row binding, key handling, redaction, and
the SSRF guard on user-supplied blog endpoints."""

from __future__ import annotations

import base64

import pytest

from writer_engine import integrations
from writer_engine.telemetry import redaction
from writer_engine.url_safety import check_public_https_url, is_public_ip

KEY_B64 = base64.b64encode(bytes(range(32))).decode()
KEY = integrations.load_key(KEY_B64)

# Produced by the Workbench server (server/src/lib/integration-crypto.ts) with KEY_B64 above, for
# user "+14105914612", provider "website", channel "website", plaintext "parity-check-token".
# If this stops decrypting, the server and the engine no longer agree on the format.
SERVER_VECTOR = "v1.luMm1eQlCAM0NdTE.wrSQaiChZsLkz4fjU44DwytGXcbaDPOj2xxfjTTgQXQbIw"


def test_round_trip() -> None:
    token = integrations.encrypt("s3cret-value", user_id="u1", provider="blotato", channel=None, key=KEY)
    assert token.startswith("v1.") and "s3cret" not in token
    assert (
        integrations.decrypt(token, user_id="u1", provider="blotato", channel=None, key=KEY) == "s3cret-value"
    )


def test_every_encryption_uses_a_fresh_iv() -> None:
    a = integrations.encrypt("same", user_id="u1", provider="blotato", channel=None, key=KEY)
    b = integrations.encrypt("same", user_id="u1", provider="blotato", channel=None, key=KEY)
    assert a != b


@pytest.mark.parametrize(
    ("user_id", "provider", "channel"),
    [("u2", "website", "blog"), ("u1", "blotato", "blog"), ("u1", "website", "other_blog")],
)
def test_a_ciphertext_is_bound_to_its_row(user_id: str, provider: str, channel: str | None) -> None:
    token = integrations.encrypt("tok", user_id="u1", provider="website", channel="blog", key=KEY)
    with pytest.raises(integrations.DecryptError):
        integrations.decrypt(token, user_id=user_id, provider=provider, channel=channel, key=KEY)


def test_wrong_key_and_tampering_fail_closed() -> None:
    token = integrations.encrypt("tok", user_id="u1", provider="blotato", channel=None, key=KEY)
    with pytest.raises(integrations.DecryptError):
        integrations.decrypt(token, user_id="u1", provider="blotato", channel=None, key=bytes(32))
    v, iv, sealed = token.split(".")
    flipped = sealed[:-2] + ("A" if sealed[-2] != "A" else "B") + sealed[-1]
    with pytest.raises(integrations.DecryptError):
        integrations.decrypt(f"{v}.{iv}.{flipped}", user_id="u1", provider="blotato", channel=None, key=KEY)
    with pytest.raises(integrations.DecryptError):
        integrations.decrypt("v9.x.y", user_id="u1", provider="blotato", channel=None, key=KEY)


def test_key_validation() -> None:
    with pytest.raises(integrations.IntegrationKeyError, match="not set"):
        integrations.load_key("")
    with pytest.raises(integrations.IntegrationKeyError, match="32 bytes"):
        integrations.load_key(base64.b64encode(b"short").decode())
    url_safe = base64.urlsafe_b64encode(bytes(range(32))).decode().rstrip("=")
    assert integrations.load_key(url_safe) == KEY


def test_the_server_and_engine_agree_on_the_format() -> None:
    plain = integrations.decrypt(
        SERVER_VECTOR, user_id="+14105914612", provider="website", channel="website", key=KEY
    )
    assert plain == "parity-check-token"


@pytest.mark.asyncio
async def test_missing_encryption_key_is_a_reported_problem_not_a_crash(
    fake_supabase: object, monkeypatch: pytest.MonkeyPatch
) -> None:
    from writer_engine.config import get_settings

    monkeypatch.delenv("INTEGRATIONS_ENCRYPTION_KEY", raising=False)
    get_settings.cache_clear()
    token = integrations.encrypt("abc", user_id="u1", provider="blotato", channel=None, key=KEY)
    fake_supabase.tables["user_integrations_v2"] = [  # type: ignore[attr-defined]
        {
            "user_id": "u1",
            "provider": "blotato",
            "channel": None,
            "config": {"account_id": "7"},
            "secret_ciphertext": token,
        }
    ]
    creds = await integrations.load_user_credentials(fake_supabase, "u1")
    get_settings.cache_clear()
    assert creds.blotato_api_key == "" and creds.blotato_account_id == "7"
    assert any("INTEGRATIONS_ENCRYPTION_KEY is not set" in p for p in creds.problems)


@pytest.mark.asyncio
async def test_decrypted_secrets_are_redacted_from_logs(
    fake_supabase: object, monkeypatch: pytest.MonkeyPatch
) -> None:
    from writer_engine.config import get_settings

    monkeypatch.setenv("INTEGRATIONS_ENCRYPTION_KEY", KEY_B64)
    get_settings.cache_clear()
    secret = "plainlooking-user-token-42"  # matches none of the key-shape patterns
    fake_supabase.tables["user_integrations_v2"] = [  # type: ignore[attr-defined]
        {
            "user_id": "u1",
            "provider": "website",
            "channel": "blog",
            "config": {},
            "secret_ciphertext": integrations.encrypt(
                secret, user_id="u1", provider="website", channel="blog", key=KEY
            ),
        }
    ]
    creds = await integrations.load_user_credentials(fake_supabase, "u1")
    get_settings.cache_clear()
    assert creds.website_token("blog") == secret
    assert secret not in redaction.redact(f"HTTP 401: bad token {secret}")


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.5",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "224.0.0.1",
        "::1",
        "fe80::1",
        "fc00::1",
        "::ffff:127.0.0.1",
        "::ffff:10.0.0.1",
        "fd12:3456::1",
    ],
)
def test_non_public_addresses_are_rejected(address: str) -> None:
    assert is_public_ip(address) is False


@pytest.mark.parametrize("address", ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"])
def test_public_addresses_are_allowed(address: str) -> None:
    assert is_public_ip(address) is True


async def _dns(addresses: list[str]):  # type: ignore[no-untyped-def]
    async def resolve(_host: str, _port: int) -> list[str]:
        return addresses

    return resolve


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("url", "dns", "reason"),
    [
        ("http://blog.example.com/api", ["93.184.216.34"], "https://"),
        ("https://user:pw@blog.example.com/api", ["93.184.216.34"], "username"),
        ("https://localhost/api", ["127.0.0.1"], "not a public host"),
        ("https://metadata.google.internal/", ["169.254.169.254"], "not a public host"),
        ("https://169.254.169.254/latest/meta-data", [], "not a public address"),
        ("https://[::1]/x", [], "not a public address"),
        ("https://rebind.example.com/api", ["93.184.216.34", "10.0.0.7"], "non-public"),
        ("https://gone.example.com/api", [], "does not resolve"),
        ("not a url", [], "https://"),
    ],
)
async def test_ssrf_rejections(url: str, dns: list[str], reason: str) -> None:
    problem = await check_public_https_url(url, resolve=await _dns(dns))
    assert problem is not None and reason in problem


@pytest.mark.asyncio
async def test_a_public_https_endpoint_is_allowed() -> None:
    assert (
        await check_public_https_url("https://www.techahir.com/api/blog", resolve=await _dns(["76.76.21.21"]))
        is None
    )
