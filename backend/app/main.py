"""HTTP API. A thin layer: validate input, pick cached data, delegate to `analysis`."""

from __future__ import annotations

import logging
import os
import time as clock
from dataclasses import dataclass
from datetime import date, time, timedelta
from functools import cache, lru_cache
from pathlib import Path
from typing import Annotated

import httpx
from fastapi import FastAPI, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import analysis
from .analysis import AccuracyReport, DayView, GateAccuracy, Point, ProcurementReport, uk_instant
from .elexon import WindData, fetch_wind_data

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("winddesk")

# Pilot scope: purchase decisions made in January 2026, i.e. delivery days 2 Jan - 1 Feb 2026.
FIRST_DECISION_DAY = date(2026, 1, 1)
LAST_DECISION_DAY = date(2026, 1, 31)
DECISION_DAYS = [
    FIRST_DECISION_DAY + timedelta(days=i) for i in range((LAST_DECISION_DAY - FIRST_DECISION_DAY).days + 1)
]

# Historical data never changes, so the CDN may serve it for a day (Vercel's CDN cache is scoped
# to a deployment, so a deploy never mixes old responses with a new frontend). Browsers always
# revalidate: the frontend keeps its own in-memory cache, and a stale browser copy could
# outlive a schema change.
CACHE_CONTROL = "public, max-age=0, must-revalidate, s-maxage=86400"


@dataclass(frozen=True)
class Gate:
    id: str
    label: str
    closes_at: time
    """UK local time on D-1."""


GATES = [
    Gate("epex", "EPEX SPOT GB hourly auction", time(9, 20)),
    Gate("n2ex", "Nord Pool N2EX GB auction", time(9, 50)),
]
DEFAULT_GATE = GATES[0].closes_at


@dataclass(frozen=True)
class Meta:
    first_decision_day: date
    last_decision_day: date
    gates: list[Gate]
    default_gate: time


# --- Data (cached per process) ----------------------------------------------------------


@cache
def wind_data() -> WindData:
    # ponytail: two cold requests may both fetch; fine at pilot traffic, add a lock if it is not.
    return fetch_wind_data(
        actuals_from=FIRST_DECISION_DAY + timedelta(days=1),
        actuals_to=LAST_DECISION_DAY + timedelta(days=1),
        # From the start of the day before the first decision, so even a 00:00 gate sees a forecast.
        published_from=uk_instant(FIRST_DECISION_DAY - timedelta(days=1), time()),
        published_to=uk_instant(LAST_DECISION_DAY + timedelta(days=1), time()),
    )


@lru_cache(maxsize=64)
def points_by_day(gate: time) -> dict[date, list[Point]]:
    data = wind_data()
    return {day: analysis.day_ahead_points(data, day, gate) for day in DECISION_DAYS}


@lru_cache(maxsize=64)
def accuracy_report(gate: time) -> AccuracyReport:
    return analysis.accuracy_report(gate, points_by_day(gate))


@lru_cache(maxsize=256)
def procurement_report(gate: time, cost_short: float, cost_long: float) -> ProcurementReport | None:
    return analysis.procurement_report(points_by_day(gate), gate, cost_short, cost_long)


@cache
def gate_sweep() -> list[GateAccuracy]:
    return analysis.gate_sweep(wind_data(), DECISION_DAYS)


# --- App --------------------------------------------------------------------------------

app = FastAPI(
    title="WindDesk API",
    version="1.0.0",
    description="Day-ahead GB wind forecast monitoring for January 2026 purchase decisions.",
)
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.middleware("http")
async def access_log_and_caching(request: Request, call_next):
    started = clock.perf_counter()
    response = await call_next(request)
    elapsed_ms = (clock.perf_counter() - started) * 1000
    response.headers["Server-Timing"] = f"app;dur={elapsed_ms:.1f}"
    if request.url.path.startswith("/api/v1/") and response.status_code == 200:
        response.headers.setdefault("Cache-Control", CACHE_CONTROL)
    log.info(
        "%s %s %d %.1fms",
        request.method,
        request.url.path,
        response.status_code,
        elapsed_ms,
    )
    return response


async def upstream_unavailable(request: Request, exc: Exception) -> JSONResponse:
    log.warning("Elexon request failed: %r", exc)
    return JSONResponse(
        status_code=502,
        content={"detail": "Elexon BMRS API is unavailable. Please retry shortly."},
    )


app.add_exception_handler(httpx.HTTPError, upstream_unavailable)

DecisionDay = Annotated[
    date,
    Query(
        ge=FIRST_DECISION_DAY,
        le=LAST_DECISION_DAY,
        description="Day the purchase decision is made (D-1).",
    ),
]
GateTime = Annotated[time, Query(description="Decision cut-off on D-1, UK local time, HH:MM.")]
PlanLevel = Annotated[
    float,
    Query(gt=0, lt=1, description="Wind quantile to plan to: 0.5 is the median; lower is more cautious."),
]
# Costs are rounded to the penny for caching, so the lower bound is a penny too: anything smaller
# would round to zero and leave the planning level undefined.
CostShort = Annotated[
    float,
    Query(ge=0.01, le=1000, description="£/MWh premium paid to cover wind that falls short of the plan."),
]
CostLong = Annotated[
    float, Query(ge=0.01, le=1000, description="£/MWh discount when selling back surplus wind.")
]


def _minute(gate: time) -> time:
    """Normalise to whole minutes, naive UK wall-clock (also keeps the caches small)."""
    return gate.replace(second=0, microsecond=0, tzinfo=None)


@app.get("/api/health", include_in_schema=False)
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/v1/meta")
def meta() -> Meta:
    return Meta(FIRST_DECISION_DAY, LAST_DECISION_DAY, GATES, DEFAULT_GATE)


@app.get("/api/v1/decision")
def decision(day: DecisionDay, gate: GateTime = DEFAULT_GATE, plan_level: PlanLevel = 0.5) -> DayView:
    """The forecast a buyer had at the gate on `day`, the buy plan it supports, and what the wind then did."""
    gate = _minute(gate)
    by_day = points_by_day(gate)
    cutoff = uk_instant(day, gate)
    calibration = analysis.calibration_at(by_day, cutoff)
    plan = analysis.buy_plan(by_day, by_day[day], cutoff, plan_level)
    return analysis.day_view(wind_data(), day, gate, by_day[day], calibration, plan)


@app.get("/api/v1/accuracy")
def accuracy(gate: GateTime = DEFAULT_GATE) -> AccuracyReport:
    """Error of the gate-time forecast over every January decision."""
    return accuracy_report(_minute(gate))


@app.get("/api/v1/procurement")
def procurement(
    gate: GateTime = DEFAULT_GATE, cost_short: CostShort = 40, cost_long: CostLong = 20
) -> ProcurementReport | None:
    """Backtest of planning to the cost-optimal wind quantile vs the raw and median forecast."""
    return procurement_report(_minute(gate), round(cost_short, 2), round(cost_long, 2))


@app.get("/api/v1/gate-sweep")
def sweep() -> list[GateAccuracy]:
    """Month-wide accuracy for every possible decision time on D-1, in 10-minute steps."""
    return gate_sweep()


# In Docker the API also serves the built frontend. On Vercel the CDN serves it instead.
if (static_dir := os.getenv("STATIC_DIR")) and Path(static_dir).is_dir():
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="web")
