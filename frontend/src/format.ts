// All times are shown on the UK clock, which is how the trading desk works.
const UK = "Europe/London";

const clock = new Intl.DateTimeFormat("en-GB", { timeZone: UK, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const longDay = new Intl.DateTimeFormat("en-GB", { timeZone: UK, weekday: "short", day: "numeric", month: "short" });
export const int = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const oneDp = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1, minimumFractionDigits: 1 });

export const ukTime = (iso: string) => clock.format(new Date(iso));

/** Minutes since UK midnight, for placing an instant on a 24-hour track. */
export const ukMinutes = (iso: string) => {
  const [h = 0, m = 0] = clock.format(new Date(iso)).split(":").map(Number);
  return h * 60 + m;
};

const weekdayFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short" });
export const weekday = (isoDate: string) => weekdayFmt.format(new Date(`${isoDate}T12:00:00Z`));

/** "2026-01-15" -> "Thu 15 Jan". Dates are parsed at UTC noon so they never shift a day. */
export const dayLabel = (isoDate: string) => longDay.format(new Date(`${isoDate}T12:00:00Z`));

export const mw = (value: number | null | undefined) => (value == null ? "–" : `${int.format(value)} MW`);

export const signedMw = (value: number | null | undefined) =>
  value == null ? "–" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${int.format(Math.abs(value))} MW`;

export const gwh = (mwh: number | null | undefined) => (mwh == null ? "–" : `${oneDp.format(mwh / 1000)} GWh`);

export const pct = (value: number | null | undefined) => (value == null ? "–" : `${oneDp.format(value)}%`);

const kilo = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 });

/** Compact axis ticks: 12000 -> "12k", -500 -> "−0.5k". */
export const kiloTick = (value: number) => (value === 0 ? "0" : `${kilo.format(value / 1000).replace("-", "−")}k`);

export const minutesBetween = (fromIso: string, toIso: string) =>
  Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60_000);

export const duration = (minutes: number) => {
  const h = Math.floor(Math.abs(minutes) / 60);
  const m = Math.abs(minutes) % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m} min`;
};

/** "2026-01-14" + n days, in plain calendar arithmetic. */
export const addDays = (isoDate: string, days: number) => {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** "09:20:00" -> "09:20" */
export const hhmm = (time: string) => time.slice(0, 5);

/** Every ISO date from `first` to `last`, inclusive. */
export const dateRange = (first: string, last: string) => {
  const days: string[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) days.push(d);
  return days;
};

/** Money, compact: 2_600_000 -> "£2.6m", 840_000 -> "£840k". */
export const gbp = (value: number | null | undefined) => {
  if (value == null) return "–";
  const sign = value < 0 ? "−" : "";
  const v = Math.abs(value);
  if (v >= 1e6) return `${sign}£${oneDp.format(v / 1e6)}m`;
  if (v >= 1e3) return `${sign}£${int.format(v / 1e3)}k`;
  return `${sign}£${int.format(v)}`;
};
