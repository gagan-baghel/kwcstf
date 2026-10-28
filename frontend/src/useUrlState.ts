import { useCallback, useEffect, useState } from "react";

export type View = "decision" | "accuracy" | "planner";

export interface UrlState {
  view: View;
  day?: string;
  gate?: string;
}

const VIEWS: View[] = ["decision", "accuracy", "planner"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const GATE = /^([01]\d|2[0-3]):[0-5]\d$/;

function read(): UrlState {
  const q = new URLSearchParams(window.location.search);
  const day = q.get("day") ?? "";
  const gate = q.get("gate") ?? "";
  return {
    view: VIEWS.find((v) => v === q.get("view")) ?? "decision",
    day: DAY.test(day) ? day : undefined,
    gate: GATE.test(gate) ? gate : undefined,
  };
}

/** View state lives in the URL, so any view can be bookmarked or pasted to a colleague. */
export function useUrlState() {
  const [state, setState] = useState(read);

  useEffect(() => {
    const q = new URLSearchParams({ view: state.view });
    if (state.day) q.set("day", state.day);
    if (state.gate) q.set("gate", state.gate);
    window.history.replaceState(null, "", `?${q}`);
  }, [state]);

  const update = useCallback((patch: Partial<UrlState>) => setState((prev) => ({ ...prev, ...patch })), []);
  return [state, update] as const;
}
