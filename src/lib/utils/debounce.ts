export interface Debounced<Args extends unknown[], R = void> {
  (...args: Args): void;
  /** Runs a pending call now and returns its result; `undefined` when nothing was pending. */
  flush(): R | undefined;
  cancel(): void;
}

export function debounce<Args extends unknown[], R>(
  fn: (...args: Args) => R,
  wait: number,
  options: { maxWait?: number } = {},
): Debounced<Args, R> {
  const { maxWait } = options;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Args | null = null;

  let burstStart = 0;

  const fire = () => {
    timer = null;
    const args = pending!;
    pending = null;
    fn(...args);
  };

  const debounced = (...args: Args) => {
    const now = Date.now();
    if (!timer) burstStart = now;
    pending = args;
    if (timer) clearTimeout(timer);

    const delay =
      maxWait == null ? wait : Math.max(0, Math.min(wait, burstStart + maxWait - now));
    timer = setTimeout(fire, delay);
  };

  debounced.flush = (): R | undefined => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending) return undefined;
    const args = pending;
    pending = null;
    return fn(...args);
  };

  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };

  return debounced;
}
