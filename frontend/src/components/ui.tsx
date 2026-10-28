import { type LucideIcon, RefreshCw, TriangleAlert } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";

export const COLORS = {
  actual: "#1d2433",
  forecast: "#2f6bff",
  calibrated: "#7a5af8",
  band: "#7a5af8",
  shortfall: "#f79009",
  surplus: "#12b76a",
  grid: "#eef0f4",
  muted: "#8a94a6",
};

export const AXIS = {
  tickLine: false,
  axisLine: false,
  tick: { fontSize: 12, fill: COLORS.muted },
} as const;

const tooltipBase = {
  contentStyle: {
    background: "#ffffff",
    border: "1px solid #e4e7ec",
    borderRadius: 8,
    boxShadow: "0 12px 24px -6px rgba(16, 24, 40, 0.14)",
    padding: "8px 12px",
    fontSize: 12.5,
  },
  labelStyle: { color: "#1d2433", fontWeight: 600, marginBottom: 4 },
  itemStyle: { color: "#475467", padding: 0 },
};
export const BAR_TOOLTIP = { ...tooltipBase, cursor: { fill: "rgba(47, 107, 255, 0.06)" } };
export const LINE_TOOLTIP = { ...tooltipBase, cursor: { stroke: "#c9ced8", strokeDasharray: "4 4" } };

const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Eases from the previous value to `target`, so figures settle smoothly when the day or gate changes. */
export function useCountUp(target: number, ms = 600) {
  const [value, setValue] = useState(() => (prefersReducedMotion() ? target : 0));
  const current = useRef(value);

  useEffect(() => {
    if (prefersReducedMotion()) {
      current.current = target;
      setValue(target);
      return;
    }
    const from = current.current;
    const started = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / ms);
      current.current = from + (target - from) * (1 - (1 - t) ** 3);
      setValue(current.current);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);

  return value;
}

/** "278.6 GWh" -> 278.6 with a quieter unit. */
function WithUnit({ text }: { text: string }) {
  const match = /^(.*\d)\s([A-Za-z]+)$/.exec(text);
  if (!match) return <>{text}</>;
  return (
    <>
      {match[1]}
      <small className="unit">{match[2]}</small>
    </>
  );
}

export function AnimatedNumber({ value, format }: { value: number | null | undefined; format: (v: number) => string }) {
  const shown = useCountUp(value ?? 0);
  return value == null ? <>–</> : <WithUnit text={format(shown)} />;
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = "",
  flush = false,
}: {
  title?: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section className={`card ${className}`}>
      {title && (
        <header className="card-head">
          <div>
            <h3>{title}</h3>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className={flush ? "card-body flush" : "card-body"}>{children}</div>
    </section>
  );
}

export type Tone = "primary" | "violet" | "ink" | "amber" | "green";

export function Kpi({
  icon: Icon,
  label,
  value,
  format,
  sub,
  chip,
  tone = "primary",
  style,
}: {
  icon: LucideIcon;
  label: string;
  value: number | null | undefined;
  format: (v: number) => string;
  sub?: ReactNode;
  chip?: ReactNode;
  tone?: Tone;
  style?: CSSProperties;
}) {
  return (
    <div className="kpi fade" style={style}>
      <div className="kpi-head">
        <span className="kpi-label">{label}</span>
        <span className={`kpi-icon tone-${tone}`}>
          <Icon size={16} strokeWidth={2} />
        </span>
      </div>
      <div className="kpi-value">
        <AnimatedNumber value={value} format={format} />
      </div>
      <div className="kpi-foot">
        {chip}
        {sub && <span>{sub}</span>}
      </div>
    </div>
  );
}

export function Chip({ tone, children }: { tone: "good" | "warn" | "neutral"; children: ReactNode }) {
  return <span className={`chip ${tone}`}>{children}</span>;
}

export interface SeriesKey {
  key: string;
  label: string;
  color: string;
  kind: "line" | "dashed" | "area";
}

/** Legend that doubles as a series toggle. */
export function LegendToggle({
  items,
  hidden,
  onToggle,
}: {
  items: SeriesKey[];
  hidden: ReadonlySet<string>;
  onToggle: (key: string) => void;
}) {
  return (
    <div className="legend" role="group" aria-label="Show or hide series">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className="legend-item"
          aria-pressed={!hidden.has(item.key)}
          onClick={() => onToggle(item.key)}
        >
          <span className={`swatch ${item.kind}`} style={{ "--c": item.color } as CSSProperties} aria-hidden />
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function Skeleton({ height = 16, width = "100%" }: { height?: number | string; width?: number | string }) {
  return <span className="skeleton" style={{ height, width }} aria-hidden />;
}

export function ViewSkeleton() {
  return (
    <div className="stack" role="status" aria-label="Loading">
      <div className="kpis">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={118} />
        ))}
      </div>
      <Skeleton height={420} />
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="error-box" role="alert">
      <TriangleAlert size={18} />
      <div>
        <strong>Couldn&apos;t load the data</strong>
        <p>{error.message}</p>
      </div>
      <button type="button" onClick={onRetry}>
        <RefreshCw size={14} /> Retry
      </button>
    </div>
  );
}
