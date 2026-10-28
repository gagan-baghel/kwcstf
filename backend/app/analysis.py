"""Day-ahead wind forecast evaluation. Pure functions over WindData: no I/O, no globals.

Conventions
- Timestamps are timezone-aware UTC. UK wall-clock time is only used to build delivery
  days and gate-closure instants, via Europe/London, so GMT/BST changes are handled.
- error = forecast - actual (MW). Positive error means wind came in below the forecast,
  so a buyer who relied on it is short and has to top up intraday or pay imbalance.
- Intervals: FUELHH actuals are average MW per half hour; WINDFOR is hourly, and each value is
  treated as the average MW of the hour it starts. Every score compares like with like: an
  hourly forecast against the mean of that hour's two half-hour actuals.
- No look-ahead: a decision at cut-off C uses forecasts published by C and learns only from
  hours whose outturn Elexon had published by C.
"""

from __future__ import annotations

import math
from bisect import bisect_right
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, time, timedelta
from operator import itemgetter
from statistics import fmean, quantiles
from zoneinfo import ZoneInfo

from .elexon import WindData

UK = ZoneInfo("Europe/London")
HALF_HOUR = timedelta(minutes=30)
MIN_HISTORY_HOURS = 48
HISTOGRAM_WIDTH_MW = 500


# --- Time helpers -----------------------------------------------------------------------


def uk_instant(day: date, wall_clock: time) -> datetime:
    """A UK wall-clock time on `day`, as a UTC instant."""
    return datetime.combine(day, wall_clock, tzinfo=UK).astimezone(UTC)


def delivery_slots(day: date) -> list[datetime]:
    """Half-hour slot starts (UTC) of a UK delivery day: 48, or 46/50 on clock-change days."""
    start = uk_instant(day, time())
    end = uk_instant(day + timedelta(days=1), time())
    return [start + i * HALF_HOUR for i in range((end - start) // HALF_HOUR)]


# --- Forecast selection -----------------------------------------------------------------


def forecast_at(data: WindData, target: datetime, cutoff: datetime) -> tuple[datetime, int] | None:
    """Latest forecast for `target` published at or before `cutoff`, as (publish_time, MW).

    This is the no-look-ahead rule everything else builds on: a decision taken at
    `cutoff` can only use forecasts that already existed at `cutoff`.
    """
    runs = data.forecasts.get(target, [])
    i = bisect_right(runs, cutoff, key=itemgetter(0))
    return runs[i - 1] if i else None


def next_run_after(data: WindData, targets: Iterable[datetime], cutoff: datetime) -> datetime | None:
    """Earliest forecast run for any of `targets` published after `cutoff`: the one that missed the gate."""
    later = []
    for target in targets:
        runs = data.forecasts.get(target, [])
        i = bisect_right(runs, cutoff, key=itemgetter(0))
        if i < len(runs):
            later.append(runs[i][0])
    return min(later, default=None)


def runs_published_on(data: WindData, targets: Iterable[datetime], day: date) -> list[datetime]:
    """Every forecast run published during UK day `day` that covers any of `targets`."""
    start, end = uk_instant(day, time()), uk_instant(day + timedelta(days=1), time())
    return sorted({pub for t in targets for pub, _ in data.forecasts.get(t, []) if start <= pub < end})


@dataclass(frozen=True)
class Point:
    start: datetime
    actual: int | None
    """Metered wind for this half hour (average MW). Drawn on charts."""
    forecast: int | None
    """Forecast (MW) as known at the gate. WINDFOR is hourly, so half-past slots have none."""
    published: datetime | None
    """When that forecast run was published."""
    hour_actual: float | None
    """On forecast slots: average metered MW over the forecast's hour (this half hour and the next)."""
    hour_known_at: datetime | None
    """When hour_actual became public: the later of its two half hours' publish times."""

    @property
    def error(self) -> float | None:
        """Forecast minus the same hour's average outturn."""
        if self.forecast is None or self.hour_actual is None:
            return None
        return self.forecast - self.hour_actual


def day_ahead_points(data: WindData, decision_day: date, gate: time) -> list[Point]:
    """Delivery day D = decision_day + 1, seen through the forecasts available at the D-1 gate."""
    cutoff = uk_instant(decision_day, gate)
    points = []
    for slot in delivery_slots(decision_day + timedelta(days=1)):
        published, forecast = forecast_at(data, slot, cutoff) or (None, None)
        hour_actual = hour_known_at = None
        halves = (slot, slot + HALF_HOUR)
        if forecast is not None and all(h in data.actuals for h in halves):
            hour_actual = fmean(data.actuals[h] for h in halves)
            hour_known_at = max(data.actuals_published[h] for h in halves)
        points.append(
            Point(
                start=slot,
                actual=data.actuals.get(slot),
                forecast=forecast,
                published=published,
                hour_actual=hour_actual,
                hour_known_at=hour_known_at,
            )
        )
    return points


# --- Error statistics -------------------------------------------------------------------


@dataclass(frozen=True)
class ErrorStats:
    count: int
    """Hours scored (forecast and both half hours of outturn present)."""
    mae: float
    rmse: float
    bias: float
    """Mean error. > 0: forecasts ran high on average (wind under-delivered)."""
    p10: float
    p50: float
    p90: float
    """90% of the evaluated hours had a shortfall no larger than this (historical, not a guarantee)."""
    max_shortfall: float
    mean_actual: float
    nmae_pct: float | None
    """MAE as a percentage of mean actual generation."""


def error_stats(points: Iterable[Point]) -> ErrorStats | None:
    scored = [(p.error, p.hour_actual) for p in points if p.error is not None]
    if len(scored) < 2:
        return None
    errors = [e for e, _ in scored]
    deciles = quantiles(errors, n=10, method="inclusive")
    mae = fmean(abs(e) for e in errors)
    mean_actual = fmean(a for _, a in scored)
    return ErrorStats(
        count=len(errors),
        mae=round(mae, 1),
        rmse=round(math.sqrt(fmean(e * e for e in errors)), 1),
        bias=round(fmean(errors), 1),
        p10=round(deciles[0], 1),
        p50=round(deciles[4], 1),
        p90=round(deciles[8], 1),
        max_shortfall=round(max(errors), 1),
        mean_actual=round(mean_actual, 1),
        nmae_pct=round(100 * mae / mean_actual, 1) if mean_actual > 0 else None,
    )


def whole_mw(value: float) -> int:
    """Round half up, as the browser's Math.round does, so displayed MW match the API exactly.

    Python's round() rounds halves to even (2310.5 -> 2310), which made the frontend's calibrated
    values and the API's plan differ by 1 MW whenever the shift ended in .5.
    """
    return math.floor(value + 0.5)


def known_by(points_by_day: dict[date, list[Point]], cutoff: datetime) -> list[Point]:
    """Scored hours whose outturn was public by `cutoff`: all a decision at `cutoff` may learn from."""
    return [
        p
        for points in points_by_day.values()
        for p in points
        if p.error is not None and p.hour_known_at is not None and p.hour_known_at <= cutoff
    ]


@dataclass(frozen=True)
class Calibration:
    """Error quantiles from hours whose outturn had been published by the decision's cut-off.

    calibrated forecast = max(0, forecast - p50); historical range = [forecast - p90, forecast - p10].
    """

    p10: float
    p50: float
    p90: float
    history_hours: int


def calibration_at(points_by_day: dict[date, list[Point]], cutoff: datetime) -> Calibration | None:
    known = known_by(points_by_day, cutoff)
    if len(known) < MIN_HISTORY_HOURS:
        return None
    stats = error_stats(known)
    return Calibration(stats.p10, stats.p50, stats.p90, stats.count) if stats else None


def calibrate(points: list[Point], cal: Calibration) -> list[Point]:
    """The same points with each forecast shifted by the historical median error, floored at zero."""
    return [
        p if p.forecast is None else replace(p, forecast=max(0, whole_mw(p.forecast - cal.p50)))
        for p in points
    ]


@dataclass(frozen=True)
class CalibrationGain:
    """Raw vs calibrated forecast, scored on the same days (those with enough history)."""

    days: int
    raw: ErrorStats | None
    calibrated: ErrorStats | None


def calibration_gain(points_by_day: dict[date, list[Point]], gate: time) -> CalibrationGain:
    raw: list[Point] = []
    calibrated: list[Point] = []
    days = 0
    for day, points in points_by_day.items():
        if cal := calibration_at(points_by_day, uk_instant(day, gate)):
            days += 1
            raw += points
            calibrated += calibrate(points, cal)
    return CalibrationGain(days, error_stats(raw), error_stats(calibrated))


@dataclass(frozen=True)
class HistogramBin:
    lower: int
    """Errors in [lower, lower + width) MW."""
    count: int


def histogram(errors: Iterable[float], width: int = HISTOGRAM_WIDTH_MW) -> list[HistogramBin]:
    """Contiguous fixed-width bins (empty bins included) so charts keep a true x-scale."""
    counts = Counter(int(e // width) for e in errors)  # floor division bins negatives correctly
    if not counts:
        return []
    return [HistogramBin(lower=k * width, count=counts[k]) for k in range(min(counts), max(counts) + 1)]


# --- Views served by the API ------------------------------------------------------------


@dataclass(frozen=True)
class DayView:
    decision_day: date
    delivery_day: date
    gate: datetime
    forecast_runs: list[datetime]
    """Forecast run(s) the decision would have used. Normally one."""
    next_run: datetime | None
    """First run published after the gate: the update the decision just missed."""
    decision_day_runs: list[datetime]
    """All runs published on D-1 for this delivery day, before and after the gate."""
    forecast_mwh: int | None
    actual_mwh: int | None
    stats: ErrorStats | None
    calibration: Calibration | None
    calibrated_stats: ErrorStats | None
    buy_plan: BuyPlan | None
    """Wind to plan on for this delivery day, and the extra buying it implies."""
    points: list[Point]


def day_view(
    data: WindData,
    decision_day: date,
    gate: time,
    points: list[Point],
    calibration: Calibration | None,
    plan: BuyPlan | None = None,
) -> DayView:
    forecasts = [p.forecast for p in points if p.forecast is not None]
    actuals = [p.actual for p in points]
    complete = len(forecasts) == len(points) // 2 and None not in actuals
    return DayView(
        decision_day=decision_day,
        delivery_day=decision_day + timedelta(days=1),
        gate=uk_instant(decision_day, gate),
        forecast_runs=sorted({p.published for p in points if p.published}),
        next_run=next_run_after(data, (p.start for p in points), uk_instant(decision_day, gate)),
        decision_day_runs=runs_published_on(data, (p.start for p in points), decision_day),
        forecast_mwh=sum(forecasts) if complete else None,  # hourly MW x 1 h
        actual_mwh=round(sum(actuals) / 2) if complete else None,  # half-hourly MW x 0.5 h
        stats=error_stats(points),
        calibration=calibration,
        calibrated_stats=error_stats(calibrate(points, calibration)) if calibration else None,
        buy_plan=plan,
        points=points,
    )


@dataclass(frozen=True)
class DayAccuracy:
    decision_day: date
    stats: ErrorStats | None


@dataclass(frozen=True)
class HourAccuracy:
    hour: int
    """Delivery hour, UK local time (0-23)."""
    stats: ErrorStats | None


@dataclass(frozen=True)
class AccuracyReport:
    gate: time
    overall: ErrorStats | None
    by_day: list[DayAccuracy]
    by_hour: list[HourAccuracy]
    histogram: list[HistogramBin]
    histogram_width: int
    calibration: CalibrationGain


def accuracy_report(gate: time, points_by_day: dict[date, list[Point]]) -> AccuracyReport:
    everything = [p for points in points_by_day.values() for p in points]
    by_hour: dict[int, list[Point]] = defaultdict(list)
    for p in everything:
        by_hour[p.start.astimezone(UK).hour].append(p)
    return AccuracyReport(
        gate=gate,
        overall=error_stats(everything),
        by_day=[DayAccuracy(day, error_stats(points)) for day, points in sorted(points_by_day.items())],
        by_hour=[HourAccuracy(hour, error_stats(by_hour[hour])) for hour in sorted(by_hour)],
        histogram=histogram(p.error for p in everything if p.error is not None),
        histogram_width=HISTOGRAM_WIDTH_MW,
        calibration=calibration_gain(points_by_day, gate),
    )


@dataclass(frozen=True)
class GateAccuracy:
    gate: time
    stats: ErrorStats | None


def gate_sweep(data: WindData, decision_days: list[date], step_minutes: int = 10) -> list[GateAccuracy]:
    """Accuracy if the D-1 decision were taken at each time of day: shows what each forecast run is worth."""
    gates = [time(m // 60, m % 60) for m in range(0, 24 * 60, step_minutes)]
    return [
        GateAccuracy(
            gate,
            error_stats(p for day in decision_days for p in day_ahead_points(data, day, gate)),
        )
        for gate in gates
    ]


# --- Risk-based procurement (newsvendor) ------------------------------------------------
#
# A buyer plans W_plan of wind and buys the rest day-ahead. If wind comes in below the plan,
# the gap is bought later at a premium (cost_short per MWh); if above, the surplus is sold
# back at a discount (cost_long per MWh). Expected cost is minimised by planning to the wind
# quantile at level  cost_long / (cost_short + cost_long)  — the newsvendor critical ratio
# (Bremnes 2004; Pinson, Chevallier & Kariniotakis 2007). Since wind = forecast - error,
# planning to wind level L means  W_plan = forecast - error_quantile(1 - L).

CURVE_LEVELS = [round(0.05 * i, 2) for i in range(1, 20)]


def quantile(sorted_values: list[float], p: float) -> float:
    """Linearly interpolated quantile of an already-sorted list (same rule as statistics' 'inclusive')."""
    position = p * (len(sorted_values) - 1)
    lower = math.floor(position)
    upper = min(lower + 1, len(sorted_values) - 1)
    weight = position - lower
    return sorted_values[lower] * (1 - weight) + sorted_values[upper] * weight


def planning_level(cost_short: float, cost_long: float) -> float:
    """Wind quantile to plan to. Being short dearer than long pushes it below the median."""
    return cost_long / (cost_short + cost_long)


@dataclass(frozen=True)
class StrategyCost:
    id: str
    label: str
    cost_gbp: float
    """Total over scored hours, at GB-wide scale."""
    cost_per_mwh: float
    """£ per MWh of wind delivered: scale-free, so it applies to any book size."""
    short_mwh: float
    long_mwh: float


@dataclass(frozen=True)
class DailyCost:
    decision_day: date
    raw: float
    median: float
    optimal: float


@dataclass(frozen=True)
class CurvePoint:
    level: float
    cost_per_mwh: float


@dataclass(frozen=True)
class ProcurementReport:
    cost_short: float
    cost_long: float
    planning_level: float
    best_level: float
    """Cheapest level on the backtest curve: the data's answer, to compare with the theory."""
    days: int
    hours: int
    mean_actual_mw: float
    strategies: list[StrategyCost]
    daily: list[DailyCost]
    curve: list[CurvePoint]


def procurement_report(
    points_by_day: dict[date, list[Point]], gate: time, cost_short: float, cost_long: float
) -> ProcurementReport | None:
    """Backtest raw, median and risk-optimal plans.

    Each day is planned from hours whose outturn was published by that day's cut-off, and costed
    on hourly-average outturn, so one hour at X MW is X MWh.
    """
    level = planning_level(cost_short, cost_long)
    offsets = {
        "raw": lambda _: 0.0,
        "median": lambda e: quantile(e, 0.5),
        "optimal": lambda e: quantile(e, 1 - level),
    }
    totals = {k: [0.0, 0.0, 0.0] for k in offsets}  # cost, short MWh, long MWh
    curve = dict.fromkeys(CURVE_LEVELS, 0.0)
    daily: list[DailyCost] = []
    wind_mwh = 0.0
    hours = 0

    for day, points in sorted(points_by_day.items()):
        known = known_by(points_by_day, uk_instant(day, gate))
        if len(known) < MIN_HISTORY_HOURS:
            continue
        past = sorted(p.error for p in known)
        day_cost = dict.fromkeys(offsets, 0.0)
        for p in points:
            if p.error is None:
                continue
            actual = p.hour_actual  # average MW over the hour, i.e. MWh
            hours += 1
            wind_mwh += actual
            for key, offset in offsets.items():
                plan = max(0.0, p.forecast - offset(past))  # wind can't be negative
                short, long = max(plan - actual, 0.0), max(actual - plan, 0.0)
                cost = cost_short * short + cost_long * long
                totals[key][0] += cost
                totals[key][1] += short
                totals[key][2] += long
                day_cost[key] += cost
            for lvl in CURVE_LEVELS:
                plan = max(0.0, p.forecast - quantile(past, 1 - lvl))
                curve[lvl] += cost_short * max(plan - actual, 0) + cost_long * max(actual - plan, 0)
        daily.append(
            DailyCost(day, round(day_cost["raw"]), round(day_cost["median"]), round(day_cost["optimal"]))
        )

    if not hours or wind_mwh <= 0:
        return None
    labels = {
        "raw": "Raw forecast",
        "median": "Calibrated median (P50)",
        "optimal": f"Risk-optimal (P{round(level * 100)})",
    }
    return ProcurementReport(
        cost_short=cost_short,
        cost_long=cost_long,
        planning_level=round(level, 4),
        best_level=min(curve, key=curve.__getitem__),
        days=len(daily),
        hours=hours,
        mean_actual_mw=round(wind_mwh / hours, 1),
        strategies=[
            StrategyCost(
                id=key,
                label=labels[key],
                cost_gbp=round(cost),
                cost_per_mwh=round(cost / wind_mwh, 2),
                short_mwh=round(short),
                long_mwh=round(long),
            )
            for key, (cost, short, long) in totals.items()
        ],
        daily=daily,
        curve=[CurvePoint(lvl, round(cost / wind_mwh, 2)) for lvl, cost in curve.items()],
    )


# --- Buy plan for one delivery day ---------------------------------------------------------
#
# The brief asks how much power must be bought beyond wind. That is demand minus the wind a
# desk can rely on; demand is outside the pilot's data, so the plan answers the wind half:
# how much wind to plan on at a chosen risk level, and how much more than the raw forecast
# suggests therefore has to be bought.


@dataclass(frozen=True)
class PlanHour:
    start: datetime
    plan_mw: int


@dataclass(frozen=True)
class BuyPlan:
    level: float
    """Wind quantile planned to, e.g. 0.33 = wind beaten 67% of the time."""
    offset_mw: float
    """Taken off every hourly forecast: the past-error quantile at 1 - level."""
    history_hours: int
    hours: list[PlanHour]
    forecast_mwh: int
    plan_mwh: int
    extra_mwh: int
    """forecast_mwh - plan_mwh: extra to buy compared with trusting the raw forecast."""
    bias_mwh: int
    """Part of the extra that corrects the forecast's typical error (the median plan)."""
    risk_mwh: int
    """Part of the extra that covers shortfall being dearer than surplus (negative if cheaper)."""


def buy_plan(
    points_by_day: dict[date, list[Point]], points: list[Point], cutoff: datetime, level: float
) -> BuyPlan | None:
    """Plan `points` (one delivery day) to wind level `level`, using only outturn published by `cutoff`."""
    known = known_by(points_by_day, cutoff)
    if len(known) < MIN_HISTORY_HOURS:
        return None
    past = sorted(p.error for p in known)
    offset, median = quantile(past, 1 - level), quantile(past, 0.5)
    hourly = [p for p in points if p.forecast is not None]
    plan = [max(0.0, p.forecast - offset) for p in hourly]  # wind can't be negative
    median_plan = sum(max(0.0, p.forecast - median) for p in hourly)
    forecast_mwh = sum(p.forecast for p in hourly)  # hourly MW x 1 h
    return BuyPlan(
        level=round(level, 4),
        offset_mw=round(offset, 1),
        history_hours=len(known),
        hours=[PlanHour(p.start, whole_mw(mw)) for p, mw in zip(hourly, plan, strict=True)],
        forecast_mwh=forecast_mwh,
        plan_mwh=round(sum(plan)),
        extra_mwh=round(forecast_mwh - sum(plan)),
        bias_mwh=round(forecast_mwh - median_plan),
        risk_mwh=round(median_plan - sum(plan)),
    )
