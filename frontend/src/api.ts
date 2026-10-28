import { queryOptions } from "@tanstack/react-query";

// Mirrors the FastAPI response models (see /docs on the backend).

export interface ErrorStats {
  count: number;
  mae: number;
  rmse: number;
  /** Mean of forecast - actual. Positive: forecasts ran high, wind under-delivered. */
  bias: number;
  p10: number;
  p50: number;
  /** 90% of the evaluated hours had a shortfall no larger than this (historical, not a guarantee). */
  p90: number;
  max_shortfall: number;
  mean_actual: number;
  nmae_pct: number | null;
}

export interface Calibration {
  p10: number;
  p50: number;
  p90: number;
  /** Scored hours whose outturn had been published by the decision's cut-off. */
  history_hours: number;
}

export interface Point {
  start: string;
  /** Half-hour average outturn (MW). */
  actual: number | null;
  /** Hourly forecast (MW), on the hour only. */
  forecast: number | null;
  published: string | null;
  /** On forecast slots: average outturn over the forecast's hour, which is what errors are scored against. */
  hour_actual: number | null;
  hour_known_at: string | null;
}

export interface BuyPlan {
  /** Wind quantile planned to, e.g. 0.33 = wind beaten 67% of the time. */
  level: number;
  offset_mw: number;
  history_hours: number;
  hours: { start: string; plan_mw: number }[];
  forecast_mwh: number;
  plan_mwh: number;
  /** Extra to buy compared with trusting the raw forecast: bias_mwh + risk_mwh. */
  extra_mwh: number;
  bias_mwh: number;
  risk_mwh: number;
}

export interface DayView {
  decision_day: string;
  delivery_day: string;
  gate: string;
  forecast_runs: string[];
  next_run: string | null;
  decision_day_runs: string[];
  forecast_mwh: number | null;
  actual_mwh: number | null;
  stats: ErrorStats | null;
  calibration: Calibration | null;
  calibrated_stats: ErrorStats | null;
  buy_plan: BuyPlan | null;
  points: Point[];
}

export interface AccuracyReport {
  gate: string;
  overall: ErrorStats | null;
  by_day: { decision_day: string; stats: ErrorStats | null }[];
  by_hour: { hour: number; stats: ErrorStats | null }[];
  histogram: { lower: number; count: number }[];
  histogram_width: number;
  calibration: { days: number; raw: ErrorStats | null; calibrated: ErrorStats | null };
}

export interface GateAccuracy {
  gate: string;
  stats: ErrorStats | null;
}

export interface StrategyCost {
  id: "raw" | "median" | "optimal";
  label: string;
  cost_gbp: number;
  cost_per_mwh: number;
  short_mwh: number;
  long_mwh: number;
}

export interface ProcurementReport {
  cost_short: number;
  cost_long: number;
  planning_level: number;
  best_level: number;
  days: number;
  hours: number;
  mean_actual_mw: number;
  strategies: StrategyCost[];
  daily: { decision_day: string; raw: number; median: number; optimal: number }[];
  curve: { level: number; cost_per_mwh: number }[];
}

export interface Gate {
  id: string;
  label: string;
  closes_at: string;
}

export interface Meta {
  first_decision_day: string;
  last_decision_day: string;
  gates: Gate[];
  default_gate: string;
}

async function getJson<T>(path: string, params: Record<string, string>, signal: AbortSignal): Promise<T> {
  const query = new URLSearchParams(params).toString();
  const res = await fetch(query ? `${path}?${query}` : path, { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(typeof body?.detail === "string" ? body.detail : `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

// January 2026 is history: once fetched, data never goes stale.
export const queries = {
  meta: () =>
    queryOptions({
      queryKey: ["meta"],
      queryFn: ({ signal }) => getJson<Meta>("/api/v1/meta", {}, signal),
    }),
  decision: (day: string, gate: string, planLevel: number) =>
    queryOptions({
      queryKey: ["decision", day, gate, planLevel],
      queryFn: ({ signal }) =>
        getJson<DayView>("/api/v1/decision", { day, gate, plan_level: String(planLevel) }, signal),
    }),
  accuracy: (gate: string) =>
    queryOptions({
      queryKey: ["accuracy", gate],
      queryFn: ({ signal }) => getJson<AccuracyReport>("/api/v1/accuracy", { gate }, signal),
    }),
  procurement: (gate: string, costShort: number, costLong: number) =>
    queryOptions({
      queryKey: ["procurement", gate, costShort, costLong],
      queryFn: ({ signal }) =>
        getJson<ProcurementReport | null>(
          "/api/v1/procurement",
          { gate, cost_short: String(costShort), cost_long: String(costLong) },
          signal,
        ),
    }),
  gateSweep: () =>
    queryOptions({
      queryKey: ["gate-sweep"],
      queryFn: ({ signal }) => getJson<GateAccuracy[]>("/api/v1/gate-sweep", {}, signal),
    }),
};
