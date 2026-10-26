import { useEffect, useMemo, useRef, useState } from "react";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export function toIsoDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseIsoDate(value: string) {
  return new Date(`${value}T00:00:00`);
}

type Props = {
  value: string; // ISO date, e.g. "2026-09-20"
  onChange: (iso: string) => void;
  formatLabel?: (iso: string) => string;
};

/** The same calendar pill + popover used on the Main Dashboard, extracted so
 * every module that needs a date picker looks and behaves identically. */
export default function DateCalendarPicker({ value, onChange, formatLabel }: Props) {
  const todayIso = toIsoDate(new Date());
  const [pending, setPending] = useState(value);
  const [month, setMonth] = useState(parseIsoDate(value).getMonth());
  const [year, setYear] = useState(parseIsoDate(value).getFullYear());
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  const label = formatLabel
    ? formatLabel(value)
    : new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(parseIsoDate(value));
  const pendingLabel = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" }).format(parseIsoDate(pending));

  const years = useMemo(() => {
    const baseYear = new Date().getFullYear();
    return Array.from({ length: 9 }, (_, index) => baseYear - 4 + index);
  }, []);

  const days = useMemo(() => {
    const first = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const previousMonthDays = new Date(year, month, 0).getDate();
    const cells: { date: Date; inMonth: boolean }[] = [];
    for (let index = first.getDay() - 1; index >= 0; index -= 1) {
      cells.push({ date: new Date(year, month - 1, previousMonthDays - index), inMonth: false });
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
      cells.push({ date: new Date(year, month, day), inMonth: true });
    }
    while (cells.length % 7 !== 0) {
      const nextDay = cells.length - first.getDay() - daysInMonth + 1;
      cells.push({ date: new Date(year, month + 1, nextDay), inMonth: false });
    }
    return cells;
  }, [month, year]);

  useEffect(() => {
    const closeOverlay = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOverlay);
    return () => document.removeEventListener("mousedown", closeOverlay);
  }, []);

  const openCalendar = () => {
    const selected = parseIsoDate(value);
    setPending(value);
    setMonth(selected.getMonth());
    setYear(selected.getFullYear());
    setOpen((o) => !o);
  };

  const selectDay = (date: Date) => {
    setPending(toIsoDate(date));
    setMonth(date.getMonth());
    setYear(date.getFullYear());
  };

  const confirm = () => {
    onChange(pending);
    setOpen(false);
  };

  const goToToday = () => {
    const today = parseIsoDate(todayIso);
    setPending(todayIso);
    setMonth(today.getMonth());
    setYear(today.getFullYear());
    onChange(todayIso);
    setOpen(false);
  };

  return (
    <div className="hosp-dashboard-calendar-wrap" ref={ref}>
      <button
        type="button"
        className={`hosp-dashboard-pill hosp-dashboard-date-pill ${open ? "active" : ""}`}
        onClick={openCalendar}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <span className="hosp-dashboard-action-icon">🗓️</span>
        <span>{label}</span>
      </button>
      {open && (
        <div className="hosp-dashboard-calendar-popover" role="dialog" aria-label="Calendar" onMouseDown={(event) => event.stopPropagation()}>
          <div className="hosp-dashboard-calendar-selected">
            <strong>{pendingLabel}</strong>
            <span>✎</span>
          </div>
          <div className="hosp-dashboard-calendar-selects">
            <select value={month} onChange={(event) => setMonth(Number(event.target.value))} aria-label="Calendar month">
              {MONTH_NAMES.map((m, index) => (
                <option key={m} value={index}>{m}</option>
              ))}
            </select>
            <select value={year} onChange={(event) => setYear(Number(event.target.value))} aria-label="Calendar year">
              {years.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
          <div className="hosp-dashboard-calendar-grid">
            {WEEKDAYS.map((day) => <span key={day} className="calendar-weekday">{day}</span>)}
            {days.map(({ date, inMonth }) => {
              const iso = toIsoDate(date);
              const selected = iso === pending;
              return (
                <button
                  key={iso}
                  type="button"
                  className={`${inMonth ? "" : "muted"} ${selected ? "selected" : ""}`}
                  onClick={() => selectDay(date)}
                >
                  {String(date.getDate()).padStart(2, "0")}
                </button>
              );
            })}
          </div>
          <div className="hosp-dashboard-calendar-actions">
            <button type="button" onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" className="hosp-dashboard-calendar-today" onClick={goToToday}>Today</button>
            <button type="button" onClick={confirm}>Confirm</button>
          </div>
        </div>
      )}
    </div>
  );
}
