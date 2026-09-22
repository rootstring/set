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
import { createId } from "$lib/utils/id";
import { bySiblingOrder, subtreeIds } from "$lib/page/tree";
import type { ContentMatch, PageStore, StoredAsset } from "./store";
import { fileToPage, markdownBody, pageSignature, pageToFile } from "./serialize";
import { docToMarkdown } from "./markdown";
import { foldAscii, searchBodies, type IndexedBody } from "$lib/search/content";
import { backlinkIds } from "$lib/search/wiki-links";
import {
  DEFAULT_CONTEXT,
  assetFileName,
  assetRef,
  isDisplayableUrl,
  normalizeAssetRefs,
  sanitizeContextName,
  sanitizeTitle,
} from "./paths";

const DB_NAME = "set";

const DB_VERSION = 3;
const STORE = "pages";
const ASSET_STORE = "assets";
const CONTEXT_STORE = "contexts";

interface PageRecord {
  id: PageId;
  parentId: PageId | null;
  title: string;
  context?: string;
  order?: number;
  createdAt: number;
  locked?: boolean;
  file: string;
  trashedAt?: number;
  trashedRoot?: true;
}

interface AssetRecord {
  key: string;
  blob: Blob;
}

interface ContextRecord {
  name: string;
  trashedAt?: number;
}

function contextOf(record: PageRecord): string {
  return record.context || DEFAULT_CONTEXT;
}

export class IndexedDbPageStore implements PageStore {
  private dbPromise: Promise<IDBDatabase> | undefined;

  private lastWritten = new Map<PageId, string>();

  private bodies: Map<PageId, IndexedBody> | undefined;

  private persistenceAsked = false;

  private async askToPersist(): Promise<void> {
    if (this.persistenceAsked) return;
    this.persistenceAsked = true;
    try {
      if (!navigator.storage?.persist) return;
      if (await navigator.storage.persisted()) return;
      await navigator.storage.persist();
    } catch {
      // persistence is a request the browser may simply decline
    }
  }

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) {
            req.result.createObjectStore(STORE, { keyPath: "id" });
          }
          if (!req.result.objectStoreNames.contains(ASSET_STORE)) {
            req.result.createObjectStore(ASSET_STORE, { keyPath: "key" });
          }
          if (!req.result.objectStoreNames.contains(CONTEXT_STORE)) {
            req.result.createObjectStore(CONTEXT_STORE, { keyPath: "name" });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.dbPromise;
  }

  private tx<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    return this.txIn(STORE, mode, run);
  }

  private async txIn<T>(
    name: string,
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.db();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(name, mode);
      const request = run(transaction.objectStore(name));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private records(): Promise<PageRecord[]> {
    return this.tx<PageRecord[]>("readonly", (s) => s.getAll());
  }

  /** Every page, and a lookup over the same array, which most callers want. */
  private async indexedRecords(): Promise<{
    records: PageRecord[];
    byId: Map<PageId, PageRecord>;
  }> {
    const records = await this.records();
    return { records, byId: new Map(records.map((r) => [r.id, r])) };
  }

  private record(id: PageId): Promise<PageRecord | undefined> {
    return this.tx<PageRecord | undefined>("readonly", (s) => s.get(id));
  }

  private putRecord(record: PageRecord): Promise<IDBValidKey> {
    return this.tx<IDBValidKey>("readwrite", (s) => s.put(record));
  }

  private contextRecords(): Promise<ContextRecord[]> {
    return this.txIn<ContextRecord[]>(CONTEXT_STORE, "readonly", (s) => s.getAll());
  }

  private putContextRecord(record: ContextRecord): Promise<IDBValidKey> {
    return this.txIn<IDBValidKey>(CONTEXT_STORE, "readwrite", (s) => s.put(record));
  }

  private forgetContextRecord(name: string): Promise<undefined> {
    return this.txIn<undefined>(
      CONTEXT_STORE,
      "readwrite",
      (s) => s.delete(name) as IDBRequest<undefined>,
    );
  }

  /** With the parent and order the caller is about to write, not the ones on disk. */
  private pageOf(
    record: PageRecord,
    where: { context?: string; parentId?: PageId | null; order?: number } = {},
  ): Page {
    const page = fileToPage(record.file, {
      id: record.id,
      title: record.title,
      parentId: record.parentId,
      context: where.context ?? contextOf(record),
    });
    // `order: undefined` is a caller clearing it.
    page.parentId = "parentId" in where ? (where.parentId ?? null) : record.parentId;
    page.order = "order" in where ? where.order : record.order;
    return page;
  }

  async list(): Promise<PageSummary[]> {
    const records = await this.records();
    return records
      .filter((r) => !r.trashedAt)
      .sort(bySiblingOrder)
      .map((r) => ({
        id: r.id,
        title: r.title,
        parentId: r.parentId,
        context: contextOf(r),
        createdAt: r.createdAt,
        locked: r.locked,
      }));
  }

  async listContexts(): Promise<Context[]> {
    const records = await this.records();
    const registered = await this.contextRecords();
    const counts = new Map<string, number>();

    for (const { name, trashedAt } of registered) if (!trashedAt) counts.set(name, 0);
    for (const record of records) {
      if (record.trashedAt) continue;
      const name = contextOf(record);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }

    if (counts.size === 0) counts.set(DEFAULT_CONTEXT, 0);
    return [...counts]
      .map(([name, pages]) => ({ name, pages }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async createContext(name: string): Promise<string> {
    const wanted = sanitizeContextName(name);
    if (!wanted) throw new Error(`"${name}" can't be a context name`);
    const taken = new Set((await this.listContexts()).map((c) => c.name));
    let free = wanted;
    for (let i = 2; taken.has(free); i++) free = `${wanted} ${i}`;

    await this.putContextRecord({ name: free });
    return free;
  }

  async renameContext(from: string, to: string): Promise<string> {
    const free = await this.createContext(to);
    const records = await this.records();

    for (const record of records) {
      if (contextOf(record) !== from) continue;
      record.context = free;
      await this.putRecord(record);
    }
    await this.forgetContextRecord(from);
    return free;
  }

  async deleteContext(name: string): Promise<void> {
    const records = await this.records();
    const now = Date.now();
    for (const record of records) {
      if (record.trashedAt || contextOf(record) !== name) continue;
      record.trashedAt = now;

      if (record.parentId === null) record.trashedRoot = true;
      this.lastWritten.delete(record.id);
      await this.putRecord(record);
    }

    await this.putContextRecord({ name, trashedAt: now });
  }

  async moveToContext(id: PageId, context: string): Promise<void> {
    const record = await this.record(id);
    if (!record || record.trashedAt || contextOf(record) === context) return;
    const records = await this.records();

    for (const id_ of subtreeIds(records, id)) {
      const node = records.find((r) => r.id === id_);
      if (!node || node.trashedAt) continue;
      const root = node.id === id;
      const page = this.pageOf(node, {
        context,
        parentId: root ? null : node.parentId,
        order: root ? undefined : node.order,
      });
      this.lastWritten.delete(node.id); // rewritten outside save()
      await this.put(page);
    }
  }

  async searchContent(
    query: string,
    limit: number,
    only?: readonly PageId[],
  ): Promise<ContentMatch[]> {
    const bodies = await this.bodyMap();
    const docs = only
      ? [...new Set(only)].flatMap((id) => bodies.get(id) ?? [])
      : bodies.values();
    return searchBodies(docs, query, limit);
  }

  async backlinks(title: string): Promise<PageId[]> {
    return backlinkIds(await this.indexedBodies(), title);
  }

  /** Built on the first question asked, not at startup; maintained by `put` and `forget`. */
  private async indexedBodies(): Promise<Iterable<IndexedBody>> {
    return (await this.bodyMap()).values();
  }

  private async bodyMap(): Promise<Map<PageId, IndexedBody>> {
    if (!this.bodies) {
      const records = await this.records();
      this.bodies = new Map(records.map((r) => [r.id, indexed(r)]));
    }
    return this.bodies;
  }

  async get(id: PageId): Promise<Page | null> {
    const record = await this.record(id);
    if (!record || record.trashedAt) return null;
    const page = this.pageOf(record);

    this.lastWritten.set(id, this.signatureOf(page, record));
    return page;
  }

  async changedOutside(_id: PageId): Promise<boolean> {
    return false;
  }

  private signatureOf(page: Page, record: PageRecord): string {
    return pageSignature(page, record.order, markdownBody(record.file));
  }

  async create(
    input: { title?: string; parentId?: PageId | null; context?: string } = {},
  ): Promise<Page> {
    const now = Date.now();
    const parentId = input.parentId ?? null;
    const parent = parentId ? await this.record(parentId) : undefined;
    const page: Page = {
      id: createId(),
      title: input.title ?? "",
      doc: emptyDoc(),
      parentId,
      context: parent ? contextOf(parent) : input.context || DEFAULT_CONTEXT,
      createdAt: now,
      updatedAt: now,
    };
    await this.put(page);
    return page;
  }

  async save(page: Page, body?: string): Promise<void> {
    const existing = await this.record(page.id);
    const markdown = body ?? docToMarkdown(page.doc);
    const signature = pageSignature(page, existing?.order, markdown);

    if (this.lastWritten.get(page.id) === signature) return;
    await this.put({ ...page, order: existing?.order, updatedAt: Date.now() }, markdown);
    this.lastWritten.set(page.id, signature);
  }

  async move(
    id: PageId,
    newParentId: PageId | null,
    orderedIds: PageId[],
  ): Promise<void> {
    const records = await this.records();
    const moved = records.find((r) => r.id === id);
    if (!moved || moved.trashedAt) return;

    const reparenting = moved.parentId !== newParentId;
    if (reparenting) {
      if (newParentId !== null && subtreeIds(records, id).has(newParentId)) return;
    }

    for (let i = 0; i < orderedIds.length; i++) {
      const record = records.find((r) => r.id === orderedIds[i]);
      if (!record || record.trashedAt) continue;
      const isMoved = record.id === id;
      const groupParent = isMoved ? newParentId : record.parentId;
      if (groupParent !== newParentId) continue;
      if (record.order === i && !isMoved) continue;

      const page = this.pageOf(record, {
        parentId: isMoved ? newParentId : record.parentId,
        order: i,
      });
      this.lastWritten.delete(record.id); // rewritten outside save()
      await this.put(page);
    }
  }

  async remove(id: PageId): Promise<void> {
    const records = await this.records();

    const subtree = subtreeIds(records, id);
    const now = Date.now();
    for (const record of records) {
      if (!subtree.has(record.id) || record.trashedAt) continue;
      record.trashedAt = now;
      if (record.id === id) record.trashedRoot = true;
      this.lastWritten.delete(record.id);
      await this.putRecord(record);
    }
  }

  async listTrash(): Promise<TrashEntry[]> {
    const records = await this.records();
    const registered = await this.contextRecords();
    const byId = new Map(records.map((r) => [r.id, r]));

    const live = new Set((await this.listContexts()).map((c) => c.name));

    const out: TrashEntry[] = [];
    const trashedContexts = new Set<string>();
    for (const context of registered) {
      if (!context.trashedAt || live.has(context.name)) continue;
      trashedContexts.add(context.name);
      out.push({
        kind: "context",
        name: context.name,
        pages: records.filter((r) => r.trashedAt && contextOf(r) === context.name).length,
        trashedAt: context.trashedAt,
      });
    }

    for (const record of records) {
      if (!isTrashRoot(record, byId)) continue;
      const context = contextOf(record);

      if (trashedContexts.has(context)) continue;
      out.push({
        kind: "page",
        id: record.id,
        title: record.title,
        trashedAt: record.trashedAt ?? 0,
        context,
        descendants: trashedUnder(records, byId, record.id).size - 1,
      });
    }
    return out.sort((a, b) => b.trashedAt - a.trashedAt);
  }

  async listTrashIn(entry: TrashRef): Promise<TrashedPage[]> {
    const { records, byId } = await this.indexedRecords();

    const inside = records.filter((r) => {
      if (!r.trashedAt) return false;
      return entry.kind === "context"
        ? contextOf(r) === entry.name && isTrashRoot(r, byId)
        : r.parentId === entry.id && !isTrashRoot(r, byId);
    });
    return inside.sort(bySiblingOrder).map((r) => ({
      kind: "page",
      id: r.id,
      title: r.title,
      trashedAt: r.trashedAt ?? 0,
      context: contextOf(r),
      descendants: trashedUnder(records, byId, r.id).size - 1,
    }));
  }

  async restore(id: PageId): Promise<PageId> {
    const { records, byId } = await this.indexedRecords();
    const record = byId.get(id);
    if (!record || !record.trashedAt) return id;

    const context = contextOf(record);
    for (const nodeId of trashedUnder(records, byId, id)) {
      const node = byId.get(nodeId);
      if (!node) continue;
      const root = node.id === id;
      const page = this.pageOf(node, {
        context,
        parentId: root ? null : node.parentId,
        order: root ? undefined : node.order,
      });
      this.lastWritten.delete(node.id); // this record was rewritten outside save()
      await this.put(page); // put() writes no trashedAt, so this clears the flag
    }
    return id; // keyed on id, this store can't hold two pages under one
  }

  async restoreContext(name: string): Promise<void> {
    const records = await this.records();
    const coming = new Set(
      records.filter((r) => r.trashedAt && contextOf(r) === name).map((r) => r.id),
    );
    const live = new Set(records.filter((r) => !r.trashedAt).map((r) => r.id));
    for (const record of records) {
      if (!coming.has(record.id)) continue;
      const keepsParent =
        record.parentId && (coming.has(record.parentId) || live.has(record.parentId));
      const page = this.pageOf(record, {
        context: name,
        parentId: keepsParent ? record.parentId : null,
      });
      this.lastWritten.delete(record.id);
      await this.put(page);
    }
    await this.putContextRecord({ name });
  }

  async deleteForever(id: PageId): Promise<void> {
    const { records, byId } = await this.indexedRecords();
    const record = byId.get(id);
    if (!record || !record.trashedAt) return;

    for (const nodeId of trashedUnder(records, byId, id)) {
      await this.forget(nodeId);
    }
  }

  async deleteContextForever(name: string): Promise<void> {
    const records = await this.records();
    for (const record of records) {
      if (!record.trashedAt || contextOf(record) !== name) continue;
      await this.forget(record.id);
    }
    await this.forgetContextRecord(name);
  }

  async clearTrash(): Promise<void> {
    const records = await this.records();
    for (const record of records) {
      if (record.trashedAt == null) continue;
      await this.forget(record.id);
    }
    const registered = await this.contextRecords();
    for (const context of registered) {
      if (!context.trashedAt) continue;
      await this.forgetContextRecord(context.name);
    }
  }

  private async forget(id: PageId): Promise<void> {
    await this.tx<undefined>("readwrite", (s) => s.delete(id) as IDBRequest<undefined>);

    this.bodies?.delete(id);
    this.lastWritten.delete(id);
  }

  async putAsset(pageId: PageId, bytes: Uint8Array, kind: StoredAsset): Promise<string> {
    const record = await this.record(pageId);
    if (!record) throw new Error(`can't store an image for unknown page ${pageId}`);
    const fileName = `${createId()}.${kind.ext}`;

    const blob = new Blob([bytes.slice()], { type: kind.type });
    await this.txIn<IDBValidKey>(ASSET_STORE, "readwrite", (s) =>
      s.put({ key: assetKey(pageId, fileName), blob } satisfies AssetRecord),
    );
    return assetRef(sanitizeTitle(record.title), fileName);
  }

  async assetUrl(pageId: PageId, ref: string): Promise<string | null> {
    const name = assetFileName(ref);

    if (!name) return isDisplayableUrl(ref) ? ref : null;
    const record = await this.txIn<AssetRecord | undefined>(
      ASSET_STORE,
      "readonly",
      (s) => s.get(assetKey(pageId, name)),
    );
    return record ? URL.createObjectURL(record.blob) : null;
  }

  async copyAsset(fromId: PageId, toId: PageId, ref: string): Promise<string | null> {
    const name = assetFileName(ref);
    if (!name) return null; // a URL, not a blob of ours
    const to = await this.record(toId);
    if (!to) return null;

    const asset = await this.txIn<AssetRecord | undefined>(ASSET_STORE, "readonly", (s) =>
      s.get(assetKey(fromId, name)),
    );
    if (!asset) return null;

    await this.txIn<IDBValidKey>(ASSET_STORE, "readwrite", (s) =>
      s.put({ key: assetKey(toId, name), blob: asset.blob } satisfies AssetRecord),
    );
    return assetRef(sanitizeTitle(to.title), name);
  }

  private async put(page: Page, body?: string): Promise<void> {
    void this.askToPersist();
    const record: PageRecord = {
      id: page.id,
      parentId: page.parentId,
      title: page.title,
      context: page.context,
      order: page.order,
      ...(page.locked ? { locked: true } : {}),
      createdAt: page.createdAt,
      file: normalizeAssetRefs(pageToFile(page, body), sanitizeTitle(page.title)),
    };
    await this.putRecord(record);

    this.bodies?.set(record.id, indexed(record));
  }
}

function indexed(record: PageRecord): IndexedBody {
  const body = markdownBody(record.file);
  return { id: record.id, body, fold: foldAscii(body) };
}

function assetKey(pageId: PageId, fileName: string): string {
  return `${pageId}/${fileName}`;
}

function isTrashRoot(record: PageRecord, byId: Map<PageId, PageRecord>): boolean {
  if (!record.trashedAt) return false;
  if (record.trashedRoot) return true;
  const parent = record.parentId ? byId.get(record.parentId) : undefined;
  return !parent?.trashedAt;
}

function trashedUnder(
  records: PageRecord[],
  byId: Map<PageId, PageRecord>,
  rootId: PageId,
): Set<PageId> {
  const ids = new Set<PageId>([rootId]);
  for (let added = true; added;) {
    added = false;
    for (const r of records) {
      if (ids.has(r.id) || !r.trashedAt || r.parentId == null) continue;
      if (!ids.has(r.parentId) || isTrashRoot(r, byId)) continue;
      ids.add(r.id);
      added = true;
    }
  }
  return ids;
}
