"""Per-user integration credentials (migration 043, ``user_integrations_v2``).

Blotato and a blog website are the *user's* accounts, not the company's: another customer posts to
their own LinkedIn pages through their own Blotato account and to their own blog. So the keys live
in the database, one row per user per integration, and never in a Railway variable that every user
would share.

**At rest.** Each secret is AES-256-GCM encrypted by the Workbench server before it is stored. The
key is ``INTEGRATIONS_ENCRYPTION_KEY`` (32 random bytes, base64), set only on the server and on the
engine runtime. The database holds ciphertext and the last four characters, nothing else, and the
table has no read policy for signed-in users, so PostgREST cannot hand it to a browser either.

**Format.** ``v1.<iv b64url>.<ciphertext+tag b64url>``. The additional authenticated data is
``user_id|provider|channel``, so a ciphertext copied onto another user's row (or another channel's)
fails to decrypt instead of quietly sending one user's token with another user's post.

The engine only decrypts. ``encrypt`` is here for tests and for parity with the server
(``server/src/lib/integration-crypto.ts``), which uses the same format.
"""

from __future__ import annotations

import base64
import os
from dataclasses import dataclass, field
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from writer_engine.telemetry import redaction
from writer_engine.telemetry.logging import get_logger

logger = get_logger("integrations")

TABLE = "user_integrations_v2"
VERSION = "v1"
ENV_KEY = "INTEGRATIONS_ENCRYPTION_KEY"


class IntegrationKeyError(RuntimeError):
    """The encryption key is missing or malformed. Never carries the key."""


class DecryptError(RuntimeError):
    """A stored secret could not be decrypted (wrong key, tampered, or moved to another row)."""


def _b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _unb64u(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def load_key(raw: str | None = None) -> bytes:
    """The 32-byte key from ``INTEGRATIONS_ENCRYPTION_KEY`` (base64 or base64url)."""
    value = (raw if raw is not None else _configured_key()).strip()
    if not value:
        raise IntegrationKeyError(f"{ENV_KEY} is not set on this service")
    try:
        std = value.replace("-", "+").replace("_", "/")
        key = base64.b64decode(std + "=" * (-len(std) % 4), validate=True)
    except Exception as exc:
        raise IntegrationKeyError(f"{ENV_KEY} is not valid base64") from exc
    if len(key) != 32:
        raise IntegrationKeyError(f"{ENV_KEY} must decode to 32 bytes (got {len(key)})")
    return key


def _configured_key() -> str:
    try:
        from writer_engine.config import get_settings

        return get_settings().integrations_encryption_key or ""
    except Exception:  # pragma: no cover - settings unavailable
        return os.environ.get(ENV_KEY, "")


def aad_for(user_id: str, provider: str, channel: str | None) -> bytes:
    return f"{user_id}|{provider}|{channel or ''}".encode()


def encrypt(plaintext: str, *, user_id: str, provider: str, channel: str | None, key: bytes) -> str:
    iv = os.urandom(12)
    sealed = AESGCM(key).encrypt(iv, plaintext.encode("utf-8"), aad_for(user_id, provider, channel))
    return f"{VERSION}.{_b64u(iv)}.{_b64u(sealed)}"


def decrypt(token: str, *, user_id: str, provider: str, channel: str | None, key: bytes) -> str:
    try:
        version, iv_b64, sealed_b64 = token.split(".")
        if version != VERSION:
            raise DecryptError(f"unknown secret format {version!r}")
        plain = AESGCM(key).decrypt(_unb64u(iv_b64), _unb64u(sealed_b64), aad_for(user_id, provider, channel))
        return plain.decode("utf-8")
    except DecryptError:
        raise
    except Exception as exc:
        # Deliberately no detail: InvalidTag says nothing useful, and nothing here may echo input.
        raise DecryptError("stored secret could not be decrypted") from exc


@dataclass
class UserCredentials:
    """What the poster needs for one user. Empty strings mean "not configured"."""

    user_id: str
    blotato_api_key: str = ""
    blotato_account_id: str = ""
    website_tokens: dict[str, str] = field(default_factory=dict)
    problems: list[str] = field(default_factory=list)
    """Rows that exist but could not be read (decrypt failure, missing key). Reported in deliveries."""

    def website_token(self, channel: str) -> str:
        return self.website_tokens.get(channel, "")


async def load_user_credentials(client: Any, user_id: str) -> UserCredentials:
    """Decrypt this user's integration secrets. Never raises; problems are collected instead."""
    creds = UserCredentials(user_id=user_id)
    try:
        resp = await client.table(TABLE).select("*").eq("user_id", user_id).execute()
    except Exception as exc:
        creds.problems.append(f"could not read integrations: {type(exc).__name__}")
        return creds
    rows = list(resp.data or [])
    key: bytes | None = None
    if any(r.get("secret_ciphertext") for r in rows):
        try:
            key = load_key()
        except IntegrationKeyError as exc:
            creds.problems.append(str(exc))
    for row in rows:
        provider = str(row.get("provider") or "")
        channel = row.get("channel")
        config = dict(row.get("config") or {})
        secret = ""
        cipher = str(row.get("secret_ciphertext") or "")
        if cipher and key is not None:
            try:
                secret = decrypt(cipher, user_id=user_id, provider=provider, channel=channel, key=key)
                redaction.register_secret(secret)
            except DecryptError as exc:
                where = f"{provider}" + (f"/{channel}" if channel else "")
                creds.problems.append(f"{where}: {exc}")
                logger.warning(
                    "integrations.decrypt_failed", user_id=user_id, provider=provider, channel=channel
                )
        if provider == "blotato":
            creds.blotato_api_key = secret
            creds.blotato_account_id = str(config.get("account_id") or "").strip()
        elif provider == "website" and channel:
            if secret:
                creds.website_tokens[str(channel)] = secret
    return creds


__all__ = [
    "ENV_KEY",
    "TABLE",
    "DecryptError",
    "IntegrationKeyError",
    "UserCredentials",
    "aad_for",
    "decrypt",
    "encrypt",
    "load_key",
    "load_user_credentials",
]
