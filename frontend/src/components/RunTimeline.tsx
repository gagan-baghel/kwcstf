import type { CSSProperties } from "react";
import type { DayView } from "../api";
import { ukMinutes, ukTime } from "../format";

const DAY_MINUTES = 24 * 60;
const at = (minutes: number) => ({ "--x": `${(minutes / DAY_MINUTES) * 100}%` }) as CSSProperties;

/** D-1 as a 24-hour track: every forecast run, the gate, and which run the decision actually used. */
export function RunTimeline({ view }: { view: DayView }) {
  const gate = ukMinutes(view.gate);
  const used = view.forecast_runs.at(-1);
  return (
    <div className="timeline">
      <div className="timeline-track">
        <span className="timeline-known" style={at(gate)} />
        {view.decision_day_runs.map((run) => {
          const state = run === used ? "used" : run > view.gate ? "late" : "old";
          return (
            <span
              key={run}
              className={`run ${state}`}
              style={at(ukMinutes(run))}
              title={`Forecast run ${ukTime(run)} UK${state === "late" ? " (after the gate)" : ""}`}
            >
              <em>{ukTime(run)}</em>
            </span>
          );
        })}
        <span className="gate-marker" style={at(gate)}>
          <b>Gate {ukTime(view.gate)}</b>
        </span>
      </div>
      <div className="timeline-axis" aria-hidden>
        {["00:00", "06:00", "12:00", "18:00", "24:00"].map((t) => (
          <span key={t}>{t}</span>
        ))}
      </div>
      <div className="timeline-legend">
        <span>
          <i className="dot used" /> Used for the decision
        </span>
        <span>
          <i className="dot old" /> Earlier run
        </span>
        <span>
          <i className="dot late" /> After the gate
        </span>
      </div>
    </div>
  );
}
