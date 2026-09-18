import { MONTHS, fromISO, startOfDay, timePart, toISO, withTime } from "./date-format";

export interface DatePickerOptions {
  value: string | null;
  onSelect: (iso: string) => void;
  onClear: () => void;
}

let openEl: HTMLElement | null = null;
let cleanup: (() => void) | null = null;

function closeDatePicker(): void {
  openEl?.remove();
  openEl = null;
  cleanup?.();
  cleanup = null;
}

function actionButton(className: string, text: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.textContent = text;
  return btn;
}

/** The next hour on the clock, which is what a time just added starts at. */
function nextHour(now: Date = new Date()): string {
  return `${String(Math.min(now.getHours() + 1, 23)).padStart(2, "0")}:00`;
}

export function showDatePicker(x: number, y: number, opts: DatePickerOptions): void {
  closeDatePicker();

  // The time field takes focus; give it back to whoever had it.
  const returnFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const el = document.createElement("div");
  el.className = "date-picker";

  // The picker stays open while a time is edited, so it follows along.
  let value = opts.value;
  const today = () => toISO(startOfDay(new Date()));
  const initial = (value && fromISO(value)) || new Date();
  let view = new Date(initial.getFullYear(), initial.getMonth(), 1);

  function done(): void {
    closeDatePicker();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }

  /** Write `iso` to the mention; `close` for a choice that finishes the pick. */
  function select(iso: string, close: boolean): void {
    value = iso;
    opts.onSelect(iso);
    if (close) done();
  }

  const header = document.createElement("div");
  header.className = "date-picker-header";
  const prev = actionButton("date-picker-nav", "‹");
  prev.setAttribute("aria-label", "Previous month");
  const label = document.createElement("span");
  label.className = "date-picker-label";
  const next = actionButton("date-picker-nav", "›");
  next.setAttribute("aria-label", "Next month");
  header.append(prev, label, next);

  const grid = document.createElement("div");
  grid.className = "date-picker-grid";

  // Under the calendar: the time, for a date that has one, and otherwise the
  // offer of one. Picking a day keeps whichever time is set.
  const timeRow = document.createElement("div");
  timeRow.className = "date-picker-time";

  const footer = document.createElement("div");
  footer.className = "date-picker-footer";
  const todayBtn = actionButton("date-picker-action", "Today");
  todayBtn.addEventListener("click", () => {
    select(withTime(today(), value && timePart(value)), true);
  });
  const clearBtn = actionButton("date-picker-action danger", "Remove date");
  clearBtn.addEventListener("click", () => {
    opts.onClear();
    done();
  });
  footer.append(todayBtn, clearBtn);

  function render() {
    label.textContent = `${MONTHS[view.getMonth()]} ${view.getFullYear()}`;
    grid.replaceChildren();
    for (const wd of ["S", "M", "T", "W", "T", "F", "S"]) {
      const cell = document.createElement("span");
      cell.className = "date-picker-weekday";
      cell.textContent = wd;
      grid.append(cell);
    }
    const firstDow = view.getDay();
    for (let i = 0; i < firstDow; i++) grid.append(document.createElement("span"));
    const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    const todayISO = today();
    const selectedDay = value?.slice(0, 10);
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = toISO(new Date(view.getFullYear(), view.getMonth(), d));
      const btn = actionButton("date-picker-day", String(d));
      if (iso === selectedDay) btn.classList.add("selected");
      if (iso === todayISO) btn.classList.add("today");
      btn.addEventListener("click", () => {
        select(withTime(iso, value && timePart(value)), true);
      });
      grid.append(btn);
    }
  }

  function renderTime() {
    timeRow.replaceChildren();
    const time = value && timePart(value);

    if (!time) {
      const add = actionButton("date-picker-action", "Add time");
      add.addEventListener("click", () => {
        select(withTime(value ?? today(), nextHour()), false);
        renderTime();
        timeRow.querySelector("input")?.focus();
      });
      timeRow.append(add);
      return;
    }

    const input = document.createElement("input");
    input.type = "time";
    input.className = "date-picker-time-input";
    input.setAttribute("aria-label", "Time");
    input.value = time;
    // Written on change, not redrawn: the field would be replaced under the typing.
    input.addEventListener("change", () => {
      if (input.value) select(withTime(value ?? today(), input.value), false);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      done();
    });

    const remove = actionButton("date-picker-action", "Remove time");
    remove.addEventListener("click", () => {
      if (value) select(withTime(value, null), false);
      renderTime();
    });
    timeRow.append(input, remove);
  }

  render();
  renderTime();

  prev.addEventListener("click", () => {
    view = new Date(view.getFullYear(), view.getMonth() - 1, 1);
    render();
  });
  next.addEventListener("click", () => {
    view = new Date(view.getFullYear(), view.getMonth() + 1, 1);
    render();
  });

  el.append(header, grid, timeRow, footer);
  document.body.append(el);

  const { offsetWidth: w, offsetHeight: h } = el;
  el.style.left = `${Math.min(x, window.innerWidth - w - 8)}px`;
  el.style.top = `${Math.min(y, window.innerHeight - h - 8)}px`;
  openEl = el;

  const onDocPointerDown = (event: PointerEvent) => {
    if (openEl && !openEl.contains(event.target as globalThis.Node)) closeDatePicker();
  };
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      done();
    }
  };
  document.addEventListener("pointerdown", onDocPointerDown, true);
  document.addEventListener("keydown", onKeydown, true);
  cleanup = () => {
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    document.removeEventListener("keydown", onKeydown, true);
  };
}
