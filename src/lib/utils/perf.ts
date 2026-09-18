import { readLocal } from "./local-store";
export const BUDGETS = {
  "cold-start": 1000,
  keystroke: 32,
  "keystroke-input": 8,
  "keystroke-processing": 8,
  "keystroke-presentation": 16,
  "page-switch": 100,
  "sidebar-render": 16,
} as const;

export type PerfLabel = keyof typeof BUDGETS | (string & {});

function enabled(): boolean {
  const dev = typeof import.meta !== "undefined" && import.meta.env?.DEV;
  if (dev) return true;
  return readLocal("set:perf") === "1";
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

const starts = new Map<string, number>();

function budgetFor(label: string): number | undefined {
  return (BUDGETS as Record<string, number>)[label];
}

function ms(value: number): number {
  return Math.round(value * 10) / 10;
}

const samples = new Map<string, number[]>();

function record(label: string, value: number): void {
  const existing = samples.get(label);
  if (existing) existing.push(value);
  else samples.set(label, [value]);
}

function report(label: string, value: number): void {
  record(label, value);
  const budget = budgetFor(label);
  const rounded = ms(value);
  if (budget != null && value > budget) {
    console.warn(`⏱ ${label}: ${rounded}ms (budget ${budget}ms), over`);
  } else {
    const suffix = budget != null ? ` (budget ${budget}ms)` : "";
    console.info(`⏱ ${label}: ${rounded}ms${suffix}`);
  }
}

export interface Stats {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

function stats(label: PerfLabel): Stats | undefined {
  const values = samples.get(label);
  if (!values?.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: ms(percentile(sorted, 50)),
    p95: ms(percentile(sorted, 95)),
    max: ms(sorted[sorted.length - 1]),
  };
}

let paintChannel: MessageChannel | undefined;
const paintQueue: Array<() => void> = [];

function afterPaint(fn: () => void): void {
  if (
    typeof requestAnimationFrame === "undefined" ||
    typeof MessageChannel === "undefined"
  ) {
    return;
  }
  requestAnimationFrame(() => {
    if (!paintChannel) {
      paintChannel = new MessageChannel();

      paintChannel.port1.onmessage = () => paintQueue.shift()?.();
      paintChannel.port1.start();
    }
    paintQueue.push(fn);
    paintChannel.port2.postMessage(0);
  });
}

export interface KeystrokeSample {
  input: number;
  processing: number;
  presentation: number;
  total: number;
}

interface PendingKeystroke {
  event: number;
  received: number;
}

let pendingKey: PendingKeystroke | undefined;

const MAX_EVENT_AGE = 1000;

function reportKeystroke(sample: KeystrokeSample): void {
  record("keystroke", sample.total);
  record("keystroke-input", sample.input);
  record("keystroke-processing", sample.processing);
  record("keystroke-presentation", sample.presentation);

  const stage = (label: PerfLabel, value: number, name: string): string => {
    const budget = budgetFor(label);
    return `${name} ${ms(value)}${budget != null && value > budget ? "⚠" : ""}`;
  };
  const split =
    `${stage("keystroke-input", sample.input, "input")}, ` +
    `${stage("keystroke-processing", sample.processing, "processing")}, ` +
    `${stage("keystroke-presentation", sample.presentation, "paint")}`;

  const budget = BUDGETS.keystroke;
  const line = `⏱ keystroke: ${ms(sample.total)}ms (budget ${budget}ms): ${split}`;
  if (sample.total > budget) console.warn(`${line}, over`);
  else console.info(line);
}

function observeKeystrokes(element: HTMLElement): () => void {
  if (!enabled()) return () => {};

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Shift" || event.key === "Control") return;
    if (event.key === "Alt" || event.key === "Meta") return;

    const received = now();

    const stamp = event.timeStamp;
    const trustworthy =
      stamp > 0 && stamp <= received && received - stamp < MAX_EVENT_AGE;
    pendingKey = { event: trustworthy ? stamp : received, received };
  };

  element.addEventListener("keydown", onKeyDown, { capture: true });
  return () => element.removeEventListener("keydown", onKeyDown, { capture: true });
}

function keystrokeUpdated(): void {
  if (!enabled()) return;
  const key = pendingKey;
  if (!key) return;

  pendingKey = undefined;

  const processed = now();
  afterPaint(() => {
    const painted = now();
    reportKeystroke({
      input: key.received - key.event,
      processing: processed - key.received,
      presentation: painted - processed,
      total: painted - key.event,
    });
  });
}

export const perf = {
  start(label: PerfLabel): void {
    if (!enabled()) return;
    starts.set(label, now());
  },
  end(label: PerfLabel): void {
    if (!enabled()) return;
    const t0 = starts.get(label);
    if (t0 == null) return;
    starts.delete(label);
    report(label, now() - t0);
  },
  startPaint(label: PerfLabel): void {
    if (!enabled()) return;
    const t0 = now();
    if (typeof requestAnimationFrame === "undefined") return;
    requestAnimationFrame(() => report(label, now() - t0));
  },
  endPaint(label: PerfLabel): void {
    if (!enabled()) return;
    const t0 = starts.get(label);
    if (t0 == null) return;
    starts.delete(label);
    if (typeof requestAnimationFrame === "undefined") {
      report(label, now() - t0);
      return;
    }
    requestAnimationFrame(() => report(label, now() - t0));
  },
  measure<T>(label: PerfLabel, fn: () => T): T {
    if (!enabled()) return fn();
    const t0 = now();
    try {
      return fn();
    } finally {
      report(label, now() - t0);
    }
  },
  observeKeystrokes,
  keystrokeUpdated,
  stats,
};

if (enabled() && typeof window !== "undefined") {
  (window as unknown as { __setPerf: typeof perf }).__setPerf = perf;
}
