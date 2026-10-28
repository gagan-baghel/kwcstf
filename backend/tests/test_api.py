from collections.abc import Iterator

import httpx
import pytest
from fastapi.testclient import TestClient

from app import main
from app.elexon import WindData

from .conftest import ACTUAL_MW, EARLY_RUN_MW, LATE_RUN_MW


def _clear_caches() -> None:
    for fn in (main.points_by_day, main.accuracy_report, main.gate_sweep):
        fn.cache_clear()


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, wind_data: WindData) -> Iterator[TestClient]:
    monkeypatch.setattr(main, "wind_data", lambda: wind_data)
    _clear_caches()
    yield TestClient(main.app)
    _clear_caches()


def test_decision_returns_the_gate_forecast_for_the_next_day(client: TestClient):
    res = client.get("/api/v1/decision", params={"day": "2026-01-14"})

    assert res.status_code == 200
    body = res.json()
    assert body["delivery_day"] == "2026-01-15"
    assert body["forecast_runs"] == ["2026-01-14T07:30:00Z"]
    assert body["next_run"] == "2026-01-14T09:30:00Z"
    assert body["decision_day_runs"] == ["2026-01-14T07:30:00Z", "2026-01-14T09:30:00Z"]
    assert body["stats"]["bias"] == EARLY_RUN_MW - ACTUAL_MW
    # 2-13 Jan in full plus 14 Jan 00:00-08:00: only outturn published by the 09:20 gate.
    assert body["calibration"]["history_hours"] == 12 * 24 + 9
    assert body["calibrated_stats"]["mae"] == 0
    assert body["forecast_mwh"] == 24 * EARLY_RUN_MW
    assert body["actual_mwh"] == 24 * ACTUAL_MW
    assert "s-maxage" in res.headers["cache-control"]


def test_gate_parameter_changes_which_run_is_used(client: TestClient):
    body = client.get("/api/v1/decision", params={"day": "2026-01-14", "gate": "09:50"}).json()
    assert body["forecast_runs"] == ["2026-01-14T09:30:00Z"]
    assert body["stats"]["bias"] == LATE_RUN_MW - ACTUAL_MW


@pytest.mark.parametrize(
    "params",
    [{"day": "2025-12-31"}, {"day": "2026-02-01"}, {"day": "2026-01-14", "gate": "25:00"}, {}],
)
def test_invalid_input_is_rejected(client: TestClient, params: dict[str, str]):
    assert client.get("/api/v1/decision", params=params).status_code == 422


def test_accuracy_and_sweep(client: TestClient):
    accuracy = client.get("/api/v1/accuracy").json()
    assert accuracy["overall"]["count"] == 31 * 24

    sweep = client.get("/api/v1/gate-sweep").json()
    assert len(sweep) == 144
    by_gate = {g["gate"]: g["stats"] and g["stats"]["bias"] for g in sweep}
    assert by_gate["07:00:00"] is None  # no run published yet: nothing to score, not a crash
    assert by_gate["09:00:00"] == EARLY_RUN_MW - ACTUAL_MW
    assert by_gate["10:00:00"] == LATE_RUN_MW - ACTUAL_MW


def test_upstream_failure_is_a_502_not_a_crash(monkeypatch: pytest.MonkeyPatch):
    def unavailable() -> WindData:
        raise httpx.ConnectError("elexon down")

    monkeypatch.setattr(main, "wind_data", unavailable)
    _clear_caches()

    res = TestClient(main.app).get("/api/v1/accuracy", params={"gate": "08:01"})

    assert res.status_code == 502
    assert "cache-control" not in res.headers


def test_procurement_backtest_endpoint(client: TestClient):
    body = client.get("/api/v1/procurement", params={"cost_short": 30, "cost_long": 10}).json()

    assert body["planning_level"] == 0.25
    assert [s["id"] for s in body["strategies"]] == ["raw", "median", "optimal"]
    assert len(body["curve"]) == 19
    assert client.get("/api/v1/procurement", params={"cost_short": 0}).status_code == 422


@pytest.mark.parametrize(("short", "long", "status"), [(0.001, 0.001, 422), (0.01, 0.01, 200)])
def test_procurement_costs_below_a_penny_are_rejected_not_a_500(client: TestClient, short, long, status):
    res = client.get("/api/v1/procurement", params={"cost_short": short, "cost_long": long})
    assert res.status_code == status


def test_decision_includes_a_buy_plan_at_the_requested_level(client: TestClient):
    body = client.get("/api/v1/decision", params={"day": "2026-01-14", "plan_level": 0.25}).json()

    plan = body["buy_plan"]
    assert plan["level"] == 0.25
    assert len(plan["hours"]) == 24
    assert plan["extra_mwh"] == plan["forecast_mwh"] - plan["plan_mwh"]
    assert client.get("/api/v1/decision", params={"day": "2026-01-14", "plan_level": 1}).status_code == 422
