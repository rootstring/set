import { type Page } from "@playwright/test";

/**
 * What a page looks like on screen and what is stored are two claims; most of these tests make the
 * second.
 */

const DB_NAME = "set";

/** Matches `DB_VERSION` in `src/lib/storage/indexeddb-store.ts`. */
const DB_VERSION = 3;

const STORES = [
  ["pages", "id"],
  ["assets", "key"],
  ["contexts", "name"],
] as const;

export interface SeedPage {
  id: string;
  title: string;
  parentId?: string | null;
  context?: string;
  body?: string;
  order?: number;
}

export interface StoredPage {
  id: string;
  title: string;
  parentId: string | null;
  context?: string;
  order?: number;
  createdAt: number;
  file: string;
  trashedAt?: number;
}

export interface SeedOptions {
  /** Contexts to register, for the specs whose pages are spread across them. */
  contexts?: string[];
  /** Off for a spec adding to what is already there rather than replacing it. */
  clear?: boolean;
}

/** Timestamps are fixed and ascending, so sidebar order is listing order. */
export async function putPages(
  page: Page,
  pages: SeedPage[],
  opts: SeedOptions = {},
): Promise<void> {
  await page.evaluate(
    async ({ seed, contexts, clear, dbName, version, stores }) => {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, version);
        req.onupgradeneeded = () => {
          for (const [name, keyPath] of stores) {
            if (!req.result.objectStoreNames.contains(name)) {
              req.result.createObjectStore(name, { keyPath });
            }
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      const tx = db.transaction(["pages", "contexts"], "readwrite");
      const pageStore = tx.objectStore("pages");
      const contextStore = tx.objectStore("contexts");
      if (clear) {
        pageStore.clear();
        contextStore.clear();
      }
      for (const name of contexts) contextStore.put({ name });

      seed.forEach((p, i) => {
        const ts = 1700000000000 + i;
        const parentId = p.parentId ?? null;
        const file =
          `---\nid: ${JSON.stringify(p.id)}\ntitle: ${JSON.stringify(p.title)}\n` +
          `parentId: ${JSON.stringify(parentId)}\ncreatedAt: ${ts}\nupdatedAt: ${ts}\n` +
          `---\n\n${p.body ?? ""}\n`;
        pageStore.put({
          id: p.id,
          parentId,
          title: p.title,
          createdAt: ts,
          file,
          ...(p.context === undefined ? {} : { context: p.context }),
          ...(p.order === undefined ? {} : { order: p.order }),
        });
      });

      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    {
      seed: pages,
      contexts: opts.contexts ?? [],
      clear: opts.clear ?? true,
      dbName: DB_NAME,
      version: DB_VERSION,
      stores: STORES as unknown as [string, string][],
    },
  );
}

/** Every page record, trashed ones included. */
export async function storedPages(page: Page): Promise<StoredPage[]> {
  return page.evaluate(async (dbName) => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const rows: StoredPage[] = await new Promise((resolve, reject) => {
      const req = db.transaction("pages").objectStore("pages").getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return rows;
  }, DB_NAME);
}

/** The ones still in the tree, in the order the sidebar puts them. */
export async function livePages(page: Page): Promise<StoredPage[]> {
  const rows = await storedPages(page);
  return rows
    .filter((r) => !r.trashedAt)
    .sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt));
}

/** Every stored note, joined: what the whole of storage holds, as text. */
export async function storedFiles(page: Page): Promise<string> {
  return (await storedPages(page)).map((r) => r.file).join("\n");
}

/** A note's Markdown, frontmatter off and trailing blank lines trimmed. */
export function bodyOf(file: string): string {
  return file.replace(/^---\n[\s\S]*?\n---\n\n?/, "").replace(/\n+$/, "");
}

/** The body of the one note a single-page spec has written. */
export async function storedBody(page: Page): Promise<string> {
  return bodyOf(await storedFiles(page));
}

/** Take pages out from under the app, as something outside it would. */
export async function removePages(page: Page, ids: string[]): Promise<void> {
  await page.evaluate(
    async ({ ids, dbName }) => {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const tx = db.transaction("pages", "readwrite");
      for (const id of ids) tx.objectStore("pages").delete(id);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { ids, dbName: DB_NAME },
  );
}
