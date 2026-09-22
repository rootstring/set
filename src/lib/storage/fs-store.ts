import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import {
  copyFile,
  exists,
  mkdir,
  readDir,
  readTextFile,
  remove as fsRemove,
  rename,
  stat,
  writeFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import type {
  Context,
  Page,
  PageId,
  PageSummary,
  TrashEntry,
  TrashedPage,
  TrashRef,
} from "$lib/types";
import { emptyDoc } from "$lib/types";
import { createId, deriveId } from "$lib/utils/id";
import { sha256Hex } from "$lib/utils/hash";
import { bySiblingOrder, subtreeIds } from "$lib/page/tree";
import {
  ChangedOnDiskError,
  type Absorbed,
  type ContentMatch,
  type PageStore,
  type StoredAsset,
} from "./store";
import {
  fileToPage,
  markdownBody,
  pageSignature,
  pageToFile,
  readFileMeta,
  replaceId,
  type FileMeta,
} from "./serialize";
import { docToMarkdown } from "./markdown";
import {
  ASSETS_DIR,
  DEFAULT_CONTEXT,
  TRASH_DIR as TRASH,
  assetFileName,
  assetRef,
  baseName,
  contextOf,
  dirOf,
  isDisplayableUrl,
  isReserved,
  joinRel,
  normalizeAssetRefs,
  sanitizeContextName,
  sanitizeTitle,
  stripMd,
  trashOf,
} from "./paths";

interface Entry {
  id: PageId;
  parentId: PageId | null;
  title: string;
  order: number | undefined;
  locked: boolean | undefined;
  createdAt: number;
  updatedAt: number;
  relPath: string;
}

interface ScanEntry {
  id: PageId;
  parentId: PageId | null;
  title: string;
  order: number | null;
  locked: boolean;
  createdAt: number;
  updatedAt: number;
  relPath: string;
}

export class FsPageStore implements PageStore {
  private index = new Map<PageId, Entry>();

  private lastWritten = new Map<PageId, string>();

  /**
   * The version a save was edited from, which the save checks the file still is. Kept through a
   * reload.
   */
  private known = new Map<PageId, string>();

  private writes: Promise<unknown> = Promise.resolve();

  migrated = 0;

  constructor(private root: string) {}

  private abs(rel: string): string {
    return rel ? `${this.root}/${rel}` : this.root;
  }

  get rootDir(): string {
    return this.root;
  }

  private assetDirOf(relPath: string): string {
    return joinRel(stripMd(relPath), ASSETS_DIR);
  }

  async init(): Promise<void> {
    this.index.clear();
    await mkdir(this.abs(""), { recursive: true });
    this.migrated = 0;
    await this.ensureLayout();
    try {
      await this.adoptScan(await invoke<ScanEntry[]>("scan_notes", { root: this.root }));
    } catch {
      await this.scanDir("", null);
    }
    await this.repairReserved();
  }

  /**
   * Two notes can carry one id (copied outside the app, or brought back by sync while trashed).
   * First in byte order keeps it; the rest are reissued. `A.md` sorts before `A/`, so a parent is
   * seen first.
   */
  private async adoptScan(entries: ScanEntry[]): Promise<void> {
    const reissued = new Map<string, PageId>(); // a reissued page's folder → its new id
    const shared = new Set<PageId>();
    for (const e of [...entries].sort((a, b) => byteOrder(a.relPath, b.relPath))) {
      let id = e.id;
      if (this.index.has(id)) {
        try {
          id = await this.reissueId(e.relPath, id, this.index, true);
        } catch {
          continue; // with no id of its own it can't be told apart, so it stays hidden
        }
        shared.add(e.id);
        reissued.set(stripMd(e.relPath), id);
      }
      this.index.set(id, {
        id,
        parentId: reissued.get(dirOf(e.relPath)) ?? e.parentId,
        title: e.title,
        order: e.order ?? undefined,
        locked: e.locked || undefined,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        relPath: e.relPath,
      });
    }

    // The scan indexed a shared id for search from whichever copy it read last.
    for (const id of shared) {
      const keeper = this.index.get(id)!;
      try {
        const text = await readTextFile(this.abs(keeper.relPath));
        await this.atomicWrite(keeper.relPath, text, id, await sha256Hex(text));
      } catch {
        // search is stale for this one page until it's next saved
      }
    }
  }

  async reload(): Promise<void> {
    this.lastWritten.clear();
    await this.init();
  }

  private async ensureLayout(): Promise<void> {
    const { contexts, loose } = await this.readRoot();

    if (loose.length > 0) {
      const dest = this.abs(DEFAULT_CONTEXT);
      await mkdir(dest, { recursive: true });
      for (const name of loose) {
        const base = stripMd(name);
        try {
          const free = await freeBase(dest, base);
          await rename(this.abs(name), `${dest}/${free}.md`);
          // `Set-Trash/` beside a hand-made `Set-Trash.md` is the trash, not its children.
          if (!isReserved(base) && (await exists(this.abs(base)))) {
            await rename(this.abs(base), `${dest}/${free}`);
          }
          this.migrated++;
        } catch {
          // one file that won't move shouldn't strand the others
        }
      }
      return;
    }

    if (contexts.length === 0) {
      try {
        await mkdir(this.abs(DEFAULT_CONTEXT), { recursive: true });
      } catch {
        // the folder is there already, or can't be made; the scan copes either way
      }
    }
  }

  private async readRoot(): Promise<{ contexts: string[]; loose: string[] }> {
    let entries;
    try {
      entries = await readDir(this.abs(""));
    } catch {
      return { contexts: [], loose: [] };
    }

    const loose: string[] = [];
    const dirs: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory) {
        dirs.push(entry.name);
      } else if (
        entry.isFile &&
        entry.name.toLowerCase().endsWith(".md") &&
        !entry.name.endsWith(TMP_SUFFIX)
      ) {
        loose.push(entry.name);
      }
    }

    const claimed = new Set(loose.map(stripMd));
    const contexts = dirs
      .filter((name) => !isReserved(name) && !claimed.has(name))
      .sort((a, b) => a.localeCompare(b));
    return { contexts, loose };
  }

  private async repairReserved(): Promise<void> {
    for (const entry of this.index.values()) {
      if (!isReserved(stripMd(baseName(entry.relPath)))) continue;
      try {
        const dest = await this.allocate(dirOf(entry.relPath), entry.title, entry.id);
        await rename(this.abs(entry.relPath), this.abs(dest));
        entry.relPath = dest;
      } catch {
        // leave the page under its reserved name rather than fail startup
      }
    }
  }

  private async scanDir(relDir: string, parentId: PageId | null): Promise<void> {
    const entries = (await readDir(this.abs(relDir))).sort((a, b) =>
      byteOrder(a.name, b.name),
    );
    const folderOwner = new Map<string, PageId>();

    for (const entry of entries) {
      if (!entry.isFile) continue;

      if (entry.name.endsWith(TMP_SUFFIX)) {
        try {
          await fsRemove(this.abs(joinRel(relDir, entry.name)));
        } catch {
          // a leftover temp file; removing it is tidying, not the job
        }
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      const relPath = joinRel(relDir, entry.name);
      let meta;
      try {
        meta = readFileMeta(await readTextFile(this.abs(relPath)));
      } catch {
        meta = {};
      }
      const now = Date.now();
      let id = meta.id ?? createId();
      // another page has it (see `adoptScan`)
      if (this.index.has(id) && this.index.get(id)!.relPath !== relPath) {
        try {
          id = await this.reissueId(relPath, id, this.index, true);
        } catch {
          continue;
        }
      }
      this.index.set(id, {
        id,
        parentId,
        title: meta.title ?? stripMd(entry.name),
        order: meta.order,
        locked: meta.locked,
        createdAt: meta.createdAt ?? now,
        updatedAt: meta.updatedAt ?? now,
        relPath,
      });
      folderOwner.set(stripMd(entry.name), id);
    }

    for (const entry of entries) {
      if (!entry.isDirectory || isReserved(entry.name)) continue;
      const owner = folderOwner.get(entry.name) ?? null;
      await this.scanDir(joinRel(relDir, entry.name), owner);
    }
  }

  async list(): Promise<PageSummary[]> {
    return [...this.index.values()]
      .sort(bySiblingOrder)
      .map(({ id, title, parentId, createdAt, locked, relPath }) => ({
        id,
        title,
        parentId,
        context: contextOf(relPath),
        createdAt,
        locked,
      }));
  }

  async listContexts(): Promise<Context[]> {
    const { contexts } = await this.readRoot();
    const counts = new Map<string, number>();
    for (const entry of this.index.values()) {
      const name = contextOf(entry.relPath);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }

    return contexts.map((name) => ({ name, pages: counts.get(name) ?? 0 }));
  }

  async createContext(name: string): Promise<string> {
    const wanted = sanitizeContextName(name);
    if (!wanted) throw new Error(`"${name}" can't be a context name`);
    const free = await freeBase(this.abs(""), wanted);
    await mkdir(this.abs(free), { recursive: true });
    return free;
  }

  async renameContext(from: string, to: string): Promise<string> {
    const wanted = sanitizeContextName(to);
    if (!wanted) throw new Error(`"${to}" can't be a context name`);
    if (wanted === from) return from;
    if (!(await exists(this.abs(from)))) throw new Error(`no context named ${from}`);

    const free = await freeBase(this.abs(""), wanted);
    return this.queueWrite(async () => {
      await rename(this.abs(from), this.abs(free));

      const prefix = `${from}/`;
      for (const entry of this.index.values()) {
        if (entry.relPath.startsWith(prefix)) {
          entry.relPath = `${free}/${entry.relPath.slice(prefix.length)}`;
        }
      }
      return free;
    });
  }

  async deleteContext(name: string): Promise<void> {
    if (!(await exists(this.abs(name)))) return;
    const bin = joinRel(TRASH, name);
    await mkdir(this.abs(TRASH), { recursive: true });

    if (await exists(this.abs(bin))) {
      // a context of this name was deleted before and never emptied
      await this.absorb(name, bin);
      try {
        await fsRemove(this.abs(name), { recursive: true });
      } catch {
        // the pages are in the trash already; an empty husk can wait
      }
    } else {
      // One rename, its own trash along with it.
      await rename(this.abs(name), this.abs(bin));
    }

    for (const entry of [...this.index.values()]) {
      if (contextOf(entry.relPath) !== name) continue;
      this.index.delete(entry.id);
      this.lastWritten.delete(entry.id);
    }
  }

  private async absorb(from: string, into: string): Promise<void> {
    let entries;
    try {
      entries = await readDir(this.abs(from));
    } catch {
      return;
    }

    const claimed = new Map<string, string>();
    for (const entry of entries) {
      if (!entry.isFile || !isNote(entry.name)) continue;
      const base = stripMd(entry.name);
      const free = await freeBase(this.abs(into), base);
      claimed.set(base, free);
      await rename(
        this.abs(joinRel(from, entry.name)),
        this.abs(joinRel(into, `${free}.md`)),
      );
    }

    for (const entry of entries) {
      if (!entry.isDirectory) continue;

      if (isReserved(entry.name)) {
        // The layout's folders merge rather than arriving as "Set-Trash 2".
        const nested = joinRel(into, entry.name);
        await mkdir(this.abs(nested), { recursive: true });
        await this.absorb(joinRel(from, entry.name), nested);
        continue;
      }

      const free =
        claimed.get(entry.name) ?? (await freeBase(this.abs(into), entry.name));
      await rename(this.abs(joinRel(from, entry.name)), this.abs(joinRel(into, free)));
    }

    for (const entry of entries) {
      if (!entry.isFile || isNote(entry.name) || entry.name.endsWith(TMP_SUFFIX)) {
        continue; // notes are done; scratch files are swept, never moved
      }
      await rename(
        this.abs(joinRel(from, entry.name)),
        this.abs(joinRel(into, await freeFileName(this.abs(into), entry.name))),
      );
    }
  }

  /** The root trash exists to hold deleted contexts. With none, it shouldn't. */
  private async pruneRootTrash(): Promise<void> {
    if ((await this.entriesIn(TRASH)).length > 0) return;
    try {
      await fsRemove(this.abs(TRASH));
    } catch {
      // an empty folder nobody sees is not worth reporting
    }
  }

  private async entriesIn(
    rel: string,
  ): Promise<{ name: string; isFile: boolean; isDirectory: boolean }[]> {
    try {
      return await readDir(this.abs(rel));
    } catch {
      return [];
    }
  }

  async moveToContext(id: PageId, context: string): Promise<void> {
    const entry = this.index.get(id);
    if (!entry || contextOf(entry.relPath) === context) return;
    if (!(await exists(this.abs(context)))) {
      throw new Error(`no context named ${context}`);
    }
    return this.queueWrite(async () => {
      await this.movePage(entry, await this.allocate(context, entry.title, id));
      entry.parentId = null;

      entry.order = undefined;
      await this.rewriteMeta(entry);
    });
  }

  async searchContent(
    query: string,
    limit: number,
    only?: readonly PageId[],
  ): Promise<ContentMatch[]> {
    try {
      return await invoke<ContentMatch[]>("search_notes", {
        query,
        limit,
        only: only ?? null,
      });
    } catch {
      return [];
    }
  }

  async backlinks(title: string): Promise<PageId[]> {
    try {
      return await invoke<PageId[]>("page_backlinks", { title });
    } catch {
      return [];
    }
  }

  async get(id: PageId, opts: { track?: boolean } = {}): Promise<Page | null> {
    const entry = this.index.get(id);
    if (!entry) return null;
    const text = await readTextFile(this.abs(entry.relPath));
    const page = pageFrom(text, entry);
    if (opts.track === false) return page;

    this.known.set(id, text);
    this.lastWritten.set(id, this.signatureOf(page, entry, text));
    return page;
  }

  async changedOutside(id: PageId): Promise<boolean> {
    const entry = this.index.get(id);
    const baseline = this.lastWritten.get(id);

    if (!entry || baseline === undefined) return false;
    let text: string;
    try {
      text = await readTextFile(this.abs(entry.relPath));
    } catch {
      this.lastWritten.delete(id);
      return true;
    }
    if (this.signatureOf(pageFrom(text, entry), entry, text) === baseline) return false;

    this.lastWritten.delete(id);
    return true;
  }

  private signatureOf(page: Page, entry: Entry, text: string): string {
    return pageSignature(page, entry.order, markdownBody(text));
  }

  async create(
    input: { title?: string; parentId?: PageId | null; context?: string } = {},
  ): Promise<Page> {
    const now = Date.now();
    const parentId = input.parentId ?? null;
    const page: Page = {
      id: createId(),
      title: input.title ?? "",
      doc: emptyDoc(),
      parentId,
      context: this.contextFor(parentId, input.context),
      createdAt: now,
      updatedAt: now,
    };
    const folder = this.childFolderOf(parentId, input.context);
    await mkdir(this.abs(folder), { recursive: true });
    const relPath = await this.allocate(folder, page.title);
    const written = await this.atomicWrite(relPath, pageToFile(page), page.id, ABSENT);
    this.known.set(page.id, written);
    this.index.set(page.id, {
      id: page.id,
      parentId,
      title: page.title,
      order: undefined,
      locked: undefined,
      createdAt: now,
      updatedAt: now,
      relPath,
    });
    return page;
  }

  async save(page: Page, body?: string): Promise<void> {
    const entry = this.index.get(page.id);
    // Writing it back under a fresh id would make a blank page beside the edits; the caller folds
    // them in (`workspace.foldChangeOnDisk`).
    if (!entry) throw new ChangedOnDiskError(page.id);

    const markdown = body ?? docToMarkdown(page.doc);
    const signature = pageSignature(page, entry.order, markdown);

    if (this.lastWritten.get(page.id) === signature) return;

    return this.queueWrite(async () => {
      // Looked up again: a reload queued ahead of this can have moved it.
      const current = this.index.get(page.id);
      if (!current) throw new ChangedOnDiskError(page.id);
      const now = Date.now();
      const written = await this.atomicWrite(
        current.relPath,
        pageToFile({ ...page, order: current.order, updatedAt: now }, markdown),
        page.id,
        await this.expectedFor(page.id),
      );
      current.title = page.title;
      current.parentId = page.parentId;
      current.locked = page.locked || undefined;
      current.updatedAt = now;
      this.known.set(page.id, written);
      this.lastWritten.set(page.id, signature);
    });
  }

  async rebase(page: Page, body?: string): Promise<Absorbed> {
    return this.queueWrite(async () => {
      const id = page.id;
      let found = await this.locate(id);
      if (!found) {
        // It may only have moved: a sync retitled it, or filed it elsewhere.
        await this.init();
        found = await this.locate(id);
      }
      if (!found) {
        const trashed = (await this.findTrashed(id)) !== null;
        return { kind: "gone", trashed };
      }

      const { entry, text: theirs } = found;
      const markdown = body ?? docToMarkdown(page.doc);
      const ours = pageToFile(
        { ...page, parentId: entry.parentId, order: entry.order, updatedAt: Date.now() },
        markdown,
      );
      const base = this.known.get(id);
      const merged =
        base === undefined
          ? null
          : base === theirs
            ? ours
            : await mergeText(base, ours, theirs);
      if (merged === null) return { kind: "conflict" };
      return {
        kind: "merged",
        page: pageFrom(merged, entry),
        body: markdownBody(merged),
        theirs,
      };
    });
  }

  adopt(id: PageId, theirs: string): void {
    this.known.set(id, theirs);
    this.lastWritten.delete(id);
  }

  async overwriteNext(id: PageId): Promise<void> {
    return this.queueWrite(async () => {
      const found = await this.locate(id);
      if (!found) return;
      this.known.set(id, found.text);
      this.lastWritten.delete(id);
    });
  }

  async recreate(page: Page, body?: string): Promise<void> {
    return this.queueWrite(async () => {
      if (this.index.has(page.id)) return;
      const parent = page.parentId ? this.index.get(page.parentId) : undefined;
      const context = parent
        ? contextOf(parent.relPath)
        : page.context || DEFAULT_CONTEXT;
      const folder = parent ? stripMd(parent.relPath) : context;
      await mkdir(this.abs(folder), { recursive: true });
      const relPath = await this.allocate(folder, page.title);
      const now = Date.now();
      const parentId = parent ? page.parentId : null;
      const written = await this.atomicWrite(
        relPath,
        pageToFile({ ...page, parentId, order: undefined, updatedAt: now }, body),
        page.id,
        ABSENT,
      );
      this.known.set(page.id, written);
      this.lastWritten.delete(page.id);
      this.index.set(page.id, {
        id: page.id,
        parentId,
        title: page.title,
        order: undefined,
        locked: page.locked || undefined,
        createdAt: page.createdAt,
        updatedAt: now,
        relPath,
      });
    });
  }

  /** Where the page with `id` is, going by the index, and what its file says. */
  private async locate(id: PageId): Promise<{ entry: Entry; text: string } | null> {
    const entry = this.index.get(id);
    if (!entry) return null;
    let text: string;
    try {
      text = await readTextFile(this.abs(entry.relPath));
    } catch {
      return null;
    }
    // Another page can have taken the name since.
    if ((readFileMeta(text).id ?? id) !== id) return null;
    return { entry, text };
  }

  /** The check a write of this page's file carries (see `known`). */
  private async expectedFor(id: PageId): Promise<string | undefined> {
    const known = this.known.get(id);
    return known === undefined ? undefined : sha256Hex(known);
  }

  async syncFileName(id: PageId): Promise<void> {
    const entry = this.index.get(id);
    if (!entry) return;
    const folder = this.childFolderOf(entry.parentId, contextOf(entry.relPath));
    const desired = sanitizeTitle(entry.title);
    if (
      folder === dirOf(entry.relPath) &&
      `${desired}.md` === baseName(entry.relPath) &&
      !isReserved(desired)
    ) {
      return;
    }
    return this.queueWrite(async () => {
      if (folder) await mkdir(this.abs(folder), { recursive: true });
      await this.movePage(entry, await this.allocate(folder, entry.title, id));
    });
  }

  async settled(): Promise<void> {
    // `writes` is replaced by every queueWrite; re-read until it stops moving.
    for (let seen = this.writes; ; seen = this.writes) {
      await seen;
      if (this.writes === seen) return;
    }
  }

  private queueWrite<T>(run: () => Promise<T>): Promise<T> {
    const next = this.writes.then(run, run);

    this.writes = next.catch(() => {});
    return next;
  }

  async move(
    id: PageId,
    newParentId: PageId | null,
    orderedIds: PageId[],
  ): Promise<void> {
    const moved = this.index.get(id);
    if (!moved) return;

    if (moved.parentId !== newParentId) {
      if (
        id === newParentId ||
        this.descendantsOf(id).some((e) => e.id === newParentId)
      ) {
        return;
      }

      const folder = this.childFolderOf(newParentId, contextOf(moved.relPath));
      await mkdir(this.abs(folder), { recursive: true });
      await this.movePage(moved, await this.allocate(folder, moved.title, id));
      moved.parentId = newParentId;
    }

    let unwritten = 0;
    for (let i = 0; i < orderedIds.length; i++) {
      const entry = this.index.get(orderedIds[i]);
      if (!entry || entry.parentId !== newParentId) continue;
      const isMoved = entry.id === id;
      if (entry.order === i && !isMoved) continue;
      entry.order = i;

      try {
        await this.rewriteMeta(entry);
      } catch {
        unwritten++;
      }
    }

    if (unwritten > 0) {
      throw new Error(`${unwritten} page(s) could not be written with their new order`);
    }
  }

  async remove(id: PageId): Promise<void> {
    // Behind any save still queued for it, so the trash gets the last word typed.
    return this.queueWrite(() => this.removeNow(id));
  }

  private async removeNow(id: PageId): Promise<void> {
    const entry = this.index.get(id);
    if (!entry) return;

    const bin = trashOf(contextOf(entry.relPath));
    await mkdir(this.abs(bin), { recursive: true });
    const dest = await this.allocate(bin, entry.title);
    const children = stripMd(entry.relPath);
    await rename(this.abs(entry.relPath), this.abs(dest));

    const ownsReserved = isReserved(stripMd(baseName(entry.relPath)));
    if (!ownsReserved && (await exists(this.abs(children)))) {
      await rename(this.abs(children), this.abs(stripMd(dest)));
    }

    for (const e of [entry, ...this.descendantsOf(id)]) {
      this.index.delete(e.id);
      this.lastWritten.delete(e.id);
      this.known.delete(e.id);
    }
  }

  async putAsset(pageId: PageId, bytes: Uint8Array, kind: StoredAsset): Promise<string> {
    const entry = this.index.get(pageId);
    if (!entry) throw new Error(`can't store an image for unknown page ${pageId}`);
    const dir = this.assetDirOf(entry.relPath);
    await mkdir(this.abs(dir), { recursive: true });

    const fileName = `${createId()}.${kind.ext}`;
    await writeFile(this.abs(joinRel(dir, fileName)), bytes);
    return assetRef(stripMd(baseName(entry.relPath)), fileName);
  }

  async assetUrl(pageId: PageId, ref: string): Promise<string | null> {
    const name = assetFileName(ref);
    if (!name) return isDisplayableUrl(ref) ? ref : null;
    const entry = this.index.get(pageId);
    if (!entry) return null;
    return convertFileSrc(this.abs(joinRel(this.assetDirOf(entry.relPath), name)));
  }

  async copyAsset(fromId: PageId, toId: PageId, ref: string): Promise<string | null> {
    const name = assetFileName(ref);
    if (!name) return null; // a URL, not a file of ours
    const from = this.index.get(fromId);
    const to = this.index.get(toId);
    if (!from || !to) return null;

    const src = this.abs(joinRel(this.assetDirOf(from.relPath), name));
    if (!(await exists(src))) return null;

    const dir = this.assetDirOf(to.relPath);
    await mkdir(this.abs(dir), { recursive: true });
    const dest = this.abs(joinRel(dir, name));
    // The name is a random id, so the same image twice is the same bytes.
    if (!(await exists(dest))) await copyFile(src, dest);

    return assetRef(stripMd(baseName(to.relPath)), name);
  }

  private async refreshAssetRefs(entry: Entry): Promise<void> {
    try {
      if (!(await exists(this.abs(this.assetDirOf(entry.relPath))))) return;
      const text = await readTextFile(this.abs(entry.relPath));
      const fixed = normalizeAssetRefs(text, stripMd(baseName(entry.relPath)));
      if (fixed === text) return;

      this.lastWritten.delete(entry.id);
      const written = await this.atomicWrite(
        entry.relPath,
        fixed,
        entry.id,
        await sha256Hex(text),
      );
      this.advanceKnown(entry.id, text, written);
    } catch {
      // rewriting stale asset paths is opportunistic
    }
  }

  private descendantsOf(id: PageId): Entry[] {
    const entries = [...this.index.values()];
    const ids = subtreeIds(entries, id);
    return entries.filter((e) => e.id !== id && ids.has(e.id));
  }

  async listTrash(): Promise<TrashEntry[]> {
    await this.healTrashIds();
    const { contexts } = await this.readRoot();
    const out: TrashEntry[] = [];

    for (const context of contexts) {
      out.push(...(await this.trashedPagesIn(trashOf(context), context)));
    }

    // Unless a context was made again under that name, in which case it holds pages deleted out of
    // it.
    const live = new Set(contexts);
    for (const entry of await this.entriesIn(TRASH)) {
      if (entry.isFile && isNote(entry.name)) {
        const page = await this.trashedPage(joinRel(TRASH, entry.name), DEFAULT_CONTEXT);
        if (page) out.push(page.entry);
        continue;
      }
      if (!entry.isDirectory || isReserved(entry.name)) continue;
      const dir = joinRel(TRASH, entry.name);

      if (!live.has(entry.name)) {
        out.push({
          kind: "context",
          name: entry.name,
          pages: await this.countNotes(dir),
          trashedAt: await this.mtimeOf(dir),
        });
        continue;
      }
      out.push(...(await this.trashedPagesIn(dir, entry.name)));
      out.push(...(await this.trashedPagesIn(joinRel(dir, TRASH), entry.name)));
    }
    return out.sort((a, b) => b.trashedAt - a.trashedAt);
  }

  /**
   * Two trashed notes can share an id (the same page trashed twice after a copy came back); the
   * trash addresses by id. First found keeps it, byte order, so every device agrees.
   */
  private async healTrashIds(): Promise<void> {
    const { contexts } = await this.readRoot();
    const seen = new Set<PageId>();

    for (const bin of [...contexts.map(trashOf), TRASH]) {
      const queue = [bin];
      while (queue.length) {
        const dir = queue.shift()!;
        const entries = (await this.entriesIn(dir)).sort((a, b) =>
          byteOrder(a.name, b.name),
        );
        for (const entry of entries) {
          if (!entry.isFile || !isNote(entry.name)) continue;
          const rel = joinRel(dir, entry.name);
          try {
            const { id } = readFileMeta(await readTextFile(this.abs(rel)));
            if (!id) continue;
            seen.add(seen.has(id) ? await this.reissueId(rel, id, seen, false) : id);
          } catch {
            // unreadable or unwritable: left as it is, to be tried next time
          }
        }
        for (const entry of entries) {
          if (entry.isDirectory && entry.name !== ASSETS_DIR) {
            queue.push(joinRel(dir, entry.name));
          }
        }
      }
    }
  }

  /**
   * Derived from the old id and the path, not random, so two devices repairing the same file write
   * the same bytes.
   */
  private async reissueId(
    rel: string,
    id: PageId,
    taken: { has(id: PageId): boolean },
    live: boolean,
  ): Promise<PageId> {
    const text = await readTextFile(this.abs(rel));
    let fresh = await deriveId(`${id}/${rel}`);
    while (taken.has(fresh)) fresh = await deriveId(fresh);
    await this.atomicWrite(
      rel,
      replaceId(text, fresh),
      live ? fresh : null,
      await sha256Hex(text),
    );
    return fresh;
  }

  async listTrashIn(entry: TrashRef): Promise<TrashedPage[]> {
    if (entry.kind === "context") {
      return this.trashedPagesIn(joinRel(TRASH, entry.name), entry.name);
    }
    const found = await this.findTrashed(entry.id);
    if (!found) return [];
    return this.trashedPagesIn(stripMd(found.relPath), found.context);
  }

  /** The notes directly in one trash folder, in the order they were written. */
  private async trashedPagesIn(dir: string, context: string): Promise<TrashedPage[]> {
    const found: { entry: TrashedPage; sort: number }[] = [];
    for (const file of await this.entriesIn(dir)) {
      if (!file.isFile || !isNote(file.name)) continue;
      const page = await this.trashedPage(joinRel(dir, file.name), context);
      if (page) found.push(page);
    }
    return found.sort((a, b) => a.sort - b.sort).map((f) => f.entry);
  }

  private async trashedPage(
    rel: string,
    context: string,
  ): Promise<{ entry: TrashedPage; sort: number } | null> {
    let meta;
    try {
      meta = readFileMeta(await readTextFile(this.abs(rel)));
    } catch {
      return null;
    }
    if (!meta.id) return null; // no id → can't be restored reliably, so hide it
    return {
      entry: {
        kind: "page",
        id: meta.id,
        title: meta.title ?? stripMd(baseName(rel)),
        trashedAt: await this.mtimeOf(rel),
        context,
        descendants: await this.countNotes(stripMd(rel)),
      },
      sort: meta.order ?? meta.createdAt ?? 0,
    };
  }

  private async countNotes(dir: string): Promise<number> {
    let entries;
    try {
      entries = await readDir(this.abs(dir));
    } catch {
      return 0;
    }
    let total = 0;
    for (const entry of entries) {
      if (entry.isFile && isNote(entry.name)) total++;
      else if (entry.isDirectory && !isReserved(entry.name)) {
        total += await this.countNotes(joinRel(dir, entry.name));
      }
    }
    return total;
  }

  private async mtimeOf(rel: string): Promise<number> {
    try {
      return (await stat(this.abs(rel))).mtime?.getTime() ?? 0;
    } catch {
      return 0;
    }
  }

  async restore(trashedId: PageId): Promise<PageId> {
    const found = await this.findTrashed(trashedId);
    if (!found) return trashedId;
    const { relPath, meta, context } = found;
    const now = Date.now();

    // A live page already has this id; reissued before it moves, so a failure leaves it in the
    // trash.
    const id = this.index.has(trashedId)
      ? await this.reissueId(relPath, trashedId, this.index, false)
      : trashedId;
    const title = meta.title ?? stripMd(baseName(relPath));

    await mkdir(this.abs(context), { recursive: true });
    const dest = await this.allocate(context, title);
    const held = stripMd(relPath);
    await rename(this.abs(relPath), this.abs(dest));

    const restoredDir = stripMd(dest);
    const hadChildren = await exists(this.abs(held));
    if (hadChildren) await rename(this.abs(held), this.abs(restoredDir));

    this.index.set(id, {
      id,
      parentId: null,
      title,
      order: undefined,
      locked: meta.locked,
      createdAt: meta.createdAt ?? now,
      updatedAt: meta.updatedAt ?? now,
      relPath: dest,
    });

    if (hadChildren) {
      try {
        await this.scanDir(restoredDir, id);
      } catch {
        // the page is restored; its children are re-indexed on the next scan
      }
    }

    try {
      await this.rewriteMeta(this.index.get(id)!);
    } catch {
      // likewise: the file is already back in place
    }
    return id;
  }

  async restoreContext(name: string): Promise<void> {
    const bin = joinRel(TRASH, name);
    if (!(await exists(this.abs(bin)))) return;
    if (await exists(this.abs(name))) {
      await this.absorb(bin, name);
      try {
        await fsRemove(this.abs(bin), { recursive: true });
      } catch {
        // the merge is done; the emptied bin folder can stay
      }
    } else {
      await rename(this.abs(bin), this.abs(name));
    }
    await this.pruneRootTrash();

    try {
      await this.scanDir(name, null);
    } catch {
      // restored on disk, so a failed re-index is not a failed restore
    }
  }

  async deleteForever(id: PageId): Promise<void> {
    const found = await this.findTrashed(id);
    if (!found) return;
    await fsRemove(this.abs(found.relPath));

    const held = stripMd(found.relPath);
    if (await exists(this.abs(held))) {
      try {
        await fsRemove(this.abs(held), { recursive: true });
      } catch {
        // the note is gone; a leftover children folder is not worth failing on
      }
    }
  }

  async deleteContextForever(name: string): Promise<void> {
    const bin = joinRel(TRASH, name);
    if (await exists(this.abs(bin))) {
      await fsRemove(this.abs(bin), { recursive: true });
    }
    await this.pruneRootTrash();
  }

  async clearTrash(): Promise<void> {
    for (const context of (await this.readRoot()).contexts) {
      const bin = trashOf(context);
      if (!(await exists(this.abs(bin)))) continue;
      await fsRemove(this.abs(bin), { recursive: true });
    }
    if (await exists(this.abs(TRASH))) {
      await fsRemove(this.abs(TRASH), { recursive: true });
    }
  }

  /**
   * The context is the folder it is in, not what the file says. Live contexts' trashes first, then
   * deleted contexts at the root.
   */
  private async findTrashed(
    id: PageId,
  ): Promise<{ relPath: string; meta: FileMeta; context: string } | null> {
    const bins = (await this.readRoot()).contexts.map((context) => ({
      dir: trashOf(context),
      context,
    }));
    for (const entry of await this.entriesIn(TRASH)) {
      if (!entry.isDirectory || isReserved(entry.name)) continue;
      bins.push({ dir: joinRel(TRASH, entry.name), context: entry.name });
    }

    for (const { dir, context } of bins) {
      const found = await this.searchTrash(dir, id, context, true);
      if (found) return found;
    }

    // Notes trashed before contexts existed come back to the default context.
    return this.searchTrash(TRASH, id, DEFAULT_CONTEXT, false);
  }

  private async searchTrash(
    from: string,
    id: PageId,
    context: string,
    deep: boolean,
  ): Promise<{ relPath: string; meta: FileMeta; context: string } | null> {
    const queue = [from];
    while (queue.length) {
      const dir = queue.shift()!;
      const entries = await this.entriesIn(dir);
      for (const entry of entries) {
        if (!entry.isFile || !isNote(entry.name)) continue;
        const rel = joinRel(dir, entry.name);
        try {
          const meta = readFileMeta(await readTextFile(this.abs(rel)));
          if (meta.id === id) return { relPath: rel, meta, context };
        } catch {
          // an unreadable file just isn't the one being looked for
        }
      }
      if (!deep) break;
      for (const entry of entries) {
        if (!entry.isDirectory || entry.name === ASSETS_DIR) continue;
        queue.push(joinRel(dir, entry.name));
      }
    }
    return null;
  }

  private childFolderOf(parentId: PageId | null, context?: string): string {
    const parent = parentId ? this.index.get(parentId) : undefined;
    return parent ? stripMd(parent.relPath) : this.contextFor(parentId, context);
  }

  private contextFor(parentId: PageId | null, context?: string): string {
    const parent = parentId ? this.index.get(parentId) : undefined;
    return parent ? contextOf(parent.relPath) : context || DEFAULT_CONTEXT;
  }

  private async rewriteMeta(entry: Entry): Promise<void> {
    const text = await readTextFile(this.abs(entry.relPath));
    const page = pageFrom(text, entry);
    page.order = entry.order;
    this.lastWritten.delete(entry.id); // rewritten outside save()
    const written = await this.atomicWrite(
      entry.relPath,
      pageToFile(page, markdownBody(text)),
      entry.id,
      await sha256Hex(text),
    );
    this.advanceKnown(entry.id, text, written);
  }

  /**
   * If the editor had `before`, it has `after` now; if something older, its save is still checked
   * against that.
   */
  private advanceKnown(id: PageId, before: string, after: string): void {
    if (this.known.get(id) === before) this.known.set(id, after);
  }

  private async movePage(entry: Entry, newRel: string): Promise<void> {
    const oldRel = entry.relPath;
    if (oldRel === newRel) return;
    const oldDir = stripMd(oldRel);
    const newDir = stripMd(newRel);

    await rename(this.abs(oldRel), this.abs(newRel));
    if (await exists(this.abs(oldDir))) {
      await rename(this.abs(oldDir), this.abs(newDir));
    }

    entry.relPath = newRel;
    const prefix = `${oldDir}/`;
    for (const e of this.index.values()) {
      if (e.relPath.startsWith(prefix)) {
        e.relPath = `${newDir}/${e.relPath.slice(prefix.length)}`;
      }
    }

    await this.refreshAssetRefs(entry);
  }

  private async allocate(
    folder: string,
    title: string,
    excludeId?: PageId,
  ): Promise<string> {
    const desired = sanitizeTitle(title);

    const selfRel = excludeId ? this.index.get(excludeId)?.relPath : undefined;
    for (let i = 1; ; i++) {
      const base = i === 1 ? desired : `${desired} ${i}`;

      if (isReserved(base)) continue;
      const rel = joinRel(folder, `${base}.md`);
      if (rel === selfRel) return rel;
      const dir = joinRel(folder, base);
      const takenInIndex = [...this.index.values()].some(
        (e) =>
          e.id !== excludeId && (e.relPath === rel || e.relPath.startsWith(`${dir}/`)),
      );
      if (takenInIndex) continue;
      if (await exists(this.abs(rel))) continue;
      if (await exists(this.abs(dir))) continue;
      return rel;
    }
  }

  /** `expected` is `ABSENT` or the SHA-256 of the text the file must still hold. */
  private async atomicWrite(
    rel: string,
    rawContents: string,
    id: PageId | null,
    expected?: string,
  ): Promise<string> {
    const path = this.abs(rel);

    const contents = normalizeAssetRefs(rawContents, stripMd(baseName(rel)));
    // `write_page` checks and writes under the gate sync holds; falling back would be a save sync
    // can slip past.
    if (isTauri()) {
      try {
        await invoke("write_page", { path, contents, id, expected });
        return contents;
      } catch (err) {
        if (String(err).startsWith(CHANGED_ON_DISK)) throw new ChangedOnDiskError(id);
        throw err;
      }
    }
    // Without the shell (tests): the same check, if not the same atomicity.
    if (expected !== undefined && !(await this.holds(rel, expected))) {
      throw new ChangedOnDiskError(id);
    }
    const tmp = `${path}${TMP_SUFFIX}`;
    await writeTextFile(tmp, contents);
    try {
      await rename(tmp, path);
    } catch (err) {
      try {
        await fsRemove(tmp);
      } catch {
        // best-effort cleanup; the rename error below is the one that matters
      }
      throw err;
    }
    return contents;
  }

  private async holds(rel: string, expected: string): Promise<boolean> {
    if (expected === ABSENT) return !(await exists(this.abs(rel)));
    try {
      return (await sha256Hex(await readTextFile(this.abs(rel)))) === expected;
    } catch {
      return false;
    }
  }
}

const TMP_SUFFIX = ".set-tmp";

/** A write that must find nothing where it writes. */
const ABSENT = "absent";

/** How `write_page` says a write was refused (`write::CHANGED_ON_DISK`). */
const CHANGED_ON_DISK = "changed-on-disk";

/** Null when they rewrote the same lines, or there is no shell. */
async function mergeText(
  base: string,
  ours: string,
  theirs: string,
): Promise<string | null> {
  if (ours === theirs) return ours;
  try {
    return (await invoke<string | null>("merge_note", { base, ours, theirs })) ?? null;
  } catch {
    return null;
  }
}

/** Filed where the index says: the folder layout is the truth, not a hand-written `parentId`. */
function pageFrom(text: string, entry: Entry): Page {
  const page = fileToPage(text, {
    id: entry.id,
    title: entry.title,
    parentId: entry.parentId,
    context: contextOf(entry.relPath),
  });
  page.parentId = entry.parentId;
  return page;
}

/** Plain code-unit order: the same on every device, whatever its locale. */
function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function migrateNotes(oldRoot: string, newRoot: string): Promise<number> {
  let moved = 0;

  const copyAssets = async (srcDir: string, destDir: string) => {
    await mkdir(destDir, { recursive: true });
    for (const f of await readDir(srcDir)) {
      if (!f.isFile || f.name.endsWith(TMP_SUFFIX)) continue;
      await copyFile(`${srcDir}/${f.name}`, `${destDir}/${f.name}`);
    }
  };

  // Not counted inside a trash: it travels with the notes but is not part of "N notes moved".
  const copyDir = async (srcDir: string, destDir: string, counted = true) => {
    const entries = await readDir(srcDir);
    await mkdir(destDir, { recursive: true });

    const files = entries.filter(
      (e) =>
        e.isFile && e.name.toLowerCase().endsWith(".md") && !e.name.endsWith(TMP_SUFFIX),
    );
    const assetDirs = entries.filter((e) => e.isDirectory && e.name === ASSETS_DIR);
    const dirs = entries.filter((e) => e.isDirectory && e.name !== ASSETS_DIR);

    const baseMap = new Map<string, string>();
    for (const f of files) {
      const srcBase = stripMd(f.name);
      const destBase = await freeBase(destDir, srcBase);
      baseMap.set(srcBase, destBase);
      const text = await readTextFile(`${srcDir}/${f.name}`);
      await writeTextFile(`${destDir}/${destBase}.md`, text);
      if (counted) moved++;
    }

    for (const a of assetDirs) {
      await copyAssets(`${srcDir}/${a.name}`, `${destDir}/${a.name}`);
    }

    for (const d of dirs) {
      // The trash keeps its name: it is the layout's folder, not a page's.
      const reserved = isReserved(d.name);
      const destBase = reserved
        ? d.name
        : (baseMap.get(d.name) ?? (await freeBase(destDir, d.name)));
      await copyDir(
        `${srcDir}/${d.name}`,
        `${destDir}/${destBase}`,
        counted && !reserved,
      );
    }
  };

  await copyDir(oldRoot, newRoot);

  for (const e of await readDir(oldRoot)) {
    if (
      e.isFile &&
      !(e.name.toLowerCase().endsWith(".md") && !e.name.endsWith(TMP_SUFFIX))
    )
      continue;
    try {
      await fsRemove(`${oldRoot}/${e.name}`, { recursive: true });
    } catch {
      // leftovers in the old folder don't affect what was copied out
    }
  }

  return moved;
}

function isNote(name: string): boolean {
  return name.toLowerCase().endsWith(".md") && !name.endsWith(TMP_SUFFIX);
}

async function freeFileName(dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? name : `${stem} ${i}${ext}`;
    if (!(await exists(`${dir}/${candidate}`))) return candidate;
  }
}

async function freeBase(dir: string, base: string): Promise<string> {
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? base : `${base} ${i}`;
    if (isReserved(candidate)) continue;
    const fileTaken = await exists(`${dir}/${candidate}.md`);
    const dirTaken = await exists(`${dir}/${candidate}`);
    if (!fileTaken && !dirTaken) return candidate;
  }
}
