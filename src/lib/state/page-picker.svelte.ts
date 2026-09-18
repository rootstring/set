import type { PageId } from "$lib/types";

export interface PickRequest {
  /** What the panel is for, above the field. */
  title: string;
  /** A rect as well as an element; null centres it. */
  anchor: HTMLElement | DOMRect | null;
  /** The page you are on, and anything inside the thing being moved. */
  exclude: Set<PageId>;
  /** "anywhere" also offers the way out on Tab, as ⌘K does. */
  scope: "context" | "anywhere";
  /** A wikilink names its page by title. */
  titledOnly: boolean;
  /** What the panel says when there is nothing to choose at all. */
  emptyTitle: string;
  answer: (id: PageId | null) => void;
}

/** The one panel lives in `AppLayout`; this is how a menu with no Svelte around it reaches it. */
class PagePicker {
  request = $state<PickRequest | null>(null);

  get open(): boolean {
    return this.request !== null;
  }

  choose(id: PageId): void {
    const request = this.request;
    this.request = null;
    request?.answer(id);
  }

  cancel(): void {
    const request = this.request;
    this.request = null;
    request?.answer(null);
  }
}

export const pagePicker = new PagePicker();

/** Resolves with the page picked, or null if the panel was dismissed. */
export function pickPage(opts: {
  title: string;
  anchor?: HTMLElement | DOMRect | null;
  exclude?: Iterable<PageId>;
  scope?: "context" | "anywhere";
  titledOnly?: boolean;
  emptyTitle?: string;
}): Promise<PageId | null> {
  // A second ask replaces the first rather than stacking: there is one panel.
  pagePicker.cancel();
  return new Promise((answer) => {
    pagePicker.request = {
      title: opts.title,
      anchor: opts.anchor ?? null,
      exclude: new Set(opts.exclude ?? []),
      scope: opts.scope ?? "context",
      titledOnly: opts.titledOnly ?? false,
      emptyTitle: opts.emptyTitle ?? "Nowhere to move this",
      answer,
    };
  });
}
