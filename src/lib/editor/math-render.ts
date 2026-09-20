/**
 * KaTeX, fetched the first time a formula is about to be drawn and never on the way to first
 * paint. Every formula on a page asks to be drawn; only the ones on screen are, a few milliseconds
 * a frame, and a source that was drawn once is not drawn again.
 */

type Katex = typeof import("katex").default;

let katex: Katex | null = null;
let loading: Promise<Katex> | null = null;

function load(): Promise<Katex> {
  loading ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(
    ([module]) => {
      katex = module.default;
      return katex;
    },
  );
  return loading;
}

const OPTIONS = {
  throwOnError: false,
  errorColor: "var(--danger)",
  strict: "ignore" as const,
  trust: false,
  // The MathML twin doubles the DOM for a screen reader Set's editor doesn't yet serve.
  output: "html" as const,
};

/** Drawn HTML by source; a page switched back to costs nothing. */
const CACHE_LIMIT = 1000;
const cache = new Map<string, string>();

function cached(key: string): string | undefined {
  const hit = cache.get(key);
  if (hit === undefined) return undefined;
  // Most recently used goes last, so the front is what to drop.
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function remember(key: string, html: string): void {
  cache.set(key, html);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
}

interface Job {
  key: string;
  source: string;
  display: boolean;
}

/** Elements waiting to be drawn, and the ones among them that are on screen. */
const jobs = new Map<HTMLElement, Job>();
const visible = new Set<HTMLElement>();
let observer: IntersectionObserver | null = null;
let frame = 0;

/** Past this, the rest of the page's formulas wait for the next frame. */
const FRAME_BUDGET_MS = 6;

/** Also the formulas just off screen, so a scroll rarely catches one undrawn. */
const NEARBY = "50% 0px";

function watch(el: HTMLElement): void {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        if (entry.isIntersecting && jobs.has(target)) visible.add(target);
        else visible.delete(target);
      }
      if (visible.size) schedule();
    },
    { rootMargin: NEARBY },
  );
  observer.observe(el);
}

function schedule(): void {
  if (frame) return;
  if (!katex) {
    // Some visible element asked; whichever frame follows the download draws it.
    frame = -1;
    void load().then(() => {
      frame = 0;
      if (visible.size) schedule();
    });
    return;
  }
  frame = requestAnimationFrame(drain);
}

function drain(): void {
  frame = 0;
  const start = performance.now();
  for (const el of visible) {
    const job = jobs.get(el);
    if (job) paint(el, job);
    else visible.delete(el);
    if (performance.now() - start > FRAME_BUDGET_MS) break;
  }
  if (visible.size) schedule();
}

function paint(el: HTMLElement, job: Job): void {
  let html: string;
  try {
    html = katex!.renderToString(job.source, { ...OPTIONS, displayMode: job.display });
  } catch {
    html = "";
  }
  if (html) remember(job.key, html);
  show(el, html || job.source, !html);
  forget(el);
}

function show(el: HTMLElement, html: string, pending: boolean): void {
  if (pending) el.textContent = html;
  else el.innerHTML = html;
  el.classList.toggle("math-pending", pending);
}

function forget(el: HTMLElement): void {
  if (!jobs.delete(el)) return;
  visible.delete(el);
  observer?.unobserve(el);
}

/**
 * Draw `source` into `el`: at once when it was drawn before, otherwise when the element is on
 * screen and a frame has time. Until then the element shows the source.
 */
export function renderMath(el: HTMLElement, source: string, display: boolean): void {
  forget(el);
  const key = (display ? "D" : "I") + source;
  const hit = cached(key);
  if (hit !== undefined) {
    show(el, hit, false);
    return;
  }
  show(el, source, true);
  if (!source.trim() || typeof IntersectionObserver === "undefined") return;
  jobs.set(el, { key, source, display });
  watch(el);
}

export type MathCheck = { html: string } | { error: string };

/**
 * Draw `source` for a dialog, or say what is wrong with it. Strict where the page is forgiving:
 * a file may hold anything, but a formula being typed should hear about its unclosed brace.
 */
export async function checkMath(source: string, display: boolean): Promise<MathCheck> {
  const engine = katex ?? (await load());
  try {
    const html = engine.renderToString(source, {
      ...OPTIONS,
      displayMode: display,
      throwOnError: true,
    });
    const key = (display ? "D" : "I") + source;
    remember(key, html);
    return { html };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message.replace(/^KaTeX parse error:\s*/, "") };
  }
}

/** The element is going away; don't draw into it. */
export function cancelMath(el: HTMLElement): void {
  forget(el);
}
