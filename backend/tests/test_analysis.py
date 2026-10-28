from dataclasses import replace
from datetime import UTC, date, datetime, time

import pytest

from app.analysis import (
    Point,
    accuracy_report,
    buy_plan,
    calibrate,
    calibration_at,
    day_ahead_points,
    day_view,
    delivery_slots,
    error_stats,
    forecast_at,
    histogram,
    planning_level,
    procurement_report,
    quantile,
    uk_instant,
    whole_mw,
)
from app.elexon import WindData

from .conftest import ACTUAL_MW, EARLY_RUN_MW, LATE_RUN_MW

EPEX_GATE, N2EX_GATE = time(9, 20), time(9, 50)


def utc(*args: int) -> datetime:
    return datetime(*args, tzinfo=UTC)


def point(forecast: int | None, actual: float | None) -> Point:
    return Point(
        start=utc(2026, 1, 1),
        actual=None,
        forecast=forecast,
        published=None,
        hour_actual=actual,
        hour_known_at=utc(2026, 1, 1),
    )


def points_by_day(data: WindData, days: list[date], gate: time = EPEX_GATE) -> dict[date, list[Point]]:
    return {day: day_ahead_points(data, day, gate) for day in days}


def with_actuals(data: WindData, change) -> WindData:
    """Copy of `data` with actuals rewritten by change(slot, mw)."""
    return replace(data, actuals={slot: change(slot, mw) for slot, mw in data.actuals.items()})


# --- time handling ----------------------------------------------------------------------


def test_uk_instant_follows_gmt_and_bst():
    assert uk_instant(date(2026, 1, 14), EPEX_GATE) == utc(2026, 1, 14, 9, 20)
    assert uk_instant(date(2026, 6, 14), EPEX_GATE) == utc(2026, 6, 14, 8, 20)


@pytest.mark.parametrize(
    ("day", "slots"),
    [(date(2026, 1, 15), 48), (date(2026, 3, 29), 46), (date(2026, 10, 25), 50)],
)
def test_delivery_day_has_one_slot_per_settlement_period(day: date, slots: int):
    assert len(delivery_slots(day)) == slots
    assert delivery_slots(day)[0] == uk_instant(day, time())


# --- forecast selection -----------------------------------------------------------------


def test_forecast_at_returns_latest_run_published_by_cutoff_and_never_a_later_one():
    target = utc(2026, 1, 15, 12)
    data = WindData(
        actuals={},
        actuals_published={},
        forecasts={target: [(utc(2026, 1, 14, 7, 30), 1), (utc(2026, 1, 14, 9, 30), 2)]},
    )

    assert forecast_at(data, target, utc(2026, 1, 14, 9, 20)) == (utc(2026, 1, 14, 7, 30), 1)
    assert forecast_at(data, target, utc(2026, 1, 14, 9, 30)) == (utc(2026, 1, 14, 9, 30), 2)  # inclusive
    assert forecast_at(data, target, utc(2026, 1, 14, 7)) is None
    assert forecast_at(data, utc(2026, 2, 1), utc(2026, 1, 14, 9, 30)) is None  # unknown target


def test_day_ahead_points_cover_next_day_with_forecast_known_at_the_gate(wind_data: WindData):
    points = day_ahead_points(wind_data, date(2026, 1, 14), EPEX_GATE)

    assert len(points) == 48
    assert points[0].start == utc(2026, 1, 15, 0)
    hourly = [p for p in points if p.start.minute == 0]
    assert {p.forecast for p in hourly} == {EARLY_RUN_MW}
    assert {p.published for p in hourly} == {utc(2026, 1, 14, 7, 30)}
    assert all(p.forecast is None for p in points if p.start.minute == 30)  # WINDFOR is hourly


def test_a_later_gate_picks_up_the_later_run(wind_data: WindData):
    points = day_ahead_points(wind_data, date(2026, 1, 14), N2EX_GATE)
    assert {p.forecast for p in points if p.forecast is not None} == {LATE_RUN_MW}


# --- interval alignment: half hours must never be scored or costed as full hours ----------


def test_hourly_forecast_is_scored_against_the_mean_of_both_half_hours(
    wind_data: WindData, january: list[date]
):
    # Forecast 1,000 MW all day; outturn 800 MW in each first half hour and 1,800 MW in the second.
    flat = replace(
        wind_data, forecasts={t: [(run, 1000) for run, _ in runs] for t, runs in wind_data.forecasts.items()}
    )
    data = with_actuals(flat, lambda slot, _: 800 if slot.minute == 0 else 1800)
    by_day = points_by_day(data, january)

    points = by_day[date(2026, 1, 14)]
    hourly = [p for p in points if p.forecast is not None]
    assert {p.hour_actual for p in hourly} == {1300}
    assert {p.error for p in hourly} == {-300}  # wind beat the forecast: the buyer was long, not short

    view = day_view(data, date(2026, 1, 14), EPEX_GATE, points, None)
    assert (view.forecast_mwh, view.actual_mwh) == (24_000, 31_200)
    assert view.stats is not None and view.stats.bias == -300  # agrees with the energy totals

    report = procurement_report(by_day, EPEX_GATE, cost_short=40, cost_long=20)
    assert report is not None
    raw = next(s for s in report.strategies if s.id == "raw")
    assert raw.short_mwh == 0
    assert raw.long_mwh == 300 * report.hours


def test_an_hour_with_a_missing_half_hour_is_not_scored(wind_data: WindData):
    gap = utc(2026, 1, 15, 6, 30)
    data = replace(wind_data, actuals={s: mw for s, mw in wind_data.actuals.items() if s != gap})

    six = next(
        p for p in day_ahead_points(data, date(2026, 1, 14), EPEX_GATE) if p.start == utc(2026, 1, 15, 6)
    )
    assert six.forecast == EARLY_RUN_MW
    assert six.hour_actual is None and six.error is None


# --- statistics -------------------------------------------------------------------------


def test_error_stats_uses_forecast_minus_actual():
    stats = error_stats([point(900, 1000), point(1000, 1000), point(1100, 1000), point(1200, 1000)])

    assert stats is not None
    assert stats.count == 4
    assert stats.bias == 50  # forecasts ran high on average
    assert stats.mae == 100
    assert stats.rmse == pytest.approx(122.5, abs=0.1)
    assert stats.max_shortfall == 200
    assert stats.nmae_pct == 10


def test_error_stats_ignores_unscored_points_and_needs_two():
    assert error_stats([point(1, 1), point(None, 5), point(5, None)]) is None
    assert error_stats([]) is None


def test_histogram_bins_negatives_by_floor_and_keeps_empty_bins():
    bins = histogram([-1, 0, 499.5, 1200], width=500)
    assert [(b.lower, b.count) for b in bins] == [(-500, 1), (0, 2), (500, 0), (1000, 1)]
    assert histogram([]) == []


# --- calibration: learn only from outturn published by the gate ---------------------------


def test_calibration_learns_only_from_outturn_published_by_the_cutoff(
    wind_data: WindData, january: list[date]
):
    cutoff = uk_instant(date(2026, 1, 4), EPEX_GATE)  # deciding on 4 Jan at 09:20
    # Rewrite only outturn that was not yet public at the cut-off (4 Jan from 09:30 onwards).
    future = with_actuals(wind_data, lambda slot, mw: 10_000 if slot >= utc(2026, 1, 4, 9, 30) else mw)

    before = calibration_at(points_by_day(wind_data, january), cutoff)
    after = calibration_at(points_by_day(future, january), cutoff)

    assert before is not None
    assert after == before
    # 2 and 3 Jan in full, plus 4 Jan hours 00:00-08:00 (hour 08 is public at 09:00, hour 09 at 10:00).
    assert before.history_hours == 2 * 24 + 9


def test_calibration_needs_two_days_of_known_hours_and_removes_the_bias(
    wind_data: WindData, january: list[date]
):
    by_day = points_by_day(wind_data, january)

    assert calibration_at(by_day, uk_instant(date(2026, 1, 3), EPEX_GATE)) is None  # 33 hours known
    cal = calibration_at(by_day, uk_instant(date(2026, 1, 4), EPEX_GATE))
    assert cal is not None
    assert cal.p50 == EARLY_RUN_MW - ACTUAL_MW

    calibrated = calibrate(by_day[date(2026, 1, 4)], cal)
    assert {p.error for p in calibrated if p.error is not None} == {0}


def test_calibrated_forecast_never_goes_below_zero(wind_data: WindData, january: list[date]):
    cal = calibration_at(points_by_day(wind_data, january), uk_instant(date(2026, 1, 10), EPEX_GATE))
    assert cal is not None
    huge_shift = replace(cal, p50=EARLY_RUN_MW * 5)

    calibrated = calibrate(day_ahead_points(wind_data, date(2026, 1, 10), EPEX_GATE), huge_shift)
    assert {p.forecast for p in calibrated if p.forecast is not None} == {0}


def test_accuracy_report_scores_every_hour_of_the_month(wind_data: WindData, january: list[date]):
    report = accuracy_report(EPEX_GATE, points_by_day(wind_data, january))

    assert report.overall is not None
    assert report.overall.count == 31 * 24
    assert report.overall.bias == EARLY_RUN_MW - ACTUAL_MW
    assert [h.hour for h in report.by_hour] == list(range(24))
    assert report.calibration.days == 31 - 3  # from 4 Jan, the first day with 48 known hours
    assert report.calibration.calibrated is not None
    assert report.calibration.calibrated.mae == 0


# --- procurement ------------------------------------------------------------------------


def test_quantile_interpolates_linearly():
    values = [0.0, 10.0, 20.0, 30.0]
    assert quantile(values, 0) == 0
    assert quantile(values, 1) == 30
    assert quantile(values, 0.5) == 15


def test_planning_level_is_the_newsvendor_critical_ratio():
    assert planning_level(cost_short=40, cost_long=20) == pytest.approx(1 / 3)
    assert planning_level(cost_short=20, cost_long=20) == 0.5


def test_procurement_removes_a_steady_bias_and_prices_the_raw_forecast(
    wind_data: WindData, january: list[date]
):
    report = procurement_report(points_by_day(wind_data, january), EPEX_GATE, cost_short=40, cost_long=20)

    assert report is not None
    assert report.days == 31 - 3
    assert report.hours == report.days * 24
    costs = {s.id: s for s in report.strategies}
    bias = EARLY_RUN_MW - ACTUAL_MW  # raw forecast is short by this every hour
    assert costs["raw"].cost_gbp == 40 * bias * report.hours
    assert costs["raw"].long_mwh == 0
    assert costs["median"].cost_gbp == 0
    assert costs["optimal"].cost_gbp == 0


def test_procurement_plan_ignores_outturn_published_after_its_cutoff(
    wind_data: WindData, january: list[date]
):
    # Make 10 Jan's outturn wild only after the 10 Jan gate; steep costs (100/5) magnify any leak.
    after_gate = (utc(2026, 1, 10, 9, 30), utc(2026, 1, 11))
    future = with_actuals(wind_data, lambda slot, mw: 0 if after_gate[0] <= slot < after_gate[1] else mw)
    clean = procurement_report(points_by_day(wind_data, january), EPEX_GATE, cost_short=100, cost_long=5)
    leaked = procurement_report(points_by_day(future, january), EPEX_GATE, cost_short=100, cost_long=5)

    assert clean is not None and leaked is not None
    day = {d.decision_day: d for d in clean.daily}
    leaked_day = {d.decision_day: d for d in leaked.daily}
    # The 10 Jan decision (delivery 11 Jan) could not see 10 Jan's afternoon, so its plan is unchanged.
    assert leaked_day[date(2026, 1, 10)] == day[date(2026, 1, 10)]


# --- buy plan ---------------------------------------------------------------------------


def hour(
    start: datetime, forecast: int, error: float | None = None, known_at: datetime | None = None
) -> Point:
    """An hourly point; with `error`, the outturn is forecast - error and became public at `known_at`."""
    return Point(
        start=start,
        actual=None,
        forecast=forecast,
        published=None,
        hour_actual=None if error is None else forecast - error,
        hour_known_at=known_at,
    )


def test_buy_plan_splits_the_extra_into_bias_and_risk_cover():
    published = utc(2026, 1, 1)
    history = [hour(utc(2026, 1, 1, i % 24), 1000, error=10 * i, known_at=published) for i in range(100)]
    tomorrow = [hour(utc(2026, 1, 3, h), 1000) for h in range(24)]  # no outturn yet
    by_day = {date(2026, 1, 1): history, date(2026, 1, 2): tomorrow}

    plan = buy_plan(by_day, tomorrow, cutoff=utc(2026, 1, 2, 9, 20), level=0.2)

    assert plan is not None
    # Past errors are 0, 10, ..., 990 MW: median 495, 80th percentile 792.
    assert plan.offset_mw == 792
    assert {h.plan_mw for h in plan.hours} == {208}
    assert (plan.forecast_mwh, plan.plan_mwh) == (24_000, 24 * 208)
    assert plan.bias_mwh == 24 * 495  # the forecast's typical over-statement
    assert plan.risk_mwh == 24 * (792 - 495)  # extra cover because shortfall costs more
    assert plan.extra_mwh == plan.bias_mwh + plan.risk_mwh


def test_buy_plan_at_the_median_matches_the_calibrated_forecast(wind_data: WindData, january: list[date]):
    by_day = points_by_day(wind_data, january)
    cutoff = uk_instant(date(2026, 1, 14), EPEX_GATE)
    plan = buy_plan(by_day, by_day[date(2026, 1, 14)], cutoff, level=0.5)
    cal = calibration_at(by_day, cutoff)

    assert plan is not None and cal is not None
    calibrated = calibrate(by_day[date(2026, 1, 14)], cal)
    assert [h.plan_mw for h in plan.hours] == [p.forecast for p in calibrated if p.forecast is not None]
    assert plan.risk_mwh == 0


def test_buy_plan_needs_published_history_and_ignores_later_outturn(wind_data: WindData, january: list[date]):
    by_day = points_by_day(wind_data, january)
    assert buy_plan(by_day, by_day[date(2026, 1, 3)], uk_instant(date(2026, 1, 3), EPEX_GATE), 0.33) is None

    cutoff = uk_instant(date(2026, 1, 10), EPEX_GATE)
    after_gate = (utc(2026, 1, 10, 9, 30), utc(2026, 1, 11))
    future = with_actuals(wind_data, lambda slot, mw: 0 if after_gate[0] <= slot < after_gate[1] else mw)
    leaked = points_by_day(future, january)

    assert buy_plan(leaked, leaked[date(2026, 1, 10)], cutoff, 0.33) == buy_plan(
        by_day, by_day[date(2026, 1, 10)], cutoff, 0.33
    )


def test_mw_values_round_half_up_like_the_frontend():
    # Python's round() gives 2310 for 2310.5 (half to even); the browser's Math.round gives 2311.
    assert [whole_mw(x) for x in (2310.5, 1481.5, 0.4, 0.5)] == [2311, 1482, 0, 1]


def test_buy_plan_at_the_median_matches_calibration_on_half_megawatt_shifts(
    wind_data: WindData, january: list[date]
):
    # Shift every actual by 0.5 MW so the median error ends in .5: rounding must agree everywhere.
    data = with_actuals(wind_data, lambda slot, mw: mw + 0.5)
    by_day = points_by_day(data, january)
    cutoff = uk_instant(date(2026, 1, 14), EPEX_GATE)
    cal = calibration_at(by_day, cutoff)
    plan = buy_plan(by_day, by_day[date(2026, 1, 14)], cutoff, level=0.5)

    assert cal is not None and plan is not None
    assert cal.p50 == EARLY_RUN_MW - ACTUAL_MW - 0.5
    calibrated = [p.forecast for p in calibrate(by_day[date(2026, 1, 14)], cal) if p.forecast is not None]
    assert [h.plan_mw for h in plan.hours] == calibrated == [whole_mw(ACTUAL_MW + 0.5)] * 24
