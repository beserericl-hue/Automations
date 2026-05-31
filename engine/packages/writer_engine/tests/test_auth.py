"""Unit tests for the auth dependencies."""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from writer_engine.auth.api_key import require_api_key
from writer_engine.auth.service_secret import require_admin_token, require_service_secret


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
