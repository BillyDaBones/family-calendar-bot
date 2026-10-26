// All event times are stored as local wall-clock strings in the family's timezone:
// "YYYY-MM-DD" for all-day events, "YYYY-MM-DDTHH:MM" for timed ones.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function isValidStart(value: string, allDay: boolean): boolean {
  return allDay ? DATE.test(value) : DATE_TIME.test(value);
}

function parts(value: string) {
  const [y, m, d] = value.slice(0, 10).split("-").map(Number) as [number, number, number];
  const [hh, mm] = value.length > 10 ? (value.slice(11).split(":").map(Number) as [number, number]) : [0, 0];
  return { y, m, d, hh, mm };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function fromUtc(date: Date, withTime: boolean): string {
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  return withTime ? `${day}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}` : day;
}

export function addDays(value: string, days: number): string {
  const { y, m, d, hh, mm } = parts(value);
  return fromUtc(new Date(Date.UTC(y, m - 1, d + days, hh, mm)), value.length > 10);
}

export function addHours(value: string, hours: number): string {
  const { y, m, d, hh, mm } = parts(value);
  return fromUtc(new Date(Date.UTC(y, m - 1, d, hh + hours, mm)), true);
}

// Current wall-clock time in the given timezone, as "YYYY-MM-DDTHH:MM".
export function nowLocal(timezone: string, now = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export function formatDay(value: string): string {
  const { y, m, d } = parts(value);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday}, ${MONTHS[m - 1]} ${d}`;
}

export function formatTime(value: string): string {
  const { hh, mm } = parts(value);
  const suffix = hh < 12 ? "AM" : "PM";
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${pad(mm)} ${suffix}`;
}

// "Thu, Nov 26 · 2:00 PM" or "Thu, Nov 26" for all-day events.
export function formatWhen(start: string, allDay: boolean): string {
  return allDay ? formatDay(start) : `${formatDay(start)} · ${formatTime(start)}`;
}

// Long form for the prompt, e.g. "Mon, Oct 26, 2026 3:04 PM".
export function formatNow(value: string): string {
  return `${formatDay(value)}, ${value.slice(0, 4)} ${formatTime(value)}`;
}
