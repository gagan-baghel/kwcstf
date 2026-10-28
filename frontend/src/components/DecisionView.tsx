import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Sparkles, Target, Wind } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { type BuyPlan, type DayView, type Meta, queries } from "../api";
import {
  addDays,
  dateRange,
  dayLabel,
  duration,
  gwh,
  int,
  kiloTick,
  minutesBetween,
  mw,
  pct,
  signedMw,
  ukTime,
} from "../format";
import { DayPicker } from "./DayPicker";
import { COST_PRESETS, levelLabel, planningLevel } from "./PlannerView";
import { RunTimeline } from "./RunTimeline";
import {
  AXIS,
  AnimatedNumber,
  COLORS,
  Card,
  Chip,
  ErrorBox,
  Kpi,
  LINE_TOOLTIP,
  LegendToggle,
  type SeriesKey,
  ViewSkeleton,
} from "./ui";

interface Props {
  meta: Meta;
  day: string;
  gate: string;
  onDayChange: (day: string) => void;
}

export function DecisionView({ meta, day, gate, onDayChange }: Props) {
  const queryClient = useQueryClient();
  // Risk preset for the buy plan; "Short costs 2×" (P33) by default, as in the Buy planner.
  const [presetIndex, setPresetIndex] = useState(1);
  const preset = COST_PRESETS[presetIndex] ?? COST_PRESETS[0]!;
  const planLevel = planningLevel(preset.short, preset.long);
  const query = useQuery({ ...queries.decision(day, gate, planLevel), placeholderData: keepPreviousData });
  const accuracy = useQuery(queries.accuracy(gate)); // shared with the accuracy page; powers the day list bars

  const days = useMemo(() => dateRange(meta.first_decision_day, meta.last_decision_day), [meta]);
  const biasByDay = useMemo(
    () => new Map((accuracy.data?.by_day ?? []).flatMap((d) => (d.stats ? [[d.decision_day, d.stats.bias]] : []))),
    [accuracy.data],
  );

  const step = useCallback(
    (delta: number) => {
      const next = addDays(day, delta);
      if (days.includes(next)) onDayChange(next);
    },
    [day, days, onDayChange],
  );

  // Prefetch neighbouring days so stepping through the month is instant.
  useEffect(() => {
    for (const d of [addDays(day, -1), addDays(day, 1)]) {
      if (days.includes(d)) void queryClient.prefetchQuery(queries.decision(d, gate, planLevel));
    }
  }, [day, gate, planLevel, days, queryClient]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  return (
    <div className="stack">
      <DayPicker days={days} selected={day} biasByDay={biasByDay} onSelect={onDayChange} />
      <div>
        {query.isPending ? (
          <ViewSkeleton />
        ) : query.isError ? (
          <ErrorBox error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <DayContent
            view={query.data}
            gate={gate}
            loading={query.isPlaceholderData}
            presetIndex={presetIndex}
            onPreset={setPresetIndex}
          />
        )}
      </div>
    </div>
  );
}

/** At P50 the plan is the calibrated forecast itself (no safety margin), so it gets no line of its own. */
const isMedianPlan = (plan: BuyPlan | null) => plan != null && Math.abs(plan.level - 0.5) < 0.005;

function seriesFor(medianPlan: boolean): SeriesKey[] {
  return [
    { key: "forecast", label: "Day-ahead forecast", color: COLORS.forecast, kind: "line" },
    ...(medianPlan
      ? []
      : [{ key: "plan", label: "Wind to plan on", color: COLORS.surplus, kind: "line" } satisfies SeriesKey]),
    {
      key: "calibrated",
      label: medianPlan ? "Calibrated = wind to plan on (P50)" : "Calibrated",
      color: COLORS.calibrated,
      kind: "dashed",
    },
    { key: "range", label: "Historical range (P10–P90)", color: COLORS.band, kind: "area" },
    { key: "actual", label: "Actual", color: COLORS.actual, kind: "line" },
  ];
}

interface Row {
  time: string;
  /** Half-hour outturn, drawn on the chart. */
  actual: number | null;
  /** The hour's average outturn: what the hourly forecast is scored against. */
  hourActual: number | null;
  forecast: number | null;
  calibrated: number | null;
  /** Wind to plan on at the chosen risk level (from the buy plan). */
  plan: number | null;
  range: [number, number] | null;
}

function DayContent({
  view,
  gate,
  loading,
  presetIndex,
  onPreset,
}: {
  view: DayView;
  gate: string;
  loading: boolean;
  presetIndex: number;
  onPreset: (index: number) => void;
}) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const cal = view.calibration;
  const medianPlan = isMedianPlan(view.buy_plan);
  const rows = useMemo<Row[]>(() => {
    const planByStart = new Map((view.buy_plan?.hours ?? []).map((h) => [h.start, h.plan_mw]));
    return view.points.map((p) => ({
      time: ukTime(p.start),
      actual: p.actual,
      hourActual: p.hour_actual,
      forecast: p.forecast,
      // Same transformation as the backend's calibrated metrics: shift, round, floor at zero.
      calibrated: cal && p.forecast != null ? Math.max(0, Math.round(p.forecast - cal.p50)) : null,
      plan: planByStart.get(p.start) ?? null,
      range: cal && p.forecast != null ? [Math.max(0, p.forecast - cal.p90), p.forecast - cal.p10] : null,
    }));
  }, [view, cal]);

  const calibratedMwh = cal ? rows.reduce((sum, r) => sum + (r.calibrated ?? 0), 0) : null;
  const gap = view.forecast_mwh != null && view.actual_mwh != null ? view.actual_mwh - view.forecast_mwh : null;
  const gapPct = gap != null && view.forecast_mwh ? (Math.abs(gap) / view.forecast_mwh) * 100 : null;
  const run = view.forecast_runs.at(-1);
  const raw = view.stats;
  const tuned = view.calibrated_stats;
  const improvement = raw && tuned ? (1 - tuned.mae / raw.mae) * 100 : null;

  return (
    <div className={`stack ${loading ? "is-loading" : ""}`}>
      <div className="detail-head">
        <div>
          <h2>Delivery {dayLabel(view.delivery_day)}</h2>
          <p>
            Decided {dayLabel(view.decision_day)} by {gate} UK
            {run && (
              <>
                {" "}
                · {ukTime(run)} forecast run, {duration(minutesBetween(run, view.gate))} before the gate
              </>
            )}
          </p>
        </div>
        {gap != null && gapPct != null && (
          <Chip tone={gap < 0 ? "warn" : "good"}>
            Wind {gap < 0 ? "under" : "over"}-delivered by {gwh(Math.abs(gap))} ({pct(gapPct)})
          </Chip>
        )}
      </div>

      <BuyPlanCard view={view} presetIndex={presetIndex} onPreset={onPreset} />

      <div className="kpis">
        <Kpi
          icon={Wind}
          tone="primary"
          label="Day-ahead forecast"
          value={view.forecast_mwh}
          format={gwh}
          sub="Raw forecast at the gate"
        />
        <Kpi
          icon={Sparkles}
          tone="violet"
          label="Calibrated forecast"
          value={calibratedMwh}
          format={gwh}
          sub={
            cal
              ? `Shifted ${signedMw(-cal.p50)}, from ${int.format(cal.history_hours)} hours published by the gate`
              : "Needs 48 hours of published outturn"
          }
        />
        <Kpi
          icon={Activity}
          tone="ink"
          label="Actual outturn"
          value={view.actual_mwh}
          format={gwh}
          chip={
            gap != null && gapPct != null ? (
              <Chip tone={gap < 0 ? "warn" : "good"}>
                {gap < 0 ? "−" : "+"}
                {pct(gapPct)}
              </Chip>
            ) : undefined
          }
          sub="vs day-ahead forecast"
        />
        <Kpi
          icon={Target}
          tone="amber"
          label="Hourly error (MAE)"
          value={raw?.mae}
          format={mw}
          chip={improvement != null && improvement > 0 ? <Chip tone="good">−{pct(improvement)}</Chip> : undefined}
          sub={tuned ? `${mw(tuned.mae)} after calibration` : raw ? `Bias ${signedMw(raw.bias)}` : undefined}
        />
      </div>

      <Card
        title="Generation profile"
        subtitle="MW, UK time. Forecast as known at the gate vs metered output."
        actions={<LegendToggle items={seriesFor(medianPlan)} hidden={hidden} onToggle={toggle} />}
      >
        <div className="chart chart-lg">
          <ResponsiveContainer>
            <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
              <defs>
                <linearGradient id="actualFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={COLORS.actual} stopOpacity={0.08} />
                  <stop offset="100%" stopColor={COLORS.actual} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={COLORS.grid} vertical={false} />
              <XAxis dataKey="time" interval={5} {...AXIS} />
              <YAxis tickFormatter={kiloTick} width={44} {...AXIS} />
              <Tooltip content={<DayTooltip medianPlan={medianPlan} />} cursor={LINE_TOOLTIP.cursor} />
              {!hidden.has("range") && (
                <Area
                  dataKey="range"
                  stroke="none"
                  fill={COLORS.band}
                  fillOpacity={0.1}
                  connectNulls
                  animationDuration={600}
                />
              )}
              {!hidden.has("actual") && (
                <Area
                  dataKey="actual"
                  stroke={COLORS.actual}
                  strokeWidth={2}
                  fill="url(#actualFill)"
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: "#fff" }}
                  animationDuration={600}
                />
              )}
              {!hidden.has("calibrated") && (
                <Line
                  dataKey="calibrated"
                  stroke={COLORS.calibrated}
                  strokeWidth={2}
                  strokeDasharray="5 4"
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: "#fff" }}
                  connectNulls
                  animationDuration={600}
                />
              )}
              {!medianPlan && !hidden.has("plan") && (
                <Line
                  dataKey="plan"
                  stroke={COLORS.surplus}
                  strokeWidth={2.25}
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: "#fff" }}
                  connectNulls
                  animationDuration={600}
                />
              )}
              {!hidden.has("forecast") && (
                <Line
                  dataKey="forecast"
                  stroke={COLORS.forecast}
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: "#fff" }}
                  connectNulls
                  animationDuration={600}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <div className="grid-2 align-start">
        <Card title="Forecast runs on the decision day" subtitle="Which run was in hand when the gate closed">
          <RunTimeline view={view} />
          <p className="note">
            {run
              ? `The decision used the ${ukTime(run)} run.`
              : "No run for this delivery day had been published by the gate."}
            {view.next_run &&
              ` The next run (${ukTime(view.next_run)}) arrived ${duration(minutesBetween(view.gate, view.next_run))} after the gate.`}
          </p>
        </Card>
        <Card
          title="Hourly detail"
          subtitle="MW. Each hourly forecast is scored against the average of that hour's two half-hours; amber means short."
          flush
        >
          <HourlyTable
            rows={rows}
            planLabel={view.buy_plan && !medianPlan ? levelLabel(view.buy_plan.level) : null}
            medianPlan={medianPlan}
          />
        </Card>
      </div>
    </div>
  );
}

function HourlyTable({ rows, planLabel, medianPlan }: { rows: Row[]; planLabel: string | null; medianPlan: boolean }) {
  const hourly = rows.filter((r) => r.forecast != null);
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Hour</th>
            <th>Forecast</th>
            <th>{medianPlan ? "Calibrated = plan (P50)" : "Calibrated"}</th>
            {planLabel && <th>Plan ({planLabel})</th>}
            <th>Actual (hour avg)</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {hourly.map((r) => {
            const error = r.forecast != null && r.hourActual != null ? r.forecast - r.hourActual : null;
            return (
              <tr key={r.time}>
                <td>{r.time}</td>
                <td>{r.forecast == null ? "–" : int.format(r.forecast)}</td>
                <td className={medianPlan ? "plan-cell" : ""}>
                  {r.calibrated == null ? "–" : int.format(r.calibrated)}
                </td>
                {planLabel && <td className="plan-cell">{r.plan == null ? "–" : int.format(r.plan)}</td>}
                <td>{r.hourActual == null ? "–" : int.format(r.hourActual)}</td>
                <td className={error == null ? "" : error > 0 ? "warn" : "good"}>
                  {error == null ? "–" : `${error > 0 ? "+" : error < 0 ? "−" : ""}${int.format(Math.abs(error))}`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DayTooltip({
  active,
  payload,
  medianPlan,
}: {
  active?: boolean;
  payload?: { payload?: Row }[];
  medianPlan: boolean;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  const error = row.forecast != null && row.hourActual != null ? row.forecast - row.hourActual : null;
  return (
    <div className="tooltip">
      <div className="tooltip-title">{row.time} UK</div>
      <dl>
        <dt>
          <i style={{ background: COLORS.actual }} /> Actual, half hour
        </dt>
        <dd>{mw(row.actual)}</dd>
        {row.hourActual != null && (
          <>
            <dt>
              <i style={{ background: COLORS.actual, opacity: 0.4 }} /> Actual, hour average
            </dt>
            <dd>{mw(row.hourActual)}</dd>
          </>
        )}
        {row.forecast != null && (
          <>
            <dt>
              <i style={{ background: COLORS.forecast }} /> Forecast
            </dt>
            <dd>{mw(row.forecast)}</dd>
            <dt>
              <i style={{ background: COLORS.calibrated }} /> {medianPlan ? "Calibrated = plan (P50)" : "Calibrated"}
            </dt>
            <dd>{mw(row.calibrated)}</dd>
            {row.plan != null && !medianPlan && (
              <>
                <dt>
                  <i style={{ background: COLORS.surplus }} /> Wind to plan on
                </dt>
                <dd>{mw(row.plan)}</dd>
              </>
            )}
            {row.range && (
              <>
                <dt>
                  <i style={{ background: COLORS.band, opacity: 0.4 }} /> Historical range
                </dt>
                <dd>
                  {kiloTick(row.range[0])}–{kiloTick(row.range[1])}
                </dd>
              </>
            )}
            <dt className="sep">Error vs hour average</dt>
            <dd className={`sep ${error != null && error > 0 ? "warn" : "good"}`}>{signedMw(error)}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/** The decision itself: how much wind to plan on, and how much more than the forecast to buy. */
function BuyPlanCard({
  view,
  presetIndex,
  onPreset,
}: {
  view: DayView;
  presetIndex: number;
  onPreset: (index: number) => void;
}) {
  const plan = view.buy_plan;
  return (
    <Card
      className="buy-plan"
      title={`Buy plan for ${dayLabel(view.delivery_day)}`}
      subtitle="Uses only data published by the gate. Same rule as the Buy planner."
      actions={
        <div className="presets compact" role="group" aria-label="Risk preset">
          {COST_PRESETS.map((p, i) => (
            <button key={p.label} type="button" aria-pressed={i === presetIndex} onClick={() => onPreset(i)}>
              {p.label} · {levelLabel(planningLevel(p.short, p.long))}
            </button>
          ))}
        </div>
      }
    >
      {plan ? (
        <BuyPlanBody plan={plan} />
      ) : (
        <p className="muted">
          Needs 48 hours of outturn published before the gate, which first happens for the 4 Jan decision.
        </p>
      )}
    </Card>
  );
}

function BuyPlanBody({ plan }: { plan: BuyPlan }) {
  const buyMore = plan.extra_mwh >= 0;
  const parts = [
    {
      key: "bias",
      label: "Forecast bias correction",
      note: "the forecast typically runs high",
      value: plan.bias_mwh,
      color: COLORS.calibrated,
    },
    {
      key: "risk",
      label: isMedianPlan(plan) ? "Safety margin" : `Safety margin (${levelLabel(plan.level)} vs P50)`,
      note: isMedianPlan(plan)
        ? "none: being short and being long cost the same"
        : plan.risk_mwh >= 0
          ? "being short costs more than being long"
          : "being long costs more than being short",
      value: plan.risk_mwh,
      color: COLORS.surplus,
    },
  ];
  const total = parts.reduce((sum, p) => sum + Math.max(0, p.value), 0) || 1;
  return (
    <div className="buy-plan-body">
      <div className="buy-figures">
        <div className="buy-figure">
          <span>Wind to plan on</span>
          <b>
            <AnimatedNumber value={plan.plan_mwh} format={gwh} />
          </b>
          <small>
            {levelLabel(plan.level)} plan vs the forecast&apos;s {gwh(plan.forecast_mwh)}
          </small>
        </div>
        <div className={`buy-figure ${buyMore ? "accent" : ""}`}>
          <span>{buyMore ? "Buy beyond the forecast" : "Buy less than the forecast suggests"}</span>
          <b>
            <AnimatedNumber value={Math.abs(plan.extra_mwh)} format={(v) => `${buyMore ? "+" : "−"}${gwh(v)}`} />
          </b>
          <small>compared with trusting the raw forecast</small>
        </div>
      </div>
      <div className="buy-breakdown">
        <span className="buy-breakdown-title">Where the extra comes from</span>
        <div className="split-bar" aria-hidden>
          {parts.map((p) =>
            p.value > 0 ? (
              <i key={p.key} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />
            ) : null,
          )}
        </div>
        <dl>
          {parts.map((p) => (
            <div key={p.key}>
              <dt>
                <i style={{ background: p.color }} /> {p.label}
                <small>{p.note}</small>
              </dt>
              <dd>{p.key === "risk" && isMedianPlan(plan) ? "None" : signedGwh(p.value)}</dd>
            </div>
          ))}
        </dl>
        <p className="note">
          Total to buy day-ahead = your demand − {gwh(plan.plan_mwh)} of wind. Demand is outside this pilot&apos;s data.
        </p>
      </div>
    </div>
  );
}

const signedGwh = (mwh: number) => `${mwh > 0 ? "+" : mwh < 0 ? "−" : ""}${gwh(Math.abs(mwh))}`;
