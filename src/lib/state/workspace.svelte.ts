import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  Context,
  Page,
  PageDoc,
  PageId,
  PageSummary,
  TrashEntry,
  TrashedPage,
  TrashRef,
} from "$lib/types";
import { getStore, resetStore, currentNotesRoot, type PageStore } from "$lib/storage";
import { ChangedOnDiskError, type ContentMatch } from "$lib/storage/store";
import { migrateNotes } from "$lib/storage/fs-store";
import { DEFAULT_CONTEXT } from "$lib/storage/paths";
import { ancestorIds, parentsById, subtreeIds, trailTo } from "$lib/page/tree";
import { trashInContext } from "$lib/page/trash";
import {
  applyImportBundle,
  type ExportBundle,
  type ImportResult,
} from "$lib/storage/bundle";
import { settings, formatShortcut } from "$lib/state/settings.svelte";
import { toasts } from "$lib/state/toasts.svelte";
import { askDelete } from "$lib/state/confirm.svelte";
import { pickPage } from "$lib/state/page-picker.svelte";
import { sync } from "$lib/state/sync.svelte";
import { viewState } from "$lib/state/view-state";
import { expand } from "$lib/state/sidebar-expanded";
import { canonicalizeUrl, goToContext, goToPage } from "$lib/state/navigation";
import {
  contextPath,
  contextSegment,
  matchContext,
  pagePath,
  splitPageRef,
} from "$lib/state/addresses";
import {
  appendPageLink,
  hasPageLink,
  remapPageLinks,
  stripPageLinks,
} from "$lib/editor/page-links";
import {
  assetRefsIn,
  pageLinkIdsIn,
  withAssetRefs,
  type BlockNode,
} from "$lib/editor/block-move";
import { imageKind } from "$lib/editor/image-files";
import { clearAssetUrls } from "$lib/editor/asset-urls";
import { getActiveEditor, getActiveEditorKey, docKey } from "$lib/editor/active-editor";
import { editorToMarkdown } from "$lib/storage/markdown";
import { titleOf } from "$lib/search/titles";
import { debounce } from "$lib/utils/debounce";
import { perf } from "$lib/utils/perf";
import { LOCK_TOAST, PAGE_LOCKED } from "$lib/page/lock";
import { lockNudges } from "$lib/state/lock-nudge.svelte";
import { seedWelcome } from "$lib/page/welcome";
import { feedbackUrl } from "$lib/shell/links";

const AUTOSAVE_MS = 1_500;
const AUTOSAVE_MAX_MS = 10_000;

const RENAME_SETTLE_MS = 3_000;

const CARET_SETTLE_MS = 500;

/** A title is a live search key, so backlinks wait for the typing to stop. */
const BACKLINK_SETTLE_MS = 400;

export interface ExternalConflict {
  id: PageId;
  title: string;
}

export type ConflictChoice = "keep-mine" | "take-theirs" | "keep-both";

interface HistoryEntry {
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

interface SubtreeSnapshot {
  rootId: PageId;
  rootParent: PageId | null;
  rootGroup: PageId[];
}

class Workspace {
  pages = $state<PageSummary[]>([]);

  contexts = $state<Context[]>([]);

  activeContext = $state<string>(viewState.currentContext ?? DEFAULT_CONTEXT);
  activePageId = $state<PageId | null>(null);
  activePage = $state<Page | null>(null);

  activeDocVersion = $state(0);

  chrootId = $state<PageId | null>(viewState.chrootId);

  contextPages = $derived(this.pages.filter((p) => p.context === this.activeContext));

  trash = $state<TrashEntry[]>([]);
  trashOpen = $state(false);

  /**
   * Ids resolved against the live list, so a renamed or trashed linking page follows without a
   * rescan.
   */
  private linkedFrom = $state<ReadonlySet<PageId>>(new Set());

  backlinks = $derived(
    this.pages
      .filter((p) => p.id !== this.activePageId && this.linkedFrom.has(p.id))
      .sort((a, b) => titleOf(a).localeCompare(titleOf(b))),
  );

  /** The open page's ancestors, outermost first, for the breadcrumb over its title. */
  breadcrumbs = $derived(
    this.activePageId ? trailTo(this.activePageId, this.pages, this.chrootId) : [],
  );

  quickSwitcherOpen = $state(false);

  pendingExternalChange = $state<ExternalConflict | null>(null);

  private store!: PageStore;

  private ready: Promise<void> | null = null;

  private backlinksOf: PageId | null = null;

  private editRevision = 0;
  private savedRevision = 0;

  private lastSave: Promise<void> = Promise.resolve();

  private get dirty(): boolean {
    return this.editRevision !== this.savedRevision;
  }

  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private applying = false;

  private persist = debounce(
    async () => {
      try {
        await this.saveActiveNow();
      } catch {
        toasts.error(checkFolder("Couldn't save this page."));
      }
    },
    AUTOSAVE_MS,
    { maxWait: AUTOSAVE_MAX_MS },
  );

  /** Written as you type: not every way out of the app is clean. */
  private rememberCaret = debounce(() => this.captureCaret(), CARET_SETTLE_MS);

  private settleName = debounce(async () => {
    const id = this.activePageId;
    if (!id) return;

    this.syncUrl();
    try {
      await this.store.syncFileName?.(id);
    } catch {
      toasts.error("Couldn't rename this page's file. Your note is still saved.");
    }
  }, RENAME_SETTLE_MS);

  private reloadBacklinks = debounce(() => void this.loadBacklinks(), BACKLINK_SETTLE_MS);

  init(): Promise<void> {
    this.ready ??= this.load();
    return this.ready;
  }

  private async load(): Promise<void> {
    perf.start("cold-start");
    this.store = await getStore();
    await this.refreshAll();

    // Browser build only; the desktop app has setup.
    if (!isTauri()) await this.welcome();

    const migrated = this.store.migrated ?? 0;
    if (migrated > 0) {
      toasts.notice(
        `Set keeps notes in contexts. ` +
          `${migrated === 1 ? "The note" : `The ${migrated} notes`} at the top of this folder ` +
          `${migrated === 1 ? "is" : "are"} now in "${DEFAULT_CONTEXT}".`,
      );
    }
  }

  /**
   * Once per person, not per empty profile: deleting them is an answer. Never beside notes someone
   * already has.
   */
  private async welcome(): Promise<void> {
    if (settings.welcomedAt !== null) return;
    // Marked before anything is written, so a half-failed run is not repeated.
    settings.completeWelcome();
    if (this.pages.length > 0 || this.trash.length > 0) return;

    try {
      const id = await seedWelcome(this.store, {
        context: this.activeContext,
        binding: (binding) => settings.shortcut(binding),
        formatShortcut,
        feedbackUrl: await feedbackUrl(),
      });
      // Otherwise the start page is the first one listed, and the sub-pages,
      // which carry an explicit order, list ahead of their parent.
      viewState.setLastPage(id);
      // Open in the sidebar too, so the sub-pages are there to be found.
      expand(id);
    } catch {
      // a first visit without the tour is still a working first visit
    }
    await this.refresh();
  }

  goTo(id: PageId, opts: { replace?: boolean; reload?: boolean } = {}): Promise<void> {
    return goToPage(this.pathFor(id), opts);
  }

  pathFor(id: PageId): string {
    return pagePath(id, this.titleOf(id), this.segmentFor(this.contextFor(id)));
  }

  pathForContext(name: string): string {
    return contextPath(this.segmentFor(name));
  }

  /** How `context` reads in an address, which depends on the other names. */
  private segmentFor(context: string): string {
    return contextSegment(
      context,
      this.contexts.map((c) => c.name),
    );
  }

  /** Replaces; never adds a step to history. */
  syncUrl(): void {
    const id = this.activePageId;
    if (!id) return;
    const segment = this.segmentFor(this.contextFor(id));
    canonicalizeUrl(pagePath(id, this.activePage?.title ?? "", segment));
  }

  /** Where a page lives now, whatever an address made earlier says. */
  private contextFor(id: PageId): string {
    return this.pageById(id)?.context ?? this.activePage?.context ?? this.activeContext;
  }

  private pageById(id: PageId | null): PageSummary | undefined {
    return id ? this.pages.find((p) => p.id === id) : undefined;
  }

  private titleOf(id: PageId): string {
    return this.pageById(id)?.title ?? "";
  }

  /** Both lists, after anything that could have changed either. */
  private async refreshAll(): Promise<void> {
    await this.refresh();
    await this.refreshTrash();
  }

  /** Both take the whole subtree, so a lock anywhere inside refuses too. */
  private lockRefuses(id: PageId): boolean {
    const blocker = this.lockBlockedBy.get(id);
    if (blocker === undefined) return false;
    const locked = this.pageById(id)?.locked;
    toasts.error(locked ? PAGE_LOCKED : `“${blocker}” inside is locked`, LOCK_TOAST);
    return true;
  }

  /** By title, ignoring case; the one in the current context when titles repeat. */
  pageIdByTitle(title: string): PageId | undefined {
    const wanted = title.trim().toLowerCase();
    if (!wanted) return undefined;
    const matches = this.pages.filter((p) => p.title.trim().toLowerCase() === wanted);
    return (matches.find((p) => p.context === this.activeContext) ?? matches[0])?.id;
  }

  /**
   * The title is the key a wikilink matches on. Typing waits for a pause; a change of page reads
   * straight away.
   */
  requestBacklinks(): void {
    const id = this.activePageId;
    if (id === this.backlinksOf) {
      this.reloadBacklinks();
      return;
    }

    // A new page: drop the last page's list rather than leave it up, stale,
    // under the wrong note while the scan runs.
    this.backlinksOf = id;
    this.linkedFrom = new Set();
    this.reloadBacklinks.cancel();
    void this.loadBacklinks();
  }

  private async loadBacklinks(): Promise<void> {
    const id = this.activePageId;
    const title = this.activePage?.title ?? "";

    // Only one page answers to a title at a time; if this is not it, the links do not land here.
    if (!id || !title.trim() || this.pageIdByTitle(title) !== id) {
      this.linkedFrom = new Set();
      return;
    }

    // A link just typed may still be in the autosave queue.
    await this.flush();

    let found: PageId[];
    try {
      found = await this.store.backlinks(title);
    } catch {
      return; // leave what's on screen; the next edit or visit tries again
    }
    if (this.activePageId !== id) return; // moved on while it was reading

    this.linkedFrom = new Set(found);
  }

  /** The context an address names; see `matchContext`. */
  resolveContext(segment: string): string | null {
    return matchContext(
      segment,
      this.contexts.map((c) => c.name),
    );
  }

  resolveId(segment: string): PageId | null {
    for (const candidate of splitPageRef(segment)) {
      if (this.pages.some((p) => p.id === candidate)) return candidate;
    }
    return null;
  }

  startPageId(): PageId | null {
    const last = viewState.lastPageId;
    if (last && this.contextPages.some((p) => p.id === last)) return last;

    return this.contextPages[0]?.id ?? null;
  }

  async refresh(): Promise<void> {
    const pages = await this.store.list();
    const active = this.activePage;
    if (active) {
      const row = pages.find((p) => p.id === active.id);
      if (row) row.title = active.title;
    }
    this.pages = pages;
    this.contexts = await this.store.listContexts();

    if (!this.contexts.some((c) => c.name === this.activeContext)) {
      this.setContext(this.contexts[0]?.name ?? DEFAULT_CONTEXT);
    }

    if (this.chrootId && !this.contextPages.some((p) => p.id === this.chrootId)) {
      this.chroot(null);
    }
  }

  async reloadFromDisk(): Promise<void> {
    // Awaited, or re-reading the folder mid-save hands the editor the version before it.
    await this.flush();
    await this.store.reload?.();
    await this.refreshAll();

    const id = this.activePageId;
    if (!id) return;
    // The editor holds something newer than the file; its next save folds the two.
    if (this.pendingExternalChange?.id === id) return;
    if (this.dirty) {
      this.persist();
      this.persist.flush();
      return;
    }
    if (!this.pages.some((p) => p.id === id)) {
      // Deleted or trashed elsewhere, with nothing unsaved here to keep it for.
      await this.reopenAfterRemoval(null);
      return;
    }

    const revision = this.editRevision;
    const page = await this.store.get(id);
    if (!page || this.activePageId !== id) return;
    if (this.editRevision !== revision) {
      this.persist();
      this.persist.flush();
      return;
    }
    this.show(page);
    this.savedRevision = this.editRevision;
  }

  async reconcileExternalChange(): Promise<void> {
    if (this.pendingExternalChange) return;
    // Unsaved edits are folded into what is on disk, not written over it.
    await this.reloadFromDisk();
  }

  async resolveExternalChange(choice: ConflictChoice): Promise<void> {
    const conflict = this.pendingExternalChange;
    if (!conflict) return;

    this.pendingExternalChange = null;

    try {
      if (choice === "keep-both" && this.activePage?.id === conflict.id) {
        this.syncActiveDoc();
        await this.forkEdits(this.activePage, this.activeBody() ?? undefined);
      }
      if (choice === "keep-mine") {
        await this.store.overwriteNext?.(conflict.id);
        await this.saveActiveNow();
      } else {
        // What's on screen is kept as a copy, or given up: the file wins.
        this.savedRevision = this.editRevision;
      }
    } catch {
      toasts.error(checkFolder(`Couldn't resolve the changes to "${conflict.title}".`));
      return;
    }

    await this.reloadFromDisk();
  }

  /**
   * A refused save: the file is no longer the version the edits came from. The edits are folded
   * into what is there; only same-line rewrites ask.
   */
  private async foldChangeOnDisk(page: Page, body: string | undefined): Promise<void> {
    const store = this.store;
    if (!store.rebase || !store.adopt) throw new ChangedOnDiskError(page.id);

    // Typing while it folds starts it again; only the disk changing again gives up.
    for (let attempt = 0, typed = 0; attempt < 4 && typed < 50; attempt++) {
      if (this.activePage?.id === page.id) {
        // Everything in the editor, including what was typed since the save.
        this.syncActiveDoc();
        body = this.activeBody() ?? undefined;
        page = this.activePage;
      }
      const revision = this.editRevision;
      const outcome = await store.rebase(page, body);
      const onScreen = this.activePage?.id === page.id;
      // Typed into while folding: fold again, with that too.
      if (onScreen && this.editRevision !== revision) {
        typed++;
        attempt--;
        continue;
      }

      if (outcome.kind === "merged") {
        store.adopt(page.id, outcome.theirs);
        if (onScreen) this.show(outcome.page);
        try {
          await store.save(outcome.page, outcome.body);
        } catch (err) {
          if (!(err instanceof ChangedOnDiskError)) throw err;
          [page, body] = [outcome.page, outcome.body];
          continue; // changed again already: fold into that
        }
        if (onScreen && this.editRevision === revision) this.savedRevision = revision;
        await this.refresh();
        return;
      }

      if (outcome.kind === "conflict") {
        if (onScreen) {
          this.persist.cancel();
          this.settleName.cancel();
          this.pendingExternalChange = { id: page.id, title: page.title };
        } else {
          await this.forkEdits(page, body);
        }
        return;
      }

      // A page someone is still writing in is not one they have finished with.
      const name = named(page);
      if (outcome.trashed) {
        await store.restore(page.id);
        await this.refreshAll();
        toasts.notice(
          `“${name}” was moved to the trash elsewhere while you were editing it. It's back, with your changes.`,
        );
        continue; // live again: fold into it
      }
      await store.recreate?.(page, body);
      await this.refreshAll();
      toasts.notice(
        `“${name}” was deleted elsewhere while you were editing it. It's been kept, with your changes.`,
      );
      if (onScreen && this.editRevision === revision) this.savedRevision = revision;
      return;
    }

    // It kept changing under every attempt. Nothing is lost: it's on screen.
    if (this.activePage?.id === page.id) {
      this.persist.cancel();
      this.pendingExternalChange = { id: page.id, title: page.title };
    } else {
      await this.forkEdits(page, body);
    }
  }

  /** Edits that couldn't be folded into what is on disk, kept as a page of their own beside it. */
  private async forkEdits(page: Page, body: string | undefined): Promise<void> {
    const name = named(page);
    const copy = await this.store.create({
      title: `${name} (conflict from this device)`,
      parentId: page.parentId,
      context: page.context,
    });
    copy.doc = page.doc;
    await this.store.save(copy, body);
    await this.refresh();
    toasts.error(`“${name}” changed on disk. Your version was saved as “${copy.title}”`);
  }

  /** Put `page` on screen in place of the version there. */
  private show(page: Page): void {
    this.syncActiveDoc();
    const onScreen = this.activePage?.doc;
    this.captureCaret();
    this.activePage = page;
    const row = this.pageById(page.id);
    if (row) row.title = page.title;
    if (!sameDoc(onScreen, page.doc)) this.activeDocVersion++;
  }

  private saveActiveNow(): Promise<void> {
    const done = this.writeActive();
    // So `flush()` can wait on a save the autosave timer started.
    this.lastSave = done.catch(() => {});
    return done;
  }

  private async writeActive(): Promise<void> {
    const page = this.activePage;
    if (!page) return;
    const body = this.activeBody();
    if (body == null) this.syncActiveDoc();
    const writing = this.editRevision;
    try {
      await this.store.save(page, body ?? undefined);
    } catch (err) {
      if (!(err instanceof ChangedOnDiskError)) throw err;
      await this.foldChangeOnDisk(page, body ?? undefined);
      return;
    }
    this.savedRevision = writing;
  }

  async switchContext(name: string): Promise<void> {
    if (name === this.activeContext) return;
    if (!this.contexts.some((c) => c.name === name)) return;

    this.flush();
    this.setContext(name);
    const target = this.startPageId();
    if (target) {
      await this.goTo(target);
      return;
    }
    await this.showNothing();
  }

  private setContext(name: string): void {
    this.activeContext = name;
    viewState.setContext(name);

    this.chrootId = viewState.chrootId;
    this.contextSwitchedAt = Date.now();
  }

  contextSwitchedAt = $state(0);

  async createContext(name: string): Promise<string | null> {
    let created: string;
    try {
      created = await this.store.createContext(name);
    } catch {
      toasts.error(checkFolder(`Couldn't create the context “${name}”.`));
      return null;
    }
    await this.refresh();
    await this.switchContext(created);
    return created;
  }

  async renameContext(from: string, to: string): Promise<void> {
    if (from === to) return;
    let renamed: string;
    try {
      renamed = await this.store.renameContext(from, to);
    } catch {
      toasts.error(checkFolder(`Couldn't rename “${from}”.`));
      return;
    }

    viewState.renameContext(from, renamed);
    const here = this.activeContext === from;
    if (here) this.setContext(renamed);
    await this.refresh();

    // Still in the same place, under its new name.
    if (!here) return;
    if (this.activePageId) this.syncUrl();
    else canonicalizeUrl(this.pathForContext(renamed));
  }

  async deleteContext(name: string, opts: { undoable?: boolean } = {}): Promise<void> {
    const held = this.pages.filter((p) => p.context === name);
    // A pending save lands before the page goes to the trash, not after.
    await this.flush();

    for (const page of held) {
      const blocker = this.lockBlockedBy.get(page.id);
      if (blocker === undefined) continue;
      toasts.error(`“${name}” has a locked page inside: “${blocker}”`, LOCK_TOAST);
      return;
    }

    this.syncActiveDoc();
    const ids = new Set(held.map((p) => p.id));

    const previous = this.activePageId;
    try {
      await this.store.deleteContext(name);
    } catch {
      toasts.error(checkFolder(`Couldn't move “${name}” to Trash.`));
      return;
    }
    const prunedDocs = await this.pruneLinksTo(ids);
    await this.refreshAll();

    await this.reopenAfterRemoval(previous);

    const moveOff = async () => {
      if (this.activeContext === name || !this.contexts.some((c) => c.name === name)) {
        const next = this.contexts.find((c) => c.name !== name);
        if (next) await this.switchContext(next.name);
      }
    };
    await moveOff();

    this.record({
      undo: async () => {
        await this.restoreContextEntry(name);
        await this.restoreDocs(prunedDocs);
        await this.refreshAll();

        if (previous && this.pages.some((p) => p.id === previous)) {
          await this.goTo(previous);
        }
      },
      redo: async () => {
        const again = new Set(
          this.pages.filter((p) => p.context === name).map((p) => p.id),
        );
        await this.store.deleteContext(name);
        await this.pruneLinksTo(again);
        await this.refreshAll();
        await this.reopenAfterRemoval(this.activePageId);
        await moveOff();
      },
    });

    if (opts.undoable) toasts.undo(`“${name}” moved to Trash`, () => void this.undo());
  }

  async moveToContext(id: PageId, context: string): Promise<void> {
    const page = this.pageById(id);
    if (!page || page.context === context) return;

    if (this.lockRefuses(id)) return;

    this.flush();
    try {
      await this.store.moveToContext(id, context);
    } catch {
      toasts.error(checkFolder(`Couldn't move “${named(page)}” to “${context}”.`));
      return;
    }
    await this.refresh();
    // A page that just left this context cannot stay open in it.
    await this.reopenAfterRemoval(null);
  }

  chroot(id: PageId | null): void {
    if (id !== null && !this.contextPages.some((p) => p.id === id)) return;
    this.chrootId = id;
    viewState.setChroot(id);
  }

  async goToSibling(delta: 1 | -1): Promise<void> {
    const id = this.activePageId;
    if (!id || id === this.chrootId) return;
    const page = this.pageById(id);
    if (!page) return;
    const siblings = this.pages.filter((p) => p.parentId === page.parentId);
    const next = siblings[siblings.findIndex((p) => p.id === id) + delta];
    if (next) await this.goTo(next.id);
  }

  async open(id: PageId): Promise<boolean> {
    if (this.activePageId === id && this.activePage) return true;
    perf.start("page-switch");

    this.flush();
    const page = await this.store.get(id);
    if (!page) return false;

    if (page.context !== this.activeContext) this.setContext(page.context);
    this.activePageId = id;
    this.activePage = page;

    this.savedRevision = this.editRevision;
    this.pendingExternalChange = null;
    viewState.setLastPage(id);
    perf.endPaint("page-switch");

    perf.endPaint("cold-start");
    return true;
  }

  async createPage(parentId: PageId | null = null): Promise<void> {
    const parent = parentId ?? this.chrootId;
    // A subpage links itself into its parent's doc, which a locked parent will not accept.
    const lockedParent = this.pageById(parent);
    if (lockedParent?.locked) {
      toasts.error(PAGE_LOCKED, LOCK_TOAST);
      return;
    }
    try {
      const page = await this.createBlankPage(parent);
      if (parent) await this.appendChildLink(parent, page);
      await this.goTo(page.id);
    } catch {
      toasts.error(checkFolder("Couldn't create the page."));
    }
  }

  private async appendChildLink(parentId: PageId, child: Page): Promise<void> {
    await this.editDoc(parentId, (doc) => appendPageLink(doc, child.id, child.title));
  }

  private async editDoc(
    id: PageId,
    change: (doc: PageDoc) => PageDoc | null,
  ): Promise<PageDoc | null> {
    const isActive = this.activePageId === id && this.activePage != null;

    if (isActive) this.syncActiveDoc();
    const page = isActive ? this.activePage! : await this.store.get(id);
    if (!page) return null;
    const before = $state.snapshot(page.doc) as PageDoc;
    const next = change(before);
    if (!next) return null;
    page.doc = next;
    await this.store.save(page);
    if (isActive) this.activeDocVersion++;
    return before;
  }

  private async createBlankPage(parentId: PageId | null): Promise<Page> {
    const page = await this.store.create({ parentId, context: this.activeContext });
    await this.refresh();
    return page;
  }

  async createChild(parentId: PageId | null): Promise<PageSummary> {
    let page: Page;
    try {
      page = await this.store.create({ parentId, context: this.activeContext });
    } catch (err) {
      toasts.error(checkFolder("Couldn't create the subpage."));
      throw err;
    }
    await this.refresh();
    return {
      id: page.id,
      title: page.title,
      parentId: page.parentId,
      context: page.context,
      createdAt: page.createdAt,
    };
  }

  async duplicatePage(id: PageId): Promise<void> {
    const source = this.pageById(id);
    if (!source) return;

    this.flush();
    try {
      const copy = await this.copySubtree(id, source.parentId, `${named(source)} copy`);
      await this.refresh();
      if (source.parentId) {
        await this.editDoc(source.parentId, (doc) =>
          hasPageLink(doc, copy.id) ? null : appendPageLink(doc, copy.id, copy.title),
        );
      }
    } catch {
      toasts.error(checkFolder("Couldn't duplicate the page."));
    }
  }

  private async copySubtree(
    srcId: PageId,
    parentId: PageId | null,
    title?: string,
  ): Promise<Page> {
    // From the screen, typing and all; from disk it would move the save check past anything a sync
    // wrote.
    if (srcId === this.activePageId) this.syncActiveDoc();
    const src =
      srcId === this.activePageId && this.activePage
        ? this.activePage
        : await this.store.get(srcId);
    if (!src) throw new Error(`page ${srcId} not found`);
    const copy = await this.store.create({ title: title ?? src.title, parentId });
    const remap = new Map<PageId, PageId>();
    for (const child of this.pages.filter((p) => p.parentId === srcId)) {
      remap.set(child.id, (await this.copySubtree(child.id, copy.id)).id);
    }

    copy.doc = remapPageLinks(JSON.parse(JSON.stringify(src.doc)) as PageDoc, remap);
    await this.store.save(copy);
    return copy;
  }

  async putAsset(file: File): Promise<string | null> {
    const id = this.activePageId;
    if (!id) return null;
    const kind = imageKind(file);
    if (!kind) return null;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return await this.store.putAsset(id, bytes, kind);
    } catch {
      toasts.error(checkFolder("Couldn't save that image."));
      return null;
    }
  }

  async assetUrl(ref: string): Promise<string | null> {
    const id = this.activePageId;
    if (!id) return null;
    try {
      return await this.store.assetUrl(id, ref);
    } catch {
      return null;
    }
  }

  notesFolder(): Promise<string> {
    return currentNotesRoot();
  }

  async openNotesFolder(): Promise<void> {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(await currentNotesRoot());
  }

  async changeNotesFolder(newRoot: string, opts: { move: boolean }): Promise<void> {
    const oldRoot = await currentNotesRoot();
    if (newRoot === oldRoot) return;

    this.flush();
    await invoke("grant_notes_dir", { path: newRoot });
    let moved = opts.move;
    if (opts.move) {
      try {
        await migrateNotes(oldRoot, newRoot);
      } catch {
        moved = false;
        toasts.error(
          "Some notes couldn't be moved to the new folder. They're still in the old one.",
        );
      }
    }
    settings.setNotesFolder(newRoot);

    resetStore();
    clearAssetUrls();
    this.store = await getStore();
    this.undoStack = [];
    this.redoStack = [];

    this.chroot(null);
    await this.refreshAll();

    const first = this.pages[0];
    if (first) {
      this.activePageId = null;
      this.activePage = null;
      await this.goTo(first.id, { replace: true, reload: true });
    } else {
      await this.showNothing({ replace: true });
    }

    await sync.useNotesFolder(newRoot, moved);
    await this.pointAgentsAt(newRoot);
  }

  /** `set-mcp` serves whichever folder the grant names, even with the app closed. */
  async pointAgentsAt(dir: string): Promise<void> {
    try {
      await invoke("mcp_follow_notes_dir", { notesDir: dir });
    } catch {
      // agents keep the folder they had; Settings → Agent access re-saves it
    }
  }

  async importBundle(bundle: ExportBundle): Promise<ImportResult> {
    const result = await applyImportBundle(this.store, bundle);
    if (result.imported > 0) await this.reloadFromDisk();
    return result;
  }

  /** The open page's lock by default; the sidebar's lock icon names its row. */
  async toggleLock(id: PageId | null = this.activePageId): Promise<void> {
    if (!id) return;
    const isActive = id === this.activePageId && this.activePage != null;

    // Only the open page has edits its file hasn't caught up with yet.
    if (isActive) this.syncActiveDoc();
    const page = isActive ? this.activePage! : await this.store.get(id);
    if (!page) return;
    const body = isActive ? (this.activeBody() ?? undefined) : undefined;
    const wasLocked = page.locked;
    const summary = this.pageById(page.id);

    page.locked = wasLocked ? undefined : true;
    if (summary) summary.locked = page.locked;
    try {
      await this.store.save(page, body);
      // Opened while the read was out: its next save would put the old lock back.
      if (!isActive && this.activePage?.id === id) this.activePage.locked = page.locked;

      toasts.clear(LOCK_TOAST);
    } catch {
      page.locked = wasLocked;
      if (summary) summary.locked = wasLocked;
      toasts.error("Couldn't change this page's lock.");
    }
  }

  /**
   * Page id → the name of a locked page in its subtree. A lock stops any ancestor being trashed or
   * filed too.
   */
  lockBlockedBy = $derived.by(() => {
    const parents = parentsById(this.pages);
    const blocked = new Map<PageId, string>();
    for (const page of this.pages) {
      if (!page.locked) continue;
      for (const id of [page.id, ...ancestorIds(page.id, parents)]) {
        if (blocked.has(id)) break;
        blocked.set(id, named(page));
      }
    }
    return blocked;
  });

  requestDelete(id: PageId, anchor: HTMLElement | null = null): void {
    if (!this.pageById(id) || this.lockRefuses(id)) return;

    askDelete({
      anchor,
      title: "Move to Trash",
      message: "Move to Trash? You can restore it later.",
      confirmLabel: "Move to Trash",
      onConfirm: (asked) => void this.deletePage(id, { undoable: !asked }),
    });
  }

  /** `undoable`: the toast is the only thing that mentions a delete that did not ask. */
  async deletePage(id: PageId, opts: { undoable?: boolean } = {}): Promise<void> {
    // As for a context: the last edit goes to the trash with the page.
    await this.flush();
    this.syncActiveDoc();
    const previous = this.activePageId;

    const rootBefore = this.chrootId;

    const snapshot = this.captureSubtree(id);
    const page = this.pageById(id);
    const name = page ? named(page) : "Untitled";

    const ids = subtreeIds(this.pages, id);
    try {
      await this.store.remove(id);
    } catch {
      toasts.error("Couldn't move this page to the trash.");
      return;
    }

    const prunedDocs = await this.pruneLinksTo(ids);
    await this.refreshAll();

    await this.reopenAfterRemoval(previous);

    this.record({
      undo: async () => {
        await this.restoreSubtree(snapshot);
        await this.restoreDocs(prunedDocs);
        await this.refreshAll();
        if (rootBefore) this.chroot(rootBefore);
        // the restore can hand the page back under a new id (see `restoreSubtree`)
        const reopen = previous === id ? snapshot.rootId : previous;
        if (reopen && this.pages.some((p) => p.id === reopen)) {
          await this.goTo(reopen);
        }
      },
      redo: async () => {
        const again = subtreeIds(this.pages, snapshot.rootId);
        await this.store.remove(snapshot.rootId);
        await this.pruneLinksTo(again);
        await this.refreshAll();
        await this.reopenAfterRemoval(this.activePageId);
      },
    });

    if (opts.undoable) {
      toasts.undo(`“${name}” moved to Trash`, () => void this.undo());
    }
  }

  async undo(): Promise<void> {
    const entry = this.undoStack.pop();
    if (!entry) return;
    await this.replay(entry.undo);
    this.redoStack.push(entry);
  }

  async redo(): Promise<void> {
    const entry = this.redoStack.pop();
    if (!entry) return;
    await this.replay(entry.redo);
    this.undoStack.push(entry);
  }

  hasUndo(): boolean {
    return this.undoStack.length > 0;
  }

  hasRedo(): boolean {
    return this.redoStack.length > 0;
  }

  private record(entry: HistoryEntry): void {
    if (this.applying) return;
    this.undoStack.push(entry);
    this.redoStack = [];
  }

  private async replay(fn: () => Promise<void>): Promise<void> {
    // What was typed goes with the page rather than arriving to find it gone.
    await this.flush();
    this.applying = true;
    try {
      await fn();
    } finally {
      this.applying = false;
    }
  }

  private captureSubtree(id: PageId): SubtreeSnapshot {
    const rootParent = this.pageById(id)?.parentId ?? null;
    return {
      rootId: id,
      rootParent,
      rootGroup: this.pages.filter((p) => p.parentId === rootParent).map((p) => p.id),
    };
  }

  private async restoreSubtree(s: SubtreeSnapshot): Promise<void> {
    // A synced copy may have taken the id meanwhile; a redo has to find the new one.
    const back = await this.store.restore(s.rootId);
    if (back !== s.rootId) {
      s.rootGroup = s.rootGroup.map((x) => (x === s.rootId ? back : x));
      s.rootId = back;
    }
    await this.refresh();

    const group = s.rootGroup.filter(
      (x) => x === s.rootId || this.pages.some((p) => p.id === x),
    );
    if (!group.includes(s.rootId)) group.push(s.rootId);
    await this.store.move(s.rootId, s.rootParent, group);
  }

  private async restoreDocs(docs: { id: PageId; doc: PageDoc }[]): Promise<void> {
    for (const { id, doc } of docs) {
      const page =
        this.activePageId === id && this.activePage
          ? this.activePage
          : await this.store.get(id);
      if (!page) continue;
      page.doc = doc;
      await this.store.save(page);
      if (this.activePageId === id && this.activePage) {
        this.activePage.doc = doc;
        this.activeDocVersion++;
      }
    }
  }

  private async pruneLinksTo(ids: Set<PageId>): Promise<{ id: PageId; doc: PageDoc }[]> {
    const changed: { id: PageId; doc: PageDoc }[] = [];
    if (ids.size === 0) return changed;
    for (const summary of await this.store.list()) {
      if (ids.has(summary.id)) continue;
      const before = await this.editDoc(summary.id, (doc) => stripPageLinks(doc, ids));
      if (before) changed.push({ id: summary.id, doc: before });
    }
    return changed;
  }

  async openTrash(): Promise<void> {
    await this.refreshTrash();
    this.trashOpen = true;
  }

  closeTrash(): void {
    this.trashOpen = false;
  }

  async refreshTrash(): Promise<void> {
    this.trash = await this.store.listTrash();
  }

  async trashChildren(entry: TrashRef): Promise<TrashedPage[]> {
    try {
      return await this.store.listTrashIn(entry);
    } catch {
      return [];
    }
  }

  async restorePage(trashedId: PageId, reveal = true): Promise<void> {
    let id: PageId;
    try {
      id = await this.store.restore(trashedId);
    } catch {
      toasts.error("Couldn't restore this page.");
      return;
    }
    await this.refreshAll();

    if (!this.pages.some((p) => p.id === id)) {
      toasts.error("That page is no longer in the trash.");
      return;
    }
    if (!reveal) return;

    // Opening follows the page into its own context, which is what makes restoring out of another
    // context's trash land somewhere.
    await this.goTo(id);
    this.trashOpen = false;
  }

  async restoreContext(name: string): Promise<void> {
    if (!(await this.restoreContextEntry(name))) return;
    await this.refreshTrash();
    if (this.contexts.some((c) => c.name === name)) {
      await this.switchContext(name);
      this.trashOpen = false;
    }
  }

  private async restoreContextEntry(name: string): Promise<boolean> {
    try {
      await this.store.restoreContext(name);
    } catch {
      toasts.error(`Couldn't restore “${name}”.`);
      return false;
    }
    await this.refresh();
    return true;
  }

  async deleteForever(id: PageId): Promise<void> {
    try {
      await this.store.deleteForever(id);
    } catch {
      toasts.error("Couldn't delete this page.");
    }
    await this.refreshTrash();
  }

  async deleteContextForever(name: string): Promise<void> {
    try {
      await this.store.deleteContextForever(name);
    } catch {
      toasts.error(`Couldn't delete “${name}”.`);
    }
    await this.refreshTrash();
  }

  /** Empties what the trash is showing: one context's deletions, not every one. */
  async clearTrash(context: string): Promise<void> {
    const scoped = trashInContext(this.trash, context);
    try {
      if (scoped.length === this.trash.length) {
        await this.store.clearTrash();
      } else {
        for (const entry of scoped) {
          if (entry.kind === "page") await this.store.deleteForever(entry.id);
          else await this.store.deleteContextForever(entry.name);
        }
      }
    } catch {
      toasts.error("Couldn't empty the trash.");
    }
    await this.refreshTrash();
  }

  openQuickSwitcher(): void {
    this.flush();
    this.quickSwitcherOpen = true;
  }

  async searchContent(query: string, limit: number): Promise<ContentMatch[]> {
    try {
      const hits = await this.store.searchContent(query, limit);
      const live = new Set(this.pages.map((p) => p.id));
      return hits.filter((hit) => live.has(hit.id));
    } catch {
      return [];
    }
  }

  closeQuickSwitcher(): void {
    this.quickSwitcherOpen = false;
  }

  async move(
    id: PageId,
    newParentId: PageId | null,
    orderedIds: PageId[],
  ): Promise<void> {
    const parentBefore = this.pageById(id)?.parentId ?? null;
    try {
      await this.store.move(id, newParentId, orderedIds);
    } catch {
      toasts.error("Couldn't save the new page order.");
    }
    await this.refresh();

    const parentAfter = this.pageById(id)?.parentId ?? null;

    if (this.activePageId === id && this.activePage) {
      this.activePage.parentId = parentAfter;
    }
    if (parentAfter !== parentBefore) {
      await this.reparentChildLink(id, parentBefore, parentAfter);
    }
  }

  /**
   * `remove` runs only once the other page has them. A subpage link block is the subpage, so moving
   * it re-parents; image bytes are copied first. `into` is a destination the gesture already named.
   */
  async moveBlockToPage(
    blocks: BlockNode[],
    remove: () => void,
    into?: PageId,
    anchor?: DOMRect | null,
  ): Promise<void> {
    const from = this.activePageId;
    const page = this.activePage;
    if (!from || !page) return;
    if (page.locked) {
      toasts.error(PAGE_LOCKED, LOCK_TOAST);
      lockNudges.nudge();
      return;
    }

    const carried = [...new Set(blocks.flatMap(pageLinkIdsIn))];
    for (const id of carried) {
      const blocker = this.lockBlockedBy.get(id);
      if (blocker === undefined) continue;
      toasts.error(`“${blocker}” inside is locked`, LOCK_TOAST);
      return;
    }

    // Nowhere inside what's moving, and not the page it's already on.
    const exclude = new Set<PageId>([from]);
    for (const id of carried) {
      for (const inside of subtreeIds(this.pages, id)) exclude.add(inside);
    }

    // The editor can see the link it was dropped on, not what is under it.
    if (into !== undefined && exclude.has(into)) return;

    const target =
      into ??
      (await pickPage({
        title: blocks.length > 1 ? "Move these blocks to…" : "Move this block to…",
        anchor,
        exclude,
      }));
    if (target === null) return;

    const destination = this.pageById(target);
    if (!destination) return;
    if (destination.locked) {
      toasts.error(PAGE_LOCKED, LOCK_TOAST);
      return;
    }

    this.flush();
    try {
      const refs = new Map<string, string>();
      for (const ref of new Set(blocks.flatMap(assetRefsIn))) {
        const copy = await this.store.copyAsset(from, target, ref);
        if (copy) refs.set(ref, copy);
      }

      // The blocks carry the links themselves.
      const landed: PageId[] = [];
      for (const id of carried) {
        const siblings = this.pages
          .filter((p) => p.parentId === target && !carried.includes(p.id))
          .map((p) => p.id);
        await this.store.move(id, target, [...siblings, ...landed, id]);
        landed.push(id);
      }

      const moved = blocks.map((block) => withAssetRefs(block, refs));
      await this.editDoc(target, (doc) => ({
        ...doc,
        content: [...(doc.content ?? []), ...moved],
      }));
    } catch {
      const what = blocks.length > 1 ? "those blocks" : "that block";
      toasts.error(checkFolder(`Couldn't move ${what} to “${named(destination)}”.`));
      return;
    }

    remove();
    this.markDirty();
    if (carried.length > 0) await this.refresh();

    toasts.did(`Moved to “${named(destination)}”`, "page", {
      label: "Open",
      run: () => void this.goTo(target),
    });
  }

  private async reparentChildLink(
    id: PageId,
    from: PageId | null,
    to: PageId | null,
  ): Promise<void> {
    if (from) await this.editDoc(from, (doc) => stripPageLinks(doc, new Set([id])));
    if (to) {
      const title = this.pageById(id)?.title ?? "";
      await this.editDoc(to, (doc) =>
        hasPageLink(doc, id) ? null : appendPageLink(doc, id, title),
      );
    }
  }

  markDirty(): void {
    if (!this.activePage || this.activePage.locked) return;
    this.editRevision++;

    if (this.pendingExternalChange) return;
    this.persist();
    this.rememberCaret();
  }

  syncActiveDoc(): void {
    if (!this.activePage) return;
    const editor = this.editorForActivePage();
    if (!editor) return;
    this.activePage.doc = editor.getJSON() as PageDoc;
  }

  private activeBody(): string | null {
    const editor = this.editorForActivePage();
    return editor ? editorToMarkdown(editor) : null;
  }

  private editorForActivePage() {
    if (!this.activePage) return null;
    const editor = getActiveEditor();
    if (!editor) return null;
    if (getActiveEditorKey() !== docKey(this.activePageId, this.activeDocVersion)) {
      return null;
    }
    return editor;
  }

  setActiveTitle(title: string): void {
    if (!this.activePage || this.activePage.locked) return;
    this.activePage.title = title;

    const summary = this.pageById(this.activePage!.id);
    if (summary) summary.title = title;
    this.editRevision++;

    if (this.pendingExternalChange) return;
    this.persist();
    this.settleName();
  }

  /**
   * The synchronous half runs before it returns, so a `beforeunload` handler still gets the caret
   * written.
   */
  flush(): Promise<void> {
    this.rememberCaret.cancel();
    this.captureCaret();
    viewState.flush();
    this.persist.flush();
    this.settleName.flush();
    return this.drain();
  }

  private async drain(): Promise<void> {
    try {
      await this.lastSave;
      await this.store?.settled?.();
    } catch {
      // a failed save has already raised its own toast
    }
  }

  private captureCaret(): void {
    const id = this.activePageId;
    const editor = this.editorForActivePage();
    if (!id || !editor) return;
    const { anchor, head } = editor.state.selection;
    viewState.setCaret(id, { anchor, head });
  }

  /**
   * Only a page in the context being looked at, or the sidebar would move to a context nobody asked
   * for. An empty context stays empty.
   */
  private async reopenAfterRemoval(preferred: PageId | null): Promise<void> {
    if (this.activePageId && this.contextPages.some((p) => p.id === this.activePageId)) {
      return;
    }
    const inContext = (id: PageId | null): boolean =>
      !!id && this.contextPages.some((p) => p.id === id);

    const next = inContext(preferred) ? preferred : (this.contextPages[0]?.id ?? null);

    this.activePageId = null;
    this.activePage = null;
    if (next) await this.goTo(next, { replace: true });
    else await this.showNothing({ replace: true });
  }

  /** Leave the editor empty and let the root route say why. */
  private async showNothing(opts: { replace?: boolean } = {}): Promise<void> {
    this.activePageId = null;
    this.activePage = null;
    await goToContext(this.pathForContext(this.activeContext), opts);
  }

  /** The counterpart to `open` following a page into its context. */
  showContext(name: string): void {
    if (name === this.activeContext) return;
    if (!this.contexts.some((c) => c.name === name)) return;
    this.flush();
    this.setContext(name);
  }

  /** History can land on the empty state on its own, with the page still open behind it. */
  closePage(): void {
    if (!this.activePageId) return;
    this.flush();
    this.activePageId = null;
    this.activePage = null;
  }
}

function sameDoc(a: PageDoc | undefined, b: PageDoc | undefined): boolean {
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function named(page: PageSummary): string {
  return page.title.trim() || "Untitled";
}

/** The likeliest failure is the folder not being there. */
function checkFolder(what: string): string {
  return `${what} Check that your notes folder is available.`;
}

export const workspace = new Workspace();
