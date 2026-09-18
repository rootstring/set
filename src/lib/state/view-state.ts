import type { PageId } from "$lib/types";
import { DEFAULT_CONTEXT } from "$lib/storage/paths";
import { readLocalJson, writeLocalJson } from "$lib/utils/local-store";

export interface Caret {
  anchor: number;
  head: number;
}

const STORAGE_KEY = "set:view-state";

const MAX_CARETS = 200;

interface ContextState {
  lastPageId: PageId | null;
  chrootId: PageId | null;
}

interface ViewStateFile {
  currentContext: string | null;
  contexts: Record<string, ContextState>;
  carets: Record<PageId, Caret>;
  lastPageId?: PageId | null;
  chrootId?: PageId | null;
}

function isCaret(value: unknown): value is Caret {
  const c = value as Caret | null;
  return (
    !!c &&
    typeof c === "object" &&
    Number.isFinite(c.anchor) &&
    Number.isFinite(c.head) &&
    c.anchor >= 0 &&
    c.head >= 0
  );
}

class ViewState {
  currentContext: string | null = null;

  private contexts = new Map<string, ContextState>();

  private carets = new Map<PageId, Caret>();

  private writeQueued = false;

  constructor() {
    this.load();
  }

  get lastPageId(): PageId | null {
    return this.stateFor(this.currentContext).lastPageId;
  }

  get chrootId(): PageId | null {
    return this.stateFor(this.currentContext).chrootId;
  }

  lastPageIn(context: string): PageId | null {
    return this.contexts.get(context)?.lastPageId ?? null;
  }

  setContext(name: string): void {
    if (this.currentContext === name) return;
    this.currentContext = name;
    this.stateFor(name); // materialize it, so the next write has somewhere to go
    this.schedule();
  }

  caretFor(id: PageId): Caret | null {
    return this.carets.get(id) ?? null;
  }

  setCaret(id: PageId, caret: Caret): void {
    this.carets.delete(id);
    this.carets.set(id, caret);
    while (this.carets.size > MAX_CARETS) {
      const oldest = this.carets.keys().next();
      if (oldest.done) break;
      this.carets.delete(oldest.value);
    }
    this.schedule();
  }

  setLastPage(id: PageId | null): void {
    const state = this.stateFor(this.currentContext);
    if (state.lastPageId === id) return;
    state.lastPageId = id;
    this.schedule();
  }

  setChroot(id: PageId | null): void {
    const state = this.stateFor(this.currentContext);
    if (state.chrootId === id) return;
    state.chrootId = id;
    this.schedule();
  }

  renameContext(from: string, to: string): void {
    const state = this.contexts.get(from);
    if (!state || from === to) return;
    this.contexts.delete(from);
    this.contexts.set(to, state);
    if (this.currentContext === from) this.currentContext = to;
    this.schedule();
  }

  private stateFor(name: string | null): ContextState {
    const key = name ?? DEFAULT_CONTEXT;
    let state = this.contexts.get(key);
    if (!state) {
      state = { lastPageId: null, chrootId: null };
      this.contexts.set(key, state);
    }
    return state;
  }

  flush(): void {
    this.writeQueued = false;
    this.persist();
  }

  private schedule(): void {
    if (this.writeQueued) return;
    this.writeQueued = true;
    queueMicrotask(() => {
      if (!this.writeQueued) return;
      this.writeQueued = false;
      this.persist();
    });
  }

  private persist(): void {
    writeLocalJson(STORAGE_KEY, {
      currentContext: this.currentContext,
      contexts: Object.fromEntries(this.contexts),
      carets: Object.fromEntries(this.carets),
    } satisfies ViewStateFile);
  }

  private load(): void {
    const parsed = readLocalJson(STORAGE_KEY) as Partial<ViewStateFile> | undefined;
    if (!parsed) return;

    if (typeof parsed.currentContext === "string") {
      this.currentContext = parsed.currentContext;
    }

    const contexts = parsed.contexts;
    if (contexts && typeof contexts === "object") {
      for (const [name, state] of Object.entries(contexts)) {
        this.contexts.set(name, {
          lastPageId: typeof state?.lastPageId === "string" ? state.lastPageId : null,
          chrootId: typeof state?.chrootId === "string" ? state.chrootId : null,
        });
      }
    }

    if (!contexts && (parsed.lastPageId || parsed.chrootId)) {
      // Pre-contexts shape: one page/chroot pair, which belongs to the default.
      this.contexts.set(DEFAULT_CONTEXT, {
        lastPageId: typeof parsed.lastPageId === "string" ? parsed.lastPageId : null,
        chrootId: typeof parsed.chrootId === "string" ? parsed.chrootId : null,
      });
      this.currentContext ??= DEFAULT_CONTEXT;
    }

    const carets = parsed.carets;
    if (carets && typeof carets === "object") {
      for (const [id, caret] of Object.entries(carets)) {
        if (isCaret(caret)) this.carets.set(id, caret);
      }
    }
  }
}

export const viewState = new ViewState();
