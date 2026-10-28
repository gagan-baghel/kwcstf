import { CalendarDays, ChevronLeft, ChevronRight, GalleryHorizontal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { addDays, dayLabel, weekday } from "../format";
import { COLORS } from "./ui";

/** Signed GW with one decimal; values that round to zero show as plain "0.0". */
const gw = (mw: number) => {
  const text = (Math.abs(mw) / 1000).toFixed(1);
  return text === "0.0" ? text : `${mw > 0 ? "+" : "−"}${text}`;
};

type Layout = "calendar" | "strip";
const LAYOUT_KEY = "winddesk.dayLayout";
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// A per-device preference: storage may be unavailable (private mode), so default quietly.
function readLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "strip" ? "strip" : "calendar";
  } catch {
    return "calendar";
  }
}

interface Props {
  days: string[];
  selected: string;
  biasByDay: ReadonlyMap<string, number>;
  onSelect: (day: string) => void;
}

/** Decision-day picker: day tiles tinted by how far each forecast missed, as a month calendar or a scrollable row. */
export function DayPicker(props: Props) {
  const [layout, setLayout] = useState<Layout>(readLayout);

  const chooseLayout = (next: Layout) => {
    setLayout(next);
    try {
      localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      // Not persisted; the choice still applies for this visit.
    }
  };

  return (
    <section className="day-picker card" aria-label="Decision days">
      <header className="day-picker-head">
        <h3>Decision days</h3>
        <div className="layout-toggle" role="group" aria-label="Day picker layout">
          <button type="button" aria-pressed={layout === "calendar"} onClick={() => chooseLayout("calendar")}>
            <CalendarDays size={14} /> Calendar
          </button>
          <button type="button" aria-pressed={layout === "strip"} onClick={() => chooseLayout("strip")}>
            <GalleryHorizontal size={14} /> List
          </button>
        </div>
      </header>
      <div className="day-picker-body">{layout === "calendar" ? <Calendar {...props} /> : <Strip {...props} />}</div>
    </section>
  );
}

function DayTile({
  day,
  selected,
  bias,
  maxBias,
  showWeekday,
  onSelect,
}: {
  day: string;
  selected: boolean;
  bias: number | undefined;
  maxBias: number;
  showWeekday: boolean;
  onSelect: (day: string) => void;
}) {
  const strength = bias == null ? 0 : 0.12 + 0.68 * (Math.abs(bias) / maxBias);
  const tint =
    bias == null ? undefined : bias > 0 ? `rgba(247, 144, 9, ${strength})` : `rgba(18, 183, 106, ${strength})`;
  return (
    <button
      type="button"
      className="day-cell"
      aria-current={selected ? "date" : undefined}
      aria-label={`${weekday(day)} ${Number(day.slice(8))} Jan${bias == null ? "" : `, bias ${gw(bias)} GW`}`}
      title={`Decide ${dayLabel(day)}, deliver ${dayLabel(addDays(day, 1))}`}
      style={{ background: tint }}
      onClick={() => onSelect(day)}
    >
      {showWeekday && <span className="day-cell-dow">{weekday(day)}</span>}
      <b>{Number(day.slice(8))}</b>
      <small>{bias == null ? "" : gw(bias)}</small>
    </button>
  );
}

const maxAbs = (biasByDay: ReadonlyMap<string, number>) => Math.max(1, ...[...biasByDay.values()].map(Math.abs));

function Legend() {
  return (
    <div className="day-cal-legend">
      <span>
        <i style={{ background: COLORS.shortfall }} /> Forecast too high (short)
      </span>
      <span>
        <i style={{ background: COLORS.surplus }} /> Too low
      </span>
      <span className="muted">Values: bias in GW · darker = bigger miss</span>
    </div>
  );
}

/** The month as a calendar, with a short summary beside it on wide screens. */
function Calendar({ days, selected, biasByDay, onSelect }: Props) {
  const first = days[0];
  const leadingBlanks = first ? (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7 : 0; // Monday-first weeks
  const maxBias = maxAbs(biasByDay);
  const entries = [...biasByDay.entries()];
  const shortDays = entries.filter(([, b]) => b > 0).length;
  const worst = entries.reduce<[string, number] | null>((w, e) => (!w || e[1] > w[1] ? e : w), null);

  return (
    <div className="day-cal-layout">
      <div className="day-cal-grid">
        {WEEKDAYS.map((d) => (
          <span key={d} className="day-cal-dow" aria-hidden>
            {d}
          </span>
        ))}
        {Array.from({ length: leadingBlanks }, (_, i) => (
          <span key={`blank-${i}`} aria-hidden />
        ))}
        {days.map((day) => (
          <DayTile
            key={day}
            day={day}
            selected={day === selected}
            bias={biasByDay.get(day)}
            maxBias={maxBias}
            showWeekday={false}
            onSelect={onSelect}
          />
        ))}
      </div>
      <aside className="month-summary">
        <dl>
          <div>
            <dt>Selected</dt>
            <dd>
              Decide {dayLabel(selected)} → deliver {dayLabel(addDays(selected, 1))}
            </dd>
          </div>
          <div>
            <dt>Forecast ran high</dt>
            <dd>{entries.length ? `${shortDays} of ${entries.length} days` : "–"}</dd>
          </div>
          <div>
            <dt>Biggest shortfall</dt>
            <dd>{worst ? `Decided ${dayLabel(worst[0])}, ${gw(worst[1])} GW` : "–"}</dd>
          </div>
        </dl>
        <Legend />
      </aside>
    </div>
  );
}

/** The same tiles in a horizontally scrollable row, with arrow buttons that page through it. */
function Strip({ days, selected, biasByDay, onSelect }: Props) {
  const row = useRef<HTMLDivElement>(null);
  const maxBias = maxAbs(biasByDay);
  const [edges, setEdges] = useState({ start: true, end: false });

  const updateEdges = useCallback(() => {
    const box = row.current;
    if (!box) return;
    setEdges({ start: box.scrollLeft <= 1, end: box.scrollLeft + box.clientWidth >= box.scrollWidth - 1 });
  }, []);

  // Keep the selected tile centred: jump when the row appears, glide between days.
  const shown = useRef(false);
  useEffect(() => {
    const box = row.current;
    const tile = box?.querySelector<HTMLElement>('[aria-current="date"]');
    if (box && tile) {
      box.scrollTo({
        left: tile.offsetLeft - box.clientWidth / 2 + tile.clientWidth / 2,
        behavior: shown.current ? "smooth" : "instant",
      });
    }
    shown.current = true;
    updateEdges();
  }, [selected, updateEdges]);

  const page = (direction: -1 | 1) =>
    row.current?.scrollBy({ left: direction * row.current.clientWidth * 0.8, behavior: "smooth" });

  return (
    <>
      <div className="day-strip">
        <button
          type="button"
          className="strip-arrow"
          onClick={() => page(-1)}
          disabled={edges.start}
          aria-label="Scroll to earlier days"
        >
          <ChevronLeft size={18} />
        </button>
        <div className="day-strip-scroll" ref={row} onScroll={updateEdges}>
          {days.map((day) => (
            <DayTile
              key={day}
              day={day}
              selected={day === selected}
              bias={biasByDay.get(day)}
              maxBias={maxBias}
              showWeekday
              onSelect={onSelect}
            />
          ))}
        </div>
        <button
          type="button"
          className="strip-arrow"
          onClick={() => page(1)}
          disabled={edges.end}
          aria-label="Scroll to later days"
        >
          <ChevronRight size={18} />
        </button>
      </div>
      <Legend />
    </>
  );
}
