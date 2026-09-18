import type { AfterNavigate } from "@sveltejs/kit";

/**
 * `history.length` counts entries from before the app loaded and says nothing about which side you
 * are on, so both ends are counted here, in `landed`. Kept in `sessionStorage`, which has the same
 * lifetime as the window's history.
 */

const STORAGE_KEY = "set:nav-history";

/** Guarded like `utils/local-store`: absent during SSR, throws when blocked. */
function readSession(): [number, number] | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const [behind, ahead] = raw.split(",").map(Number);
    if (!Number.isInteger(behind) || !Number.isInteger(ahead)) return null;
    if (behind < 0 || ahead < 0) return null;
    return [behind, ahead];
  } catch {
    return null;
  }
}

class NavHistory {
  /** Entries behind the one being shown, and ahead of it. */
  private behind = $state(0);
  private ahead = $state(0);

  /** Whether the navigation now in flight replaces the entry it lands on. */
  private replacing = false;

  constructor() {
    const stored = readSession();
    if (stored) [this.behind, this.ahead] = stored;
  }

  get canGoBack(): boolean {
    return this.behind > 0;
  }

  get canGoForward(): boolean {
    return this.ahead > 0;
  }

  /** Said by `navigation.ts` before a replace, since the arriving navigation does not say. */
  willReplace(): void {
    this.replacing = true;
  }

  /** A mark that outlived its navigation would be read by the next one. */
  clearReplace(): void {
    this.replacing = false;
  }

  /** A navigation that finished, from the root layout's `afterNavigate`. */
  landed(nav: AfterNavigate): void {
    const replaced = this.replacing;
    this.replacing = false;

    if (nav.type === "enter") return; // the page the session opened on
    if (nav.type === "popstate") this.moved(nav.delta);
    else if (!replaced) this.push();
  }

  back(): void {
    if (this.canGoBack) history.back();
  }

  forward(): void {
    if (this.canGoForward) history.forward();
  }

  /** A new entry, which drops whatever was ahead of the current one. */
  private push(): void {
    this.behind += 1;
    this.ahead = 0;
    this.persist();
  }

  /** Clamped: a popstate can come from entries this count never saw. */
  private moved(delta: number): void {
    const steps = Math.max(-this.behind, Math.min(this.ahead, delta));
    this.behind += steps;
    this.ahead -= steps;
    this.persist();
  }

  private persist(): void {
    try {
      if (typeof sessionStorage === "undefined") return;
      sessionStorage.setItem(STORAGE_KEY, `${this.behind},${this.ahead}`);
    } catch {
      // dropped; the counts are a convenience, not the history itself
    }
  }
}

export const navHistory = new NavHistory();
