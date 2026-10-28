import type { CSSProperties } from "react";
import type { Gate } from "../api";
import { hhmm } from "../format";

/** Decision cut-off on D-1: an exchange gate closure, or any custom time. */
export function GateControl({
  gates,
  value,
  onChange,
}: {
  gates: Gate[];
  value: string;
  onChange: (gate: string) => void;
}) {
  const index = gates.findIndex((g) => hhmm(g.closes_at) === value);
  return (
    <div className="gate-control" role="group" aria-label="Decision cut-off on D-1, UK time">
      <span className="gate-caption">Decide by (D-1, UK)</span>
      <div className="gate-inputs">
        <div className="segmented" style={{ "--n": gates.length, "--idx": Math.max(index, 0) } as CSSProperties}>
          <span className={`segmented-thumb ${index < 0 ? "is-hidden" : ""}`} aria-hidden />
          {gates.map((gate) => (
            <button
              key={gate.id}
              type="button"
              aria-pressed={hhmm(gate.closes_at) === value}
              title={`${gate.label} gate closure`}
              onClick={() => onChange(hhmm(gate.closes_at))}
            >
              {gate.id.toUpperCase()} <b>{hhmm(gate.closes_at)}</b>
            </button>
          ))}
        </div>
        <input
          className={`time-input ${index < 0 ? "is-active" : ""}`}
          type="time"
          step={60}
          value={value}
          aria-label="Custom decision time"
          title="Custom decision time"
          onChange={(e) => e.target.value && onChange(e.target.value)}
        />
      </div>
    </div>
  );
}
