"""Client for the public Elexon BMRS Insights API (no API key required).

Datasets used:
- FUELHH  half-hourly outturn generation by fuel type; we keep fuelType == "WIND".
- WINDFOR national wind generation forecast; ~8 runs/day, hourly values, ~2.5 days ahead.
"""

from __future__ import annotations

import logging
import time as clock
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date, datetime

import httpx

log = logging.getLogger(__name__)

BASE_URL = "https://data.elexon.co.uk/bmrs/api/v1/datasets"
TIMEOUT_S = 30

ForecastHistory = list[tuple[datetime, int]]  # [(publish_time, MW)] sorted by publish time


@dataclass(frozen=True)
class WindData:
    actuals: dict[datetime, int]
    """Metered wind generation (average MW over the half hour) keyed by slot start, UTC."""

    actuals_published: dict[datetime, datetime]
    """When each actual above was published: before then, a trader could not have known it."""

    forecasts: dict[datetime, ForecastHistory]
    """Every forecast ever issued for a target hour (UTC), oldest first."""


def _stream(dataset: str, **params: str) -> list[dict]:
    started = clock.perf_counter()
    with httpx.Client(transport=httpx.HTTPTransport(retries=2), timeout=TIMEOUT_S) as client:
        resp = client.get(f"{BASE_URL}/{dataset}/stream", params=params)
        resp.raise_for_status()
        rows = resp.json()
    log.info(
        "elexon %s: %d rows in %.2fs",
        dataset,
        len(rows),
        clock.perf_counter() - started,
    )
    return rows


def _utc(ts: datetime) -> str:
    return ts.strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch_actuals(first_day: date, last_day: date) -> tuple[dict[datetime, int], dict[datetime, datetime]]:
    """Wind outturn for UK settlement days [first_day, last_day], plus each value's publish time.

    If a slot was revised, the latest value is kept and treated as known from the latest publish
    time: conservative for any analysis that must not look ahead.
    """
    rows = _stream(
        "FUELHH",
        settlementDateFrom=first_day.isoformat(),
        settlementDateTo=last_day.isoformat(),
        fuelType="WIND",
    )
    rows = [r for r in rows if r["fuelType"] == "WIND" and r["generation"] is not None]
    rows.sort(key=lambda r: r["publishTime"])  # a later revision of a slot overwrites earlier ones
    values = {datetime.fromisoformat(r["startTime"]): r["generation"] for r in rows}
    published = {
        datetime.fromisoformat(r["startTime"]): datetime.fromisoformat(r["publishTime"]) for r in rows
    }
    return values, published


def fetch_forecasts(published_from: datetime, published_to: datetime) -> dict[datetime, ForecastHistory]:
    """All forecast runs published in [published_from, published_to], indexed by target hour."""
    rows = _stream(
        "WINDFOR",
        publishDateTimeFrom=_utc(published_from),
        publishDateTimeTo=_utc(published_to),
    )
    history: dict[datetime, ForecastHistory] = defaultdict(list)
    for r in rows:
        target = datetime.fromisoformat(r["startTime"])
        published = datetime.fromisoformat(r["publishTime"])
        # Each run also repeats ~1 day of already-elapsed hours. Those are not forecasts: drop them.
        if published <= target and r["generation"] is not None:
            history[target].append((published, r["generation"]))
    for runs in history.values():
        runs.sort()
    return dict(history)


def fetch_wind_data(
    actuals_from: date,
    actuals_to: date,
    published_from: datetime,
    published_to: datetime,
) -> WindData:
    with ThreadPoolExecutor(max_workers=2) as pool:
        actuals = pool.submit(fetch_actuals, actuals_from, actuals_to)
        forecasts = pool.submit(fetch_forecasts, published_from, published_to)
        values, published = actuals.result()
        return WindData(actuals=values, actuals_published=published, forecasts=forecasts.result())
