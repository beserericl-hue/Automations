"""Unit tests for the auth dependencies."""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from writer_engine.auth.api_key import require_api_key
from writer_engine.auth.service_secret import require_admin_token, require_service_secret
from writer_engine.config import get_settings


def test_service_secret_rejects_missing() -> None:
    with pytest.raises(HTTPException) as ex:
        require_service_secret(None)
    assert ex.value.status_code == 401


def test_service_secret_accepts_matching() -> None:
    # the conftest sets SERVICE_SHARED_SECRET=test-secret
    require_service_secret("test-secret")


def test_admin_token_rejects_wrong() -> None:
    with pytest.raises(HTTPException):
        require_admin_token("nope")


def test_api_key_rejects_short() -> None:
    with pytest.raises(HTTPException):
        require_api_key("short")


def test_api_key_accepts_long() -> None:
    identity = require_api_key("abcdefghij1234567890")
    assert identity.key_prefix == "abcdef"
    assert identity.tenant_id == "tenant-stub"


# --- G3: unconfigured secrets must fail closed -----------------------------------------------


def test_unconfigured_service_secret_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    """An env that forgot SERVICE_SHARED_SECRET must reject, not accept the empty string.

    Before G3 the default was the public placeholder "dev-service-secret-change-me", so such an
    environment accepted a secret anyone could read out of this repo.
    """
    from fastapi import HTTPException

    from writer_engine.auth.service_secret import require_service_secret

    monkeypatch.setenv("SERVICE_SHARED_SECRET", "")
    get_settings.cache_clear()
    try:
        # No header at all.
        with pytest.raises(HTTPException) as exc:
            require_service_secret(None)
        assert exc.value.status_code == 503
        # And an empty presented secret must not "match" the empty expected one.
        with pytest.raises(HTTPException) as exc:
            require_service_secret("")
        assert exc.value.status_code == 503
        # Nor may any guessed value get through.
        with pytest.raises(HTTPException) as exc:
            require_service_secret("dev-service-secret-change-me")
        assert exc.value.status_code == 503
    finally:
        get_settings.cache_clear()


def test_unconfigured_admin_token_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi import HTTPException

    from writer_engine.auth.service_secret import require_admin_token

    monkeypatch.setenv("ADMIN_TOKEN", "")
    get_settings.cache_clear()
    try:
        with pytest.raises(HTTPException) as exc:
            require_admin_token("dev-admin-token-change-me")
        assert exc.value.status_code == 503
    finally:
        get_settings.cache_clear()


def test_wrong_secret_is_401_not_503(monkeypatch: pytest.MonkeyPatch) -> None:
    """A configured server with a bad caller is 401; only an unconfigured server is 503."""
    from fastapi import HTTPException

    from writer_engine.auth.service_secret import require_service_secret

    monkeypatch.setenv("SERVICE_SHARED_SECRET", "real-secret")
    get_settings.cache_clear()
    try:
        require_service_secret("real-secret")  # must not raise
        with pytest.raises(HTTPException) as exc:
            require_service_secret("wrong")
        assert exc.value.status_code == 401
    finally:
        get_settings.cache_clear()


def test_no_placeholder_defaults_in_settings() -> None:
    """Regression guard: neither secret may ever regain a non-empty compiled-in default."""
    from writer_engine.config import EngineSettings

    for field in ("service_shared_secret", "admin_token"):
        assert EngineSettings.model_fields[field].default == "", (
            f"{field} must default to empty so an unset env fails closed (G3)"
        )
