"""Runtime replica autoscaling on the queue verdict (CR-010 C4).

Railway scales replicas only when told to: it has vertical autoscaling, not horizontal. Changing a
service's replica count through its API adds or removes replicas on the running deployment without
redeploying the others (measured on DEV 2026-10-26: the gateway went 1 → 2 on deployment
``91c893bc`` with both instances RUNNING and no new deployment). So the engine can scale itself.

**What drives it is** :func:`queue_metrics.scaling_advice`, not raw depth, because the same depth
means opposite things on the two queues (see that module):

* ``scale_out`` (interactive work is queueing) and ``backlog`` (heavy slots full, nothing waiting on
  tokens) — add one replica, after the verdict has held for ``scale_out_ticks`` samples in a row.
* ``tpm_bound`` — hold. Another replica shares the same account-wide output budget (B9).
* ``scale_in`` — remove one replica once every queue has been idle for ``scale_in_after_s`` AND no
  heavy job is running anywhere. Railway picks which replica goes; a chapter write on it would be
  cancelled and re-queued after the drain window, which is safe (B6) but wastes the work, so the
  rule waits for heavy to be empty rather than trusting the drain to save it.
* ``unknown`` / ``hold`` — hold, and reset the streaks.

One change per ``cooldown_s``, always one replica at a time, never outside ``[min, max]``. The floor
is also what puts a fleet back to its baseline: a DEV runtime that somebody set to 1 by hand goes back
to 2 on the next tick.

**Where it may act.** Off unless ``AUTOSCALE_ENABLED`` is true and ``RAILWAY_AUTOSCALE_TOKEN`` is set.
The token is meant to be a Railway *project* token, which Railway scopes to one environment, so a DEV
token cannot change PROD whatever this code does. On top of that, the scaler refuses to act in an
environment named ``production`` unless ``AUTOSCALE_ALLOW_PRODUCTION`` is true.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import asdict, dataclass, field
from typing import Any

import httpx
from prometheus_client import Counter, Gauge

from writer_engine.queues import QUEUE_HEAVY
from writer_engine.telemetry.logging import get_logger

logger = get_logger("autoscale")

RAILWAY_GRAPHQL = "https://backboard.railway.com/graphql/v2"
STATE_KEY = "engine:autoscale:state"

CURRENT_REPLICAS = Gauge(
    "engine_autoscale_current_replicas", "Runtime replicas Railway is configured to run."
)
TARGET_REPLICAS = Gauge("engine_autoscale_target_replicas", "Runtime replicas the autoscaler last asked for.")
DECISIONS = Counter(
    "engine_autoscale_decisions",
    "Autoscaler decisions, by action (scale_out, scale_in, floor, ceiling, hold, refused, error).",
    labelnames=("action",),
)


def _flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


@dataclass(frozen=True)
class AutoscaleConfig:
    enabled: bool = False
    min_replicas: int = 2
    max_replicas: int = 4
    scale_out_ticks: int = 2
    scale_in_after_s: int = 900
    cooldown_s: int = 300
    token: str = field(default="", repr=False)
    service_id: str = ""
    environment_id: str = ""
    environment_name: str = ""
    allow_production: bool = False

    @classmethod
    def from_env(cls) -> AutoscaleConfig:
        lo = max(1, _int("AUTOSCALE_MIN_REPLICAS", 2))
        return cls(
            enabled=_flag("AUTOSCALE_ENABLED"),
            min_replicas=lo,
            max_replicas=max(lo, _int("AUTOSCALE_MAX_REPLICAS", 4)),
            scale_out_ticks=max(1, _int("AUTOSCALE_SCALE_OUT_TICKS", 2)),
            scale_in_after_s=max(60, _int("AUTOSCALE_SCALE_IN_AFTER_SECONDS", 900)),
            cooldown_s=max(60, _int("AUTOSCALE_COOLDOWN_SECONDS", 300)),
            token=os.environ.get("RAILWAY_AUTOSCALE_TOKEN", "").strip(),
            # Railway provides these to every service. The override exists for tests and for a
            # scaler that ever needs to drive a service other than the one it runs in.
            service_id=os.environ.get("AUTOSCALE_SERVICE_ID") or os.environ.get("RAILWAY_SERVICE_ID", ""),
            environment_id=os.environ.get("RAILWAY_ENVIRONMENT_ID", ""),
            environment_name=os.environ.get("RAILWAY_ENVIRONMENT_NAME", ""),
            allow_production=_flag("AUTOSCALE_ALLOW_PRODUCTION"),
        )

    def refusal(self) -> str:
        """Why this scaler must not act, or "" if it may."""
        if not self.enabled:
            return "AUTOSCALE_ENABLED is not set"
        if not self.token:
            return "RAILWAY_AUTOSCALE_TOKEN is not set"
        if not self.service_id or not self.environment_id:
            return "RAILWAY_SERVICE_ID / RAILWAY_ENVIRONMENT_ID are not set (not running on Railway?)"
        if self.environment_name.lower() == "production" and not self.allow_production:
            return "environment is production and AUTOSCALE_ALLOW_PRODUCTION is not set"
        return ""

    def public(self) -> dict[str, Any]:
        out = asdict(self)
        out.pop("token")
        out["token_set"] = bool(self.token)
        return out


@dataclass
class AutoscaleState:
    """What the scaler remembers between ticks, kept in Redis so a replica restart (or a different
    replica winning the lock) does not reset the streaks or the cooldown."""

    out_streak: int = 0
    idle_since: float | None = None
    last_change_at: float | None = None
    last_action: str = ""
    last_reason: str = ""
    last_current: int | None = None
    last_target: int | None = None
    last_tick_at: float | None = None


@dataclass(frozen=True)
class Decision:
    action: str  # scale_out | scale_in | floor | ceiling | hold
    target: int
    reason: str


def decide(
    advice: dict[str, Any],
    *,
    current: int,
    cfg: AutoscaleConfig,
    state: AutoscaleState,
    now: float,
) -> Decision:
    """The rule. Pure: it updates ``state``'s streaks and returns what to do, and touches nothing else."""
    verdict = str(advice.get("verdict") or "unknown")
    queues = advice.get("queues") or []
    heavy_running = sum(int(q.get("running") or 0) for q in queues if q.get("queue") == QUEUE_HEAVY)

    if current < cfg.min_replicas:
        return Decision(
            "floor", cfg.min_replicas, f"{current} replica(s) is below the floor of {cfg.min_replicas}"
        )
    if current > cfg.max_replicas:
        return Decision(
            "ceiling", cfg.max_replicas, f"{current} replica(s) is above the ceiling of {cfg.max_replicas}"
        )

    if verdict in {"scale_out", "backlog"}:
        state.out_streak += 1
    else:
        state.out_streak = 0
    if verdict == "scale_in":
        state.idle_since = state.idle_since or now
    else:
        state.idle_since = None

    cooling = state.last_change_at is not None and now - state.last_change_at < cfg.cooldown_s
    if cooling:
        wait = cfg.cooldown_s - (now - (state.last_change_at or now))
        return Decision(
            "hold", current, f"cooling down for {wait:.0f}s more after the last change ({verdict})"
        )

    if verdict in {"scale_out", "backlog"}:
        if current >= cfg.max_replicas:
            return Decision("hold", current, f"{verdict} but already at the ceiling of {cfg.max_replicas}")
        if state.out_streak < cfg.scale_out_ticks:
            return Decision(
                "hold", current, f"{verdict} for {state.out_streak}/{cfg.scale_out_ticks} samples"
            )
        return Decision("scale_out", current + 1, f"{verdict}: {advice.get('reason', '')}"[:300])

    if verdict == "scale_in":
        idle_for = now - (state.idle_since or now)
        if current <= cfg.min_replicas:
            return Decision("hold", current, f"idle, already at the floor of {cfg.min_replicas}")
        if heavy_running:
            return Decision(
                "hold",
                current,
                f"idle but {heavy_running} heavy job(s) running — not removing a replica under them",
            )
        if idle_for < cfg.scale_in_after_s:
            return Decision("hold", current, f"idle for {idle_for:.0f}s of {cfg.scale_in_after_s}s")
        return Decision(
            "scale_in", current - 1, f"every queue idle for {idle_for:.0f}s and no heavy work in flight"
        )

    if verdict == "tpm_bound":
        return Decision("hold", current, "tpm_bound: another replica would share the same token budget (B9)")
    return Decision("hold", current, f"{verdict}: {advice.get('reason', '')}"[:300])


# --- Railway ------------------------------------------------------------------------------------


class RailwayScaler:
    """Reads and sets one service's replica count in one environment through Railway's API."""

    def __init__(self, cfg: AutoscaleConfig, *, client: httpx.AsyncClient | None = None) -> None:
        self.cfg = cfg
        self._client = client

    async def _gql(self, query: str, variables: dict[str, Any]) -> dict[str, Any]:
        # A project token authenticates with its own header; an account token with Bearer. Sending
        # both lets the operator use either without a second setting.
        headers = {
            "Content-Type": "application/json",
            "Project-Access-Token": self.cfg.token,
            "Authorization": f"Bearer {self.cfg.token}",
        }
        body = {"query": query, "variables": variables}
        if self._client is not None:
            resp = await self._client.post(RAILWAY_GRAPHQL, json=body, headers=headers)
        else:
            async with httpx.AsyncClient(timeout=20.0) as client:
                resp = await client.post(RAILWAY_GRAPHQL, json=body, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        if data.get("errors"):
            raise RuntimeError(f"railway: {json.dumps(data['errors'])[:300]}")
        return data.get("data") or {}

    async def region_config(self) -> dict[str, Any]:
        """``{region: {"numReplicas": n, ...}}`` from the service's latest deployment."""
        data = await self._gql(
            "query($s:String!,$e:String!){serviceInstance(serviceId:$s,environmentId:$e){latestDeployment{meta}}}",
            {"s": self.cfg.service_id, "e": self.cfg.environment_id},
        )
        meta = (((data.get("serviceInstance") or {}).get("latestDeployment") or {}).get("meta")) or {}
        deploy = (meta.get("serviceManifest") or {}).get("deploy") or {}
        regions = deploy.get("multiRegionConfig") or {}
        if not regions:
            raise RuntimeError("no multiRegionConfig on the latest deployment")
        return dict(regions)

    async def current(self) -> int:
        regions = await self.region_config()
        return sum(int((r or {}).get("numReplicas") or 0) for r in regions.values())

    async def set_replicas(self, target: int) -> None:
        regions = await self.region_config()
        if len(regions) != 1:
            # Splitting a target across regions is a placement decision this scaler does not make.
            raise RuntimeError(
                f"{len(regions)} regions configured; the autoscaler only scales a single-region service"
            )
        region = next(iter(regions))
        await self._gql(
            "mutation($s:String!,$e:String!,$i:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:$s,environmentId:$e,input:$i)}",
            {
                "s": self.cfg.service_id,
                "e": self.cfg.environment_id,
                "i": {"multiRegionConfig": {region: {"numReplicas": target}}},
            },
        )


async def load_state(redis: Any) -> AutoscaleState:
    try:
        raw = await redis.get(STATE_KEY)
        if raw:
            known = AutoscaleState.__dataclass_fields__
            return AutoscaleState(**{k: v for k, v in json.loads(raw).items() if k in known})
    except Exception as exc:
        logger.warning("autoscale.state_read_failed", error=f"{type(exc).__name__}: {exc}"[:160])
    return AutoscaleState()


async def save_state(redis: Any, state: AutoscaleState) -> None:
    try:
        await redis.set(STATE_KEY, json.dumps(asdict(state)), ex=7 * 24 * 3600)
    except Exception as exc:
        logger.warning("autoscale.state_write_failed", error=f"{type(exc).__name__}: {exc}"[:160])


async def tick(
    redis: Any,
    advice: dict[str, Any],
    *,
    cfg: AutoscaleConfig | None = None,
    scaler: RailwayScaler | None = None,
    now: float | None = None,
) -> dict[str, Any]:
    """One autoscaler pass. Run as a singleton job, so exactly one replica makes the call."""
    cfg = cfg or AutoscaleConfig.from_env()
    now = time.time() if now is None else now
    refusal = cfg.refusal()
    if refusal:
        DECISIONS.labels(action="refused").inc()
        return {"acted": False, "action": "refused", "reason": refusal}

    scaler = scaler or RailwayScaler(cfg)
    state = await load_state(redis)
    try:
        current = await scaler.current()
    except Exception as exc:
        DECISIONS.labels(action="error").inc()
        logger.warning("autoscale.read_failed", error=f"{type(exc).__name__}: {exc}"[:200])
        return {"acted": False, "action": "error", "reason": f"could not read replicas: {exc}"[:240]}
    CURRENT_REPLICAS.set(current)

    decision = decide(advice, current=current, cfg=cfg, state=state, now=now)
    acted = False
    if decision.target != current:
        try:
            await scaler.set_replicas(decision.target)
            acted = True
            state.last_change_at = now
            state.out_streak = 0
            state.idle_since = None
            logger.warning(
                "autoscale.changed",
                action=decision.action,
                current=current,
                target=decision.target,
                reason=decision.reason,
            )
        except Exception as exc:
            DECISIONS.labels(action="error").inc()
            logger.warning(
                "autoscale.set_failed", target=decision.target, error=f"{type(exc).__name__}: {exc}"[:200]
            )
            state.last_tick_at = now
            await save_state(redis, state)
            return {
                "acted": False,
                "action": "error",
                "reason": f"could not set replicas: {exc}"[:240],
                "current": current,
            }

    DECISIONS.labels(action=decision.action).inc()
    TARGET_REPLICAS.set(decision.target)
    state.last_action = decision.action
    state.last_reason = decision.reason
    state.last_current = current
    state.last_target = decision.target
    state.last_tick_at = now
    await save_state(redis, state)
    return {
        "acted": acted,
        "action": decision.action,
        "current": current,
        "target": decision.target,
        "reason": decision.reason,
    }


__all__ = [
    "AutoscaleConfig",
    "AutoscaleState",
    "Decision",
    "RailwayScaler",
    "decide",
    "load_state",
    "tick",
]
