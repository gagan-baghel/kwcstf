from datetime import UTC, date, datetime

import pytest

from app import elexon


def utc(*args: int) -> datetime:
    return datetime(*args, tzinfo=UTC)


def test_forecasts_drop_elapsed_hours_and_sort_runs(monkeypatch: pytest.MonkeyPatch):
    rows = [
        {"publishTime": "2026-01-14T09:30:00Z", "startTime": "2026-01-15T12:00:00Z", "generation": 2},
        {"publishTime": "2026-01-14T07:30:00Z", "startTime": "2026-01-15T12:00:00Z", "generation": 1},
        # Echo of an hour that had already passed when the run was published: not a forecast.
        {"publishTime": "2026-01-14T09:30:00Z", "startTime": "2026-01-14T06:00:00Z", "generation": 9},
    ]
    monkeypatch.setattr(elexon, "_stream", lambda dataset, **params: rows)

    forecasts = elexon.fetch_forecasts(utc(2026, 1, 14), utc(2026, 1, 15))

    assert forecasts == {utc(2026, 1, 15, 12): [(utc(2026, 1, 14, 7, 30), 1), (utc(2026, 1, 14, 9, 30), 2)]}


def test_actuals_keep_wind_only_and_the_latest_revision(monkeypatch: pytest.MonkeyPatch):
    rows = [
        {
            "publishTime": "2026-01-15T00:45:00Z",
            "startTime": "2026-01-15T00:00:00Z",
            "fuelType": "WIND",
            "generation": 7,
        },
        {
            "publishTime": "2026-01-15T00:30:00Z",
            "startTime": "2026-01-15T00:00:00Z",
            "fuelType": "WIND",
            "generation": 5,
        },
        {
            "publishTime": "2026-01-15T00:30:00Z",
            "startTime": "2026-01-15T00:00:00Z",
            "fuelType": "CCGT",
            "generation": 99,
        },
    ]
    monkeypatch.setattr(elexon, "_stream", lambda dataset, **params: rows)

    values, published = elexon.fetch_actuals(date(2026, 1, 15), date(2026, 1, 15))

    assert values == {utc(2026, 1, 15): 7}
    assert published == {utc(2026, 1, 15): utc(2026, 1, 15, 0, 45)}  # known from the revision's publish time
