from datetime import UTC, date, datetime, time, timedelta

import pytest

from app.analysis import delivery_slots
from app.elexon import WindData

ACTUAL_MW = 800
EARLY_RUN_MW = 1000  # published 07:30 on D-1, before both auction gates
LATE_RUN_MW = 2000  # published 09:30 on D-1, between the 09:20 and 09:50 gates


HALF_HOUR = timedelta(minutes=30)


def make_wind_data(decision_days: list[date]) -> WindData:
    """Two forecast runs per decision day and flat actuals, so expected errors are obvious.

    Like Elexon, each half hour's outturn is published when that half hour ends.
    """
    actuals: dict[datetime, int] = {}
    published: dict[datetime, datetime] = {}
    forecasts: dict[datetime, list[tuple[datetime, int]]] = {}
    for day in decision_days:
        early = datetime.combine(day, time(7, 30), tzinfo=UTC)
        late = datetime.combine(day, time(9, 30), tzinfo=UTC)
        for slot in delivery_slots(day + timedelta(days=1)):
            actuals[slot] = ACTUAL_MW
            published[slot] = slot + HALF_HOUR
            if slot.minute == 0:
                forecasts[slot] = [(early, EARLY_RUN_MW), (late, LATE_RUN_MW)]
    return WindData(actuals=actuals, actuals_published=published, forecasts=forecasts)


@pytest.fixture
def january() -> list[date]:
    return [date(2026, 1, 1) + timedelta(days=i) for i in range(31)]


@pytest.fixture
def wind_data(january: list[date]) -> WindData:
    return make_wind_data(january)
