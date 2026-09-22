import type {
  Context,
  Page,
  PageId,
  PageSummary,
  TrashEntry,
  TrashedPage,
  TrashRef,
} from "$lib/types";

export interface StoredAsset {
  ext: string;
  type: string;
}

/** Pre-split runs, not offsets: Rust counts UTF-8 bytes, JavaScript UTF-16 units. */
export interface Segment {
  text: string;
  hit: boolean;
}

export interface ContentMatch {
  id: PageId;
  score: number;
  snippet: Segment[];
  total: number;
}

/** Nothing was written. */
export class ChangedOnDiskError extends Error {
  constructor(readonly id: PageId | null) {
    super(`${id ?? "a note"} changed on disk since it was read`);
    this.name = "ChangedOnDiskError";
  }
}

/** What became of unsaved edits to a page that changed on disk. */
export type Absorbed =
  /** Not yet written. Show `page`, `adopt` `theirs`, then save. */
  | { kind: "merged"; page: Page; body: string; theirs: string }
  /** Both rewrote the same lines. Which to keep is for the person to say. */
  | { kind: "conflict" }
  /** The page's file is gone: deleted, or moved to a trash (`trashed`). */
  | { kind: "gone"; trashed: boolean };

export interface PageStore {
  readonly migrated?: number;
  list(): Promise<PageSummary[]>;
  listContexts(): Promise<Context[]>;
  createContext(name: string): Promise<string>;
  renameContext(from: string, to: string): Promise<string>;
  deleteContext(name: string): Promise<void>;
  moveToContext(id: PageId, context: string): Promise<void>;
  /** `only` narrows the pages searched before `limit` applies; ids with no body are skipped. */
  searchContent(
    query: string,
    limit: number,
    only?: readonly PageId[],
  ): Promise<ContentMatch[]>;
  /** Does not know what has been trashed; the caller filters against the live list. */
  backlinks(title: string): Promise<PageId[]>;
  /** A read is what a later save is checked against; `track: false` reads without that. */
  get(id: PageId, opts?: { track?: boolean }): Promise<Page | null>;
  changedOutside(id: PageId): Promise<boolean>;
  create(input: {
    title?: string;
    parentId?: PageId | null;
    context?: string;
  }): Promise<Page>;
  /**
   * Write the page. Refused with `ChangedOnDiskError` if its file is no longer
   * the version this store last read or wrote, or is gone.
   */
  save(page: Page, body?: string): Promise<void>;
  /** IndexedDB cannot be changed underneath, so lacks it. */
  rebase?(page: Page, body?: string): Promise<Absorbed>;
  /** Synchronous, so nothing typed can fall between the two. */
  adopt?(id: PageId, theirs: string): void;
  /**
   * Make the page's file as it is on disk now the version the next save
   * replaces: for keeping the edits on screen over a change on disk.
   */
  overwriteNext?(id: PageId): Promise<void>;
  /**
   * Write `page` back as a live page under its own id, for edits to a page that
   * was deleted while they were being made.
   */
  recreate?(page: Page, body?: string): Promise<void>;
  /** Not part of save: every keystroke in a title would be a file rename. */
  syncFileName?(id: PageId): Promise<void>;
  reload?(): Promise<void>;
  /** Quitting and re-reading the folder wait on this. */
  settled?(): Promise<void>;
  move(id: PageId, newParentId: PageId | null, orderedIds: PageId[]): Promise<void>;
  remove(id: PageId): Promise<void>;
  listTrash(): Promise<TrashEntry[]>;
  listTrashIn(entry: TrashRef): Promise<TrashedPage[]>;
  /** Resolves to the id the page came back under: a new one if a live page had taken it. */
  restore(id: PageId): Promise<PageId>;
  restoreContext(name: string): Promise<void>;
  deleteForever(id: PageId): Promise<void>;
  deleteContextForever(name: string): Promise<void>;
  clearTrash(): Promise<void>;
  putAsset(pageId: PageId, bytes: Uint8Array, kind: StoredAsset): Promise<string>;
  assetUrl(pageId: PageId, ref: string): Promise<string | null>;
  /**
   * Assets live inside the page that shows them, so the bytes travel with the block. Null for a web
   * reference or a missing file.
   */
  copyAsset(fromId: PageId, toId: PageId, ref: string): Promise<string | null>;
}
