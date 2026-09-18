import type { IconName } from "$lib/shell/icons";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  message: string;
  /** `alert` is a problem; `plain` is something that just happened. */
  tone: "alert" | "plain";
  /** What the thing that happened was. Falls back to the tone's own mark. */
  icon?: IconName;
  /** Offered left to right, so the one being pressed for goes last. */
  actions?: ToastAction[];
}

const MAX_VISIBLE = 3;

/** One undo offer at a time. */
const UNDO_KEY = "undo";

/** And one report of something filed elsewhere, for the same reason. */
const DID_KEY = "did";

/** And one standing offer, which is the only toast that waits to be answered. */
const OFFER_KEY = "offer";

const FADE_MS = 8000;

class Toasts {
  items = $state<Toast[]>([]);

  private nextId = 1;

  private shown = new Map<string, number>();

  private timers = new Map<number, ReturnType<typeof setTimeout>>();

  error(message: string, key?: string): void {
    const slot = key ?? message;
    const existing = this.shown.get(slot);
    if (existing !== undefined) {
      const current = this.items.find((t) => t.id === existing);
      if (current && current.message !== message) {
        this.items = this.items.map((t) => (t.id === existing ? { ...t, message } : t));
      }
      return;
    }
    this.add({ message, tone: "alert" }, slot);
  }

  notice(message: string, key?: string): void {
    this.error(message, key);
  }

  /** A check rather than the warning mark. */
  done(message: string): void {
    if (this.shown.has(message)) return;
    const id = this.add({ message, tone: "plain", icon: "check" }, message);
    this.timers.set(
      id,
      setTimeout(() => this.dismiss(id), FADE_MS),
    );
  }

  /** Replaces any standing offer, so Undo always means the last thing you did. */
  undo(message: string, run: () => void): void {
    this.clear(UNDO_KEY);
    const id = this.add(
      { message, tone: "plain", actions: [{ label: "Undo", run }] },
      UNDO_KEY,
    );
    this.timers.set(
      id,
      setTimeout(() => this.dismiss(id), FADE_MS),
    );
  }

  /** Where `undo` offers the way back, this offers the way there. */
  did(message: string, icon: IconName, action?: ToastAction): void {
    this.clear(DID_KEY);
    const id = this.add(
      { message, tone: "plain", icon, actions: action ? [action] : undefined },
      DID_KEY,
    );
    this.timers.set(
      id,
      setTimeout(() => this.dismiss(id), FADE_MS),
    );
  }

  /** The only toast without a fade: it asks. */
  offer(message: string, icon: IconName, actions: ToastAction[]): void {
    this.clear(OFFER_KEY);
    this.add({ message, tone: "plain", icon, actions }, OFFER_KEY);
  }

  private add(toast: Omit<Toast, "id">, slot: string): number {
    const id = this.nextId++;
    this.items = [...this.items, { ...toast, id }];
    this.shown.set(slot, id);

    while (this.items.length > MAX_VISIBLE) this.dismiss(this.items[0].id);
    return id;
  }

  clear(key: string): void {
    const id = this.shown.get(key);
    if (id !== undefined) this.dismiss(id);
  }

  dismiss(id: number): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    for (const [message, value] of this.shown) {
      if (value === id) this.shown.delete(message);
    }
    this.items = this.items.filter((t) => t.id !== id);
  }

  /** Run one of a toast's actions and take the toast away with it. */
  act(id: number, index = 0): void {
    const toast = this.items.find((t) => t.id === id);
    this.dismiss(id);
    toast?.actions?.[index]?.run();
  }
}

export const toasts = new Toasts();
