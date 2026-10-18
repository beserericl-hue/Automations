"""The Workbench's trial-expiry / credit-reset / trial-warning crons, driven by the engine's clock.

Three correct routes had existed since Sprint 8 and nothing had ever called them: `CRON_SECRET` was
unset so they answered 500, and nothing was scheduled against them. On DEV that meant trials never
expired, monthly credits never reset and no warning emails went out — silently, because a cron
nobody calls looks identical to a cron with nothing to do.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from writer_engine import workbench_cron
from writer_engine.config import get_settings


@pytest.fixture(autouse=True)
def _configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKBENCH_API_URL", "https://workbench.test")
    monkeypatch.setenv("WORKBENCH_CRON_SECRET", "cron-secret-abc")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


class TestRunLifecycle:
    def test_calls_all_three_routes_with_the_secret(self) -> None:
        seen: list[tuple[str, str | None]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append((request.url.path, request.headers.get("x-cron-secret")))
            return httpx.Response(200, json={"success": True, "data": {"expired": 0}})

        async def go() -> dict:
            async with _client(handler) as c:
                return await workbench_cron.run_lifecycle(client=c)

        out = asyncio.run(go())
        assert out["called"] == 3
        assert [p for p, _ in seen] == list(workbench_cron.LIFECYCLE_PATHS)
        assert {s for _, s in seen} == {"cron-secret-abc"}

    def test_expiry_runs_before_warnings(self) -> None:
        """Warning an account in the same tick that expires it is noise; the order is the fix."""
        paths = list(workbench_cron.LIFECYCLE_PATHS)
        assert paths.index("/api/cron/trial-check") < paths.index("/api/cron/trial-warnings")
        assert paths.index("/api/cron/credit-reset") < paths.index("/api/cron/trial-warnings")

    def test_reports_each_route_result(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("trial-check"):
                return httpx.Response(200, json={"success": True, "data": {"expired": 2}})
            return httpx.Response(200, json={"success": True, "data": {"reset": 1}})

        async def go() -> dict:
            async with _client(handler) as c:
                return await workbench_cron.run_lifecycle(client=c)

        out = asyncio.run(go())
        assert out["results"]["/api/cron/trial-check"]["data"] == {"expired": 2}
        assert out["results"]["/api/cron/credit-reset"]["ok"] is True

    def test_one_failing_route_does_not_stop_the_others(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("credit-reset"):
                return httpx.Response(500, text="boom")
            return httpx.Response(200, json={"success": True, "data": {}})

        async def go() -> dict:
            async with _client(handler) as c:
                return await workbench_cron.run_lifecycle(client=c)

        out = asyncio.run(go())
        assert out["results"]["/api/cron/credit-reset"]["ok"] is False
        assert out["results"]["/api/cron/trial-warnings"]["ok"] is True

    def test_a_transport_error_is_reported_not_raised(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("workbench unreachable")

        async def go() -> dict:
            async with _client(handler) as c:
                return await workbench_cron.run_lifecycle(client=c)

        out = asyncio.run(go())
        assert out["called"] == 0
        assert all(r["ok"] is False for r in out["results"].values())

    def test_missing_configuration_is_skipped_loudly_not_attempted(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A 500 from the far side and an unset secret look the same from the outside — which is
        precisely how this went unnoticed for a sprint."""
        monkeypatch.setenv("WORKBENCH_CRON_SECRET", "")
        get_settings.cache_clear()
        calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request.url.path)
            return httpx.Response(200, json={})

        async def go() -> dict:
            async with _client(handler) as c:
                return await workbench_cron.run_lifecycle(client=c)

        out = asyncio.run(go())
        assert calls == []
        assert "WORKBENCH_CRON_SECRET" in out["skipped"]


class TestScheduled:
    def test_the_orchestrator_registers_the_lifecycle_job(self) -> None:
        """The whole defect was that nothing was scheduled, so the registration is the fix."""
        import inspect

        from orchestrator import main as M

        src = inspect.getsource(M.build_app)
        assert 'name="workbench-lifecycle"' in src
        assert "run=run_lifecycle" in src
