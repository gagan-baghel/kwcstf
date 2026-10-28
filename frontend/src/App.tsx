import { useQuery } from "@tanstack/react-query";
import { ChartSpline, ChevronRight, Database, Gauge, Scale } from "lucide-react";
import { type Meta, queries } from "./api";
import { AccuracyView } from "./components/AccuracyView";
import { DecisionView } from "./components/DecisionView";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { GateControl } from "./components/GateControl";
import { PlannerView } from "./components/PlannerView";
import { ErrorBox, ViewSkeleton } from "./components/ui";
import { dayLabel, hhmm } from "./format";
import { type View, useUrlState } from "./useUrlState";

const PAGES: Record<View, { label: string; short: string; title: string; subtitle: string; icon: typeof Gauge }> = {
  decision: {
    label: "Decisions",
    short: "Decisions",
    title: "What you knew at the gate",
    subtitle: "The forecast in hand at each day-ahead cut-off, against what the wind then did.",
    icon: ChartSpline,
  },
  accuracy: {
    label: "Forecast accuracy",
    short: "Accuracy",
    title: "Forecast accuracy",
    subtitle: "How far the day-ahead wind forecast could be trusted across every January decision.",
    icon: Gauge,
  },
  planner: {
    label: "Buy planner",
    short: "Planner",
    title: "Risk-based buy planner",
    subtitle: "Turn the forecast and its known error into the day-ahead plan with the lowest imbalance cost.",
    icon: Scale,
  },
};

export default function App() {
  const meta = useQuery(queries.meta());
  const [url, setUrl] = useUrlState();
  const page = PAGES[url.view];

  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="WindDesk home">
          <img src="/favicon.svg" alt="" width={30} height={30} />
          <span>WindDesk</span>
        </a>
        <nav className="side-nav" aria-label="Views">
          <span className="side-label">Day-ahead wind</span>
          {(Object.keys(PAGES) as View[]).map((id) => {
            const { label, short, icon: Icon } = PAGES[id];
            return (
              <button
                key={id}
                type="button"
                aria-current={url.view === id ? "page" : undefined}
                onClick={() => setUrl({ view: id })}
              >
                <Icon size={18} strokeWidth={1.9} />
                <span className="nav-long">{label}</span>
                <span className="nav-short">{short}</span>
              </button>
            );
          })}
        </nav>
        {meta.data && (
          <div className="side-foot">
            <div className="scope">
              <span className="side-label">Pilot scope</span>
              <p>
                Decisions {dayLabel(meta.data.first_decision_day)} – {dayLabel(meta.data.last_decision_day)} 2026
              </p>
              <p className="muted">GB national wind, half-hourly</p>
            </div>
            <p className="source">
              <Database size={13} /> Elexon BMRS · FUELHH, WINDFOR
            </p>
          </div>
        )}
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-title">
            <nav className="crumbs" aria-label="Breadcrumb">
              <span>January 2026 pilot</span>
              <ChevronRight size={13} />
              <span aria-current="page">{page.label}</span>
            </nav>
            <h1>{page.title}</h1>
            <p>{page.subtitle}</p>
          </div>
          {meta.data && (
            <GateControl
              gates={meta.data.gates}
              value={url.gate ?? hhmm(meta.data.default_gate)}
              onChange={(gate) => setUrl({ gate })}
            />
          )}
        </header>

        <main className="content">
          {meta.isPending ? (
            <ViewSkeleton />
          ) : meta.isError ? (
            <ErrorBox error={meta.error} onRetry={() => void meta.refetch()} />
          ) : (
            <Dashboard meta={meta.data} view={url.view} day={url.day} gate={url.gate} onChange={setUrl} />
          )}
        </main>
      </div>
    </div>
  );
}

function Dashboard({
  meta,
  view,
  day,
  gate,
  onChange,
}: {
  meta: Meta;
  view: View;
  day?: string;
  gate?: string;
  onChange: (patch: { view?: View; day?: string; gate?: string }) => void;
}) {
  const selectedDay =
    day && day >= meta.first_decision_day && day <= meta.last_decision_day ? day : meta.last_decision_day;
  const selectedGate = gate ?? hhmm(meta.default_gate);

  return (
    // key re-mounts the view so it fades in on page switch
    <div key={view} className="fade">
      <ErrorBoundary>
        {view === "decision" ? (
          <DecisionView meta={meta} day={selectedDay} gate={selectedGate} onDayChange={(d) => onChange({ day: d })} />
        ) : view === "planner" ? (
          <PlannerView gate={selectedGate} />
        ) : (
          <AccuracyView
            meta={meta}
            gate={selectedGate}
            onOpenDay={(d) => {
              onChange({ view: "decision", day: d });
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
          />
        )}
      </ErrorBoundary>
    </div>
  );
}
