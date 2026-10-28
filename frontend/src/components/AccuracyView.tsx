import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  CircleCheck,
  Clock,
  Gauge,
  type LucideIcon,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  TriangleAlert,
} from "lucide-react";
import { useMemo } from "react";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { type AccuracyReport, type GateAccuracy, type Meta, queries } from "../api";
import { addDays, dayLabel, hhmm, kiloTick, mw, pct, signedMw } from "../format";
import { AXIS, BAR_TOOLTIP, COLORS, Card, Chip, ErrorBox, Kpi, LINE_TOOLTIP, ViewSkeleton } from "./ui";

const SWEEP_TICKS = ["00:00", "03:00", "06:00", "09:00", "12:00", "15:00", "18:00", "21:00"];

interface Props {
  meta: Meta;
  gate: string;
  onOpenDay: (day: string) => void;
}

export function AccuracyView({ meta, gate, onOpenDay }: Props) {
  const report = useQuery({ ...queries.accuracy(gate), placeholderData: keepPreviousData });
  const sweep = useQuery(queries.gateSweep());

  if (report.isPending) return <ViewSkeleton />;
  if (report.isError) return <ErrorBox error={report.error} onRetry={() => void report.refetch()} />;

  const data = report.data;
  return (
    <div className={`stack ${report.isPlaceholderData ? "is-loading" : ""}`}>
      <Headline report={data} />
      <div className="grid-insights">
        <Insights meta={meta} report={data} sweep={sweep.data} gate={gate} />
        <Summary report={data} />
      </div>
      <div className="grid-2">
        <DailyChart report={data} onOpenDay={onOpenDay} />
        <HourlyChart report={data} />
        <Histogram report={data} />
        <SweepChart meta={meta} sweep={sweep.data} gate={gate} />
      </div>
      <Methodology />
    </div>
  );
}

function Headline({ report }: { report: AccuracyReport }) {
  const o = report.overall;
  if (!o) return null;
  const shortDays = report.by_day.filter((d) => (d.stats?.bias ?? 0) > 0).length;
  const { raw, calibrated } = report.calibration;
  const gain = raw && calibrated ? (1 - calibrated.mae / raw.mae) * 100 : null;
  return (
    <div className="kpis">
      <Kpi
        icon={TrendingUp}
        tone="amber"
        label="Average bias"
        value={o.bias}
        format={signedMw}
        chip={<Chip tone="warn">{`${shortDays}/${report.by_day.length} days short`}</Chip>}
      />
      <Kpi
        icon={ShieldAlert}
        tone="amber"
        label="P90 shortfall"
        value={o.p90}
        format={mw}
        sub={`Worst hour ${mw(o.max_shortfall)}`}
      />
      <Kpi
        icon={Gauge}
        tone="primary"
        label="Mean absolute error"
        value={o.mae}
        format={mw}
        sub={`${pct(o.nmae_pct)} of mean output`}
      />
      <Kpi
        icon={Sparkles}
        tone="green"
        label="Error removed by calibration"
        value={gain}
        format={(v) => `${pct(v)}`}
        sub={raw && calibrated ? `MAE ${mw(raw.mae)} → ${mw(calibrated.mae)}` : "Needs history"}
      />
    </div>
  );
}

function Insights({
  meta,
  report,
  sweep,
  gate,
}: {
  meta: Meta;
  report: AccuracyReport;
  sweep?: GateAccuracy[];
  gate: string;
}) {
  const o = report.overall;
  if (!o) return null;
  const shortDays = report.by_day.filter((d) => (d.stats?.bias ?? 0) > 0).length;
  const { raw, calibrated, days } = report.calibration;
  const maeAt = (time: string) => sweep?.find((g) => hhmm(g.gate) === time)?.stats?.mae;
  const [first, second] = meta.gates;
  const early = first && maeAt(hhmm(first.closes_at));
  const late = second && maeAt(hhmm(second.closes_at));

  const items: { icon: LucideIcon; tone: string; text: string }[] = [
    {
      icon: TriangleAlert,
      tone: "warn",
      text: `The ${gate} forecast ran high on ${shortDays} of ${report.by_day.length} days. Buying against it left the desk short by ${signedMw(o.bias)} on average.`,
    },
    {
      icon: ShieldAlert,
      tone: "warn",
      text: `A ${mw(o.p90)} buffer would have covered the shortfall in about 90% of January's evaluated hours. The worst hour missed by ${mw(o.max_shortfall)}. That is past coverage, not a guarantee.`,
    },
  ];
  if (raw && calibrated) {
    items.push({
      icon: CircleCheck,
      tone: "good",
      text: `Shifting each forecast by the median of past errors cuts MAE from ${mw(raw.mae)} to ${mw(calibrated.mae)} and the P90 buffer by ${mw(raw.p90 - calibrated.p90)} (${days} days scored).`,
    });
  }
  if (first && second && early != null && late != null) {
    items.push({
      icon: Clock,
      tone: "info",
      text: `Deciding at ${second.id.toUpperCase()} ${hhmm(second.closes_at)} instead of ${first.id.toUpperCase()} ${hhmm(first.closes_at)} changes MAE by ${signedMw(late - early)}. Timing matters far less than the bias.`,
    });
  }

  return (
    <Card title="What this means for the desk">
      <ul className="insights">
        {items.map(({ icon: Icon, tone, text }) => (
          <li key={text}>
            <span className={`insight-icon ${tone}`}>
              <Icon size={16} />
            </span>
            <p>{text}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Summary({ report }: { report: AccuracyReport }) {
  const o = report.overall;
  if (!o) return null;
  const rows: [string, string][] = [
    ["Hours scored", o.count.toLocaleString("en-GB")],
    ["Mean output", mw(o.mean_actual)],
    ["MAE", mw(o.mae)],
    ["RMSE", mw(o.rmse)],
    ["Bias (mean error)", signedMw(o.bias)],
    ["Median error (P50)", signedMw(o.p50)],
    ["P10 error", signedMw(o.p10)],
    ["P90 error", signedMw(o.p90)],
  ];
  return (
    <Card title="Error statistics" subtitle="Hourly, forecast − actual" flush>
      <dl className="stat-list">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function DailyChart({ report, onOpenDay }: { report: AccuracyReport; onOpenDay: (day: string) => void }) {
  const rows = useMemo(
    () => report.by_day.map((d) => ({ day: d.decision_day, bias: d.stats?.bias ?? null, mae: d.stats?.mae ?? null })),
    [report],
  );
  return (
    <Card title="Error by decision day" subtitle="Bars: bias (amber = short). Line: MAE. Click a day to open it.">
      <div className="chart">
        <ResponsiveContainer>
          <ComposedChart
            data={rows}
            margin={{ top: 8, right: 8, bottom: 0, left: -8 }}
            onClick={(state) => typeof state?.activeLabel === "string" && onOpenDay(state.activeLabel)}
            style={{ cursor: "pointer" }}
          >
            <CartesianGrid stroke={COLORS.grid} vertical={false} />
            <XAxis dataKey="day" {...AXIS} tickFormatter={(d: string) => String(Number(d.slice(8)))} interval={2} />
            <YAxis {...AXIS} width={44} tickFormatter={kiloTick} />
            <ReferenceLine y={0} stroke="#d0d5dd" />
            <Tooltip
              {...BAR_TOOLTIP}
              labelFormatter={(d) => `Decided ${dayLabel(String(d))} → delivery ${dayLabel(addDays(String(d), 1))}`}
              formatter={(v, name) => [signedMw(Number(v)), name === "bias" ? "Bias" : "MAE"]}
            />
            <Bar dataKey="bias" radius={[3, 3, 0, 0]} maxBarSize={14} animationDuration={600}>
              {rows.map((r) => (
                <Cell key={r.day} fill={(r.bias ?? 0) > 0 ? COLORS.shortfall : COLORS.surplus} />
              ))}
            </Bar>
            <Line
              dataKey="mae"
              stroke={COLORS.forecast}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "#fff" }}
              animationDuration={600}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function HourlyChart({ report }: { report: AccuracyReport }) {
  const rows = report.by_hour.map((h) => ({
    hour: `${String(h.hour).padStart(2, "0")}:00`,
    mae: h.stats?.mae ?? null,
    p90: h.stats?.p90 ?? null,
  }));
  return (
    <Card title="Error by delivery hour" subtitle="Bars: MAE. Line: P90 shortfall. Lead time grows from ≈15 h to 38 h.">
      <div className="chart">
        <ResponsiveContainer>
          <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
            <CartesianGrid stroke={COLORS.grid} vertical={false} />
            <XAxis dataKey="hour" {...AXIS} interval={2} />
            <YAxis {...AXIS} width={44} tickFormatter={kiloTick} />
            <Tooltip
              {...BAR_TOOLTIP}
              formatter={(v, name) => [mw(Number(v)), name === "mae" ? "MAE" : "P90 shortfall"]}
            />
            <Bar
              dataKey="mae"
              fill={COLORS.forecast}
              fillOpacity={0.35}
              radius={[3, 3, 0, 0]}
              maxBarSize={14}
              animationDuration={600}
            />
            <Line
              dataKey="p90"
              type="monotone"
              stroke={COLORS.shortfall}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "#fff" }}
              animationDuration={600}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function Histogram({ report }: { report: AccuracyReport }) {
  const width = report.histogram_width;
  const rows = report.histogram.map((b) => ({ ...b, label: kiloTick(b.lower) }));
  return (
    <Card
      title="Distribution of hourly errors"
      subtitle={`Forecast − actual in ${width} MW bins. Skewed to the short side.`}
    >
      <div className="chart">
        <ResponsiveContainer>
          <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -14 }} barCategoryGap={2}>
            <CartesianGrid stroke={COLORS.grid} vertical={false} />
            <XAxis dataKey="label" {...AXIS} interval={1} />
            <YAxis {...AXIS} width={40} allowDecimals={false} />
            <Tooltip
              {...BAR_TOOLTIP}
              labelFormatter={(_, items) => {
                const lower = (items?.[0]?.payload as { lower?: number } | undefined)?.lower ?? 0;
                return `${signedMw(lower)} to ${signedMw(lower + width)}`;
              }}
              formatter={(v) => [`${v} hours`, "Count"]}
            />
            <Bar dataKey="count" radius={[2, 2, 0, 0]} animationDuration={600}>
              {rows.map((r) => (
                <Cell key={r.lower} fill={r.lower >= 0 ? COLORS.shortfall : COLORS.surplus} />
              ))}
            </Bar>
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function SweepChart({ meta, sweep, gate }: { meta: Meta; sweep?: GateAccuracy[]; gate: string }) {
  const rows = useMemo(
    () => (sweep ?? []).map((g) => ({ gate: hhmm(g.gate), mae: g.stats?.mae ?? null, p90: g.stats?.p90 ?? null })),
    [sweep],
  );
  return (
    <Card
      title="What the decision time is worth"
      subtitle="MAE (blue) and P90 shortfall (amber) for each decision time on D-1. Steps are new forecast runs."
    >
      <div className="chart">
        {!sweep ? (
          <span className="skeleton" style={{ height: "100%", width: "100%" }} />
        ) : (
          <ResponsiveContainer>
            <ComposedChart data={rows} margin={{ top: 18, right: 8, bottom: 0, left: -8 }}>
              <CartesianGrid stroke={COLORS.grid} vertical={false} />
              <XAxis dataKey="gate" {...AXIS} ticks={SWEEP_TICKS} />
              <YAxis {...AXIS} width={44} tickFormatter={kiloTick} domain={[0, "auto"]} />
              <Tooltip
                {...LINE_TOOLTIP}
                labelFormatter={(g) => `Decide at ${g} on D-1`}
                formatter={(v, name) => [mw(Number(v)), name === "mae" ? "MAE" : "P90 shortfall"]}
              />
              {meta.gates.map((g, i) => (
                <ReferenceLine
                  key={g.id}
                  x={hhmm(g.closes_at)}
                  stroke="#98a2b3"
                  strokeDasharray="3 3"
                  // Gates sit close together: put labels on opposite sides of their lines.
                  label={{
                    value: g.id.toUpperCase(),
                    position: i % 2 ? "insideTopLeft" : "insideTopRight",
                    fontSize: 10,
                    fill: COLORS.muted,
                  }}
                />
              ))}
              {!meta.gates.some((g) => hhmm(g.closes_at) === gate) && (
                <ReferenceLine
                  x={gate}
                  stroke={COLORS.calibrated}
                  label={{ value: "YOU", position: "top", fontSize: 10, fill: COLORS.calibrated }}
                />
              )}
              <Line
                type="stepAfter"
                dataKey="p90"
                stroke={COLORS.shortfall}
                strokeWidth={2}
                dot={false}
                animationDuration={600}
              />
              <Line
                type="stepAfter"
                dataKey="mae"
                stroke={COLORS.forecast}
                strokeWidth={2}
                dot={false}
                animationDuration={600}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}

function Methodology() {
  return (
    <details className="card methodology">
      <summary>How these numbers are built</summary>
      <ul>
        <li>
          <b>Scope:</b> purchase decisions made 1–31 Jan 2026, so delivery days 2 Jan – 1 Feb 2026 (UK settlement days).
        </li>
        <li>
          <b>No look-ahead:</b> for each delivery hour we use the latest Elexon WINDFOR run published at or before the
          D-1 cut-off. Rows a run repeats for hours already past are discarded.
        </li>
        <li>
          <b>Actuals:</b> Elexon FUELHH, fuel type WIND: average MW per half hour. Each hourly forecast (treated as that
          hour&apos;s average) is scored against the mean of the hour&apos;s two half-hours.
        </li>
        <li>
          <b>Error = forecast − actual.</b> Positive means wind under-delivered and the buyer was short.
        </li>
        <li>
          <b>Calibration</b> shifts each forecast by the median error of hours whose outturn Elexon had published by
          that decision&apos;s cut-off (at least 48 hours), floored at zero. The P10–P90 band comes from the same past
          errors.
        </li>
        <li>
          <b>Likely cause of the bias (hypothesis):</b> metered output is net of wind turned down for grid constraints,
          which a weather-driven forecast does not predict. Confirming it needs balancing-mechanism data, outside this
          pilot&apos;s scope.
        </li>
      </ul>
    </details>
  );
}
