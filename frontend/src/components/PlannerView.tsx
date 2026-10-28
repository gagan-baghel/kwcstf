import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CircleCheck, Coins, Info, Scale, TrendingDown } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { type ProcurementReport, queries } from "../api";
import { addDays, dayLabel, gbp, int, pct } from "../format";
import { AXIS, COLORS, Card, Chip, ErrorBox, Kpi, LINE_TOOLTIP, ViewSkeleton } from "./ui";

const STRATEGY_COLORS = { raw: "#98a2b3", median: COLORS.calibrated, optimal: COLORS.surplus } as const;

export const COST_PRESETS = [
  { label: "Symmetric", short: 20, long: 20 },
  { label: "Short costs 2×", short: 40, long: 20 },
  { label: "Short costs 4×", short: 60, long: 15 },
];

/** Newsvendor critical ratio: the wind quantile to plan to. */
export const planningLevel = (costShort: number, costLong: number) => costLong / (costShort + costLong);

function useDebounced<T>(value: T, ms = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export const levelLabel = (level: number) => `P${Math.round(level * 100)}`;

export function PlannerView({ gate }: { gate: string }) {
  const [costShort, setCostShort] = useState(40);
  const [costLong, setCostLong] = useState(20);
  const [bookMw, setBookMw] = useState(1000);
  // Sliders move freely; the backtest only reruns once a value settles.
  const settledShort = useDebounced(costShort);
  const settledLong = useDebounced(costLong);
  const query = useQuery({
    ...queries.procurement(gate, settledShort, settledLong),
    placeholderData: keepPreviousData,
  });

  const level = planningLevel(costShort, costLong); // live, before the backtest catches up
  const report = query.data;

  return (
    <div className="stack">
      <div className="grid-planner">
        <Card
          title="Your cost assumptions"
          subtitle="What a MWh of wind error costs your desk. Replace with your own numbers."
        >
          <div className="presets" role="group" aria-label="Cost presets">
            {COST_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                aria-pressed={p.short === costShort && p.long === costLong}
                onClick={() => {
                  setCostShort(p.short);
                  setCostLong(p.long);
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <Slider
            label="Cost of being short"
            hint="Premium to buy the missing wind intraday or in imbalance"
            value={costShort}
            onChange={setCostShort}
            min={5}
            max={150}
            step={5}
            unit="£/MWh"
          />
          <Slider
            label="Cost of being long"
            hint="Discount when selling surplus back"
            value={costLong}
            onChange={setCostLong}
            min={5}
            max={150}
            step={5}
            unit="£/MWh"
          />
          <Slider
            label="Your wind book"
            hint="Average wind output your plan relies on. £ figures assume your book follows the GB wind profile, scaled."
            value={bookMw}
            onChange={setBookMw}
            min={100}
            max={5000}
            step={100}
            unit="MW"
          />
        </Card>
        <Recommendation level={level} costShort={costShort} costLong={costLong} bookMw={bookMw} report={report} />
      </div>

      {query.isPending ? (
        <ViewSkeleton />
      ) : query.isError ? (
        <ErrorBox error={query.error} onRetry={() => void query.refetch()} />
      ) : !report ? (
        <ErrorBox error={new Error("Not enough history to backtest.")} onRetry={() => void query.refetch()} />
      ) : (
        <Backtest report={report} bookMw={bookMw} loading={query.isPlaceholderData} />
      )}
    </div>
  );
}

function Slider({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step,
  unit,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  unit: string;
}) {
  return (
    <label className="slider">
      <span className="slider-head">
        <span>
          <b>{label}</b>
          <small>{hint}</small>
        </span>
        <output>
          {int.format(value)} <small>{unit}</small>
        </output>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function Recommendation({
  level,
  costShort,
  costLong,
  bookMw,
  report,
}: {
  level: number;
  costShort: number;
  costLong: number;
  bookMw: number;
  report?: ProcurementReport | null;
}) {
  const raw = report?.strategies.find((s) => s.id === "raw");
  const optimal = report?.strategies.find((s) => s.id === "optimal");
  const saved = raw && optimal && report ? (raw.cost_gbp - optimal.cost_gbp) * (bookMw / report.mean_actual_mw) : null;
  const ratio = costShort / costLong;
  const why =
    Math.abs(level - 0.5) < 0.005
      ? "Being short and long cost the same, so the calibrated median is already the cheapest plan."
      : level < 0.5
        ? `Being short costs ${ratio.toFixed(1)}× being long, so plan below the median: assume the wind level that is beaten ${Math.round((1 - level) * 100)}% of the time.`
        : `Being long costs ${(1 / ratio).toFixed(1)}× being short, so plan above the median wind.`;
  return (
    <Card title="Recommendation" className="recommend">
      <p className="recommend-level">
        Plan to <b>{levelLabel(level)}</b> wind
      </p>
      <p>{why}</p>
      <div className="formula" aria-label="Planning level formula">
        <span>level = long ÷ (short + long)</span>
        <span>
          = {costLong} ÷ ({costShort} + {costLong}) = <b>{pct(level * 100)}</b>
        </span>
      </div>
      {saved != null && raw && optimal && (
        <p className="recommend-impact">
          Over January this plan would have cut imbalance cost by <b>{gbp(saved)}</b> for a {int.format(bookMw)} MW
          book, {pct((1 - optimal.cost_gbp / raw.cost_gbp) * 100)} less than trusting the raw forecast.
        </p>
      )}
      {report && <BacktestCheck formula={report.planning_level} best={report.best_level} />}
    </Card>
  );
}

const CURVE_STEP = 0.05;

/** States whether January's cheapest level matches the formula: computed, never assumed. */
function BacktestCheck({ formula, best }: { formula: number; best: number }) {
  const gap = Math.round(Math.abs(best - formula) * 100);
  if (gap <= Math.round(CURVE_STEP * 100)) {
    return (
      <p className="recommend-proof">
        <CircleCheck size={16} />
        <span>
          January&apos;s backtest is consistent: its cheapest level was <b>{levelLabel(best)}</b>
          {gap === 0
            ? ", exactly the formula's level."
            : `, within ${gap} points of the formula (levels are tested in steps of 5).`}
        </span>
      </p>
    );
  }
  return (
    <p className="recommend-proof neutral">
      <Info size={16} />
      <span>
        January&apos;s backtest found its cheapest level at <b>{levelLabel(best)}</b>, {gap} points from the formula.
        One month is a small sample, so the formula remains the guide.
      </span>
    </p>
  );
}

function Backtest({ report, bookMw, loading }: { report: ProcurementReport; bookMw: number; loading: boolean }) {
  const scale = bookMw / report.mean_actual_mw;
  const by = Object.fromEntries(report.strategies.map((s) => [s.id, s])) as Record<
    ProcurementReport["strategies"][number]["id"],
    ProcurementReport["strategies"][number]
  >;
  const saving = (by.raw.cost_gbp - by.optimal.cost_gbp) * scale;
  const savingPct = (1 - by.optimal.cost_gbp / by.raw.cost_gbp) * 100;
  const vsMedianPct = (1 - by.optimal.cost_gbp / by.median.cost_gbp) * 100;

  const cumulative = useMemo(() => {
    const totals = { raw: 0, median: 0, optimal: 0 };
    return report.daily.map((d) => {
      totals.raw += d.raw * scale;
      totals.median += d.median * scale;
      totals.optimal += d.optimal * scale;
      return { day: d.decision_day, ...totals };
    });
  }, [report, scale]);

  return (
    <div className={`stack ${loading ? "is-loading" : ""}`}>
      <div className="kpis">
        <Kpi
          icon={Coins}
          tone="ink"
          label="Raw forecast"
          value={by.raw.cost_gbp * scale}
          format={gbp}
          sub={`£${by.raw.cost_per_mwh.toFixed(2)}/MWh · mostly short`}
        />
        <Kpi
          icon={Scale}
          tone="violet"
          label="Calibrated median (P50)"
          value={by.median.cost_gbp * scale}
          format={gbp}
          sub={`£${by.median.cost_per_mwh.toFixed(2)}/MWh`}
        />
        <Kpi
          icon={CircleCheck}
          tone="green"
          label={by.optimal.label}
          value={by.optimal.cost_gbp * scale}
          format={gbp}
          sub={`£${by.optimal.cost_per_mwh.toFixed(2)}/MWh`}
        />
        <Kpi
          icon={TrendingDown}
          tone="green"
          label="Saving vs raw forecast"
          value={saving}
          format={gbp}
          chip={<Chip tone="good">−{pct(savingPct)}</Chip>}
          sub={`${pct(vsMedianPct)} less than the median plan`}
        />
      </div>

      <div className="grid-2">
        <Card
          title="Cumulative imbalance cost"
          subtitle={`Backtest over ${report.days} January decisions for a ${int.format(bookMw)} MW wind book.`}
        >
          <div className="legend static">
            {report.strategies.map((s) => (
              <span key={s.id} className="legend-item">
                <span className="swatch line" style={{ "--c": STRATEGY_COLORS[s.id] } as CSSProperties} />
                {s.label}
              </span>
            ))}
          </div>
          <div className="chart">
            <ResponsiveContainer>
              <ComposedChart data={cumulative} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
                <CartesianGrid stroke={COLORS.grid} vertical={false} />
                <XAxis dataKey="day" {...AXIS} tickFormatter={(d: string) => String(Number(d.slice(8)))} interval={3} />
                <YAxis {...AXIS} width={52} tickFormatter={(v: number) => gbp(v)} />
                <Tooltip
                  {...LINE_TOOLTIP}
                  labelFormatter={(d) => `To ${dayLabel(String(d))} (delivery ${dayLabel(addDays(String(d), 1))})`}
                  formatter={(v, name) => [gbp(Number(v)), by[name as keyof typeof by]?.label ?? String(name)]}
                />
                {(["raw", "median", "optimal"] as const).map((id) => (
                  <Line
                    key={id}
                    dataKey={id}
                    stroke={STRATEGY_COLORS[id]}
                    strokeWidth={id === "optimal" ? 2.5 : 2}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: "#fff" }}
                    animationDuration={600}
                  />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card
          title="Theory vs January's data"
          subtitle="Imbalance cost at every planning level. Dashed line: the formula's level. Green dot: the backtest's cheapest."
        >
          <div className="chart">
            <ResponsiveContainer>
              <ComposedChart data={report.curve} margin={{ top: 20, right: 12, bottom: 0, left: 4 }}>
                <CartesianGrid stroke={COLORS.grid} vertical={false} />
                <XAxis
                  dataKey="level"
                  type="number"
                  domain={[0, 1]}
                  ticks={[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]}
                  tickFormatter={levelLabel}
                  {...AXIS}
                />
                <YAxis {...AXIS} width={52} tickFormatter={(v: number) => `£${v}`} domain={[0, "auto"]} />
                <Tooltip
                  {...LINE_TOOLTIP}
                  labelFormatter={(l) => `Plan to ${levelLabel(Number(l))} wind`}
                  formatter={(v) => [`£${Number(v).toFixed(2)}/MWh`, "Imbalance cost"]}
                />
                <ReferenceLine
                  x={report.planning_level}
                  stroke={COLORS.forecast}
                  strokeDasharray="4 4"
                  label={{
                    value: `Formula ${levelLabel(report.planning_level)}`,
                    position: "top",
                    fontSize: 11,
                    fill: COLORS.forecast,
                  }}
                />
                <Line
                  dataKey="cost_per_mwh"
                  type="monotone"
                  stroke={COLORS.actual}
                  strokeWidth={2}
                  dot={{ r: 2.5, strokeWidth: 0, fill: COLORS.actual }}
                  animationDuration={600}
                />
                <ReferenceDot
                  x={report.best_level}
                  y={report.curve.find((c) => c.level === report.best_level)?.cost_per_mwh}
                  r={6}
                  fill={COLORS.surplus}
                  stroke="#fff"
                  strokeWidth={2}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <Card title="Where the cost comes from" subtitle={`MWh over January for a ${int.format(bookMw)} MW book`} flush>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Plan</th>
                <th>Short (bought later)</th>
                <th>Long (sold back)</th>
                <th>£/MWh of wind</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {report.strategies.map((s) => (
                <tr key={s.id}>
                  <td>
                    <span className="dot" style={{ background: STRATEGY_COLORS[s.id] }} /> {s.label}
                  </td>
                  <td>{int.format(s.short_mwh * scale)}</td>
                  <td>{int.format(s.long_mwh * scale)}</td>
                  <td>£{s.cost_per_mwh.toFixed(2)}</td>
                  <td className={s.id === "optimal" ? "good" : ""}>{gbp(s.cost_gbp * scale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <details className="card methodology">
        <summary>Why planning to a quantile beats the forecast</summary>
        <ul>
          <li>
            <b>The decision:</b> the desk plans a wind volume and buys the rest day-ahead. If wind comes in lower, the
            gap is bought later at a premium; if higher, the surplus is sold back at a discount.
          </li>
          <li>
            <b>The result:</b> expected cost is minimised by planning to the wind quantile at level long ÷ (short +
            long). This is the newsvendor critical ratio, established for wind trading by Bremnes (2004) and Pinson,
            Chevallier &amp; Kariniotakis (IEEE Trans. Power Systems, 2007).
          </li>
          <li>
            <b>Our quantiles:</b> wind = forecast − error, using the errors of hours whose outturn Elexon had published
            by that day&apos;s cut-off (at least 48 hours), so every plan uses only information available at the gate.
            Costs use each hour&apos;s average outturn, so an hour at X MW counts as X MWh.
          </li>
          <li>
            <b>Scope:</b> costs are your assumptions, not market prices (the pilot uses Elexon wind data only). £
            figures scale linearly with book size; £/MWh is book-independent.
          </li>
        </ul>
      </details>
    </div>
  );
}
