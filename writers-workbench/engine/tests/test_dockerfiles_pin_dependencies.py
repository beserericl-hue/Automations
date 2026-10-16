"""The deployed image must install the dependencies the tests ran against.

Found the hard way on 2026-10-16. Every engine Dockerfile copied each ``pyproject.toml`` but none
copied ``uv.lock``, so ``uv sync`` resolved fresh at build time and the deployed engine ran whatever
was newest on the day it built. Twenty-one of them also wrote::

    RUN uv sync --frozen --package X --no-dev || uv sync --package X --no-dev

With no lock in the image the ``--frozen`` arm could never succeed, so the unlocked fallback was the
only arm that ever ran — a guard that looked present in review and could not fire.

The symptom was a live failure on DEV with a locally green test suite: every ``chapter`` LLM call
returned

    TypeError: AsyncMessages.create() got an unexpected keyword argument 'temperature'

because the image had a newer ``anthropic`` than the locked 0.105.2 that ruff, mypy and the whole
suite had passed against.

This test is cheap and specific, and it is the only thing standing between us and that recurring.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ENGINE_ROOT = Path(__file__).resolve().parents[1]
DOCKERFILES = sorted(ENGINE_ROOT.glob("services/*/Dockerfile"))


def test_there_are_dockerfiles_to_check() -> None:
    """A glob that matches nothing would make every assertion below vacuously pass."""
    assert len(DOCKERFILES) >= 20, [str(p) for p in DOCKERFILES]


@pytest.mark.parametrize("dockerfile", DOCKERFILES, ids=lambda p: p.parent.name)
def test_the_image_copies_the_lock_file(dockerfile: Path) -> None:
    body = dockerfile.read_text()
    assert re.search(r"^COPY\s+uv\.lock\s", body, re.M), (
        f"{dockerfile.relative_to(ENGINE_ROOT)} does not COPY uv.lock, so `uv sync` in this image "
        "resolves dependencies at build time instead of installing the locked, tested versions"
    )


@pytest.mark.parametrize("dockerfile", DOCKERFILES, ids=lambda p: p.parent.name)
def test_every_sync_is_frozen(dockerfile: Path) -> None:
    body = dockerfile.read_text()
    syncs = [
        line.strip() for line in body.splitlines() if "uv sync" in line and not line.strip().startswith("#")
    ]
    assert syncs, f"{dockerfile.relative_to(ENGINE_ROOT)} never runs uv sync"
    for line in syncs:
        assert "--frozen" in line, f"{dockerfile.relative_to(ENGINE_ROOT)}: {line}"


@pytest.mark.parametrize("dockerfile", DOCKERFILES, ids=lambda p: p.parent.name)
def test_no_unlocked_fallback(dockerfile: Path) -> None:
    """A stale lock must fail the build, not silently install something else."""
    body = dockerfile.read_text()
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith("#") or "uv sync" not in stripped:
            continue
        assert "||" not in stripped, (
            f"{dockerfile.relative_to(ENGINE_ROOT)} falls back to an unlocked sync: {stripped}"
        )


def test_the_lock_file_is_in_the_build_context() -> None:
    """A .dockerignore entry for uv.lock would make the COPY above fail at build time."""
    ignore = ENGINE_ROOT / ".dockerignore"
    if not ignore.exists():
        return
    patterns = [
        line.strip()
        for line in ignore.read_text().splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    assert not any(p.rstrip("/") in {"uv.lock", "*.lock", "**/uv.lock"} for p in patterns), patterns
