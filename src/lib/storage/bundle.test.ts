import { describe, expect, it } from "vitest";

import type {
  Context,
  Page,
  PageId,
  PageSummary,
  TrashEntry,
  TrashedPage,
} from "$lib/types";
import type { ContentMatch, PageStore, StoredAsset } from "./store";
import { composeFile } from "./frontmatter";
import { applyImportBundle, type ExportBundle, type ExportedPage } from "./bundle";

interface StoredPage {
  page: Page;
  body: string;
}

class FakePageStore implements PageStore {
  pages = new Map<PageId, StoredPage>();
  assets = new Map<string, { bytes: Uint8Array; kind: StoredAsset }>();

  contexts: string[] = ["Set"];
  private seq = 0;

  async list(): Promise<PageSummary[]> {
    return [...this.pages.values()].map(({ page }) => ({
      id: page.id,
      title: page.title,
      parentId: page.parentId,
      context: page.context,
      createdAt: page.createdAt,
      locked: page.locked,
    }));
  }

  async listContexts(): Promise<Context[]> {
    return this.contexts.map((name) => ({
      name,
      pages: [...this.pages.values()].filter(({ page }) => page.context === name).length,
    }));
  }

  async createContext(name: string): Promise<string> {
    let free = name;
    for (let i = 2; this.contexts.includes(free); i++) free = `${name} ${i}`;
    this.contexts.push(free);
    return free;
  }

  async renameContext(from: string, to: string): Promise<string> {
    this.contexts = this.contexts.map((c) => (c === from ? to : c));
    for (const { page } of this.pages.values()) {
      if (page.context === from) page.context = to;
    }
    return to;
  }

  async deleteContext(name: string): Promise<void> {
    this.contexts = this.contexts.filter((c) => c !== name);
  }

  async moveToContext(id: PageId, context: string): Promise<void> {
    const stored = this.pages.get(id);
    if (!stored) return;
    stored.page.context = context;
    stored.page.parentId = null;
  }

  async searchContent(): Promise<ContentMatch[]> {
    return [];
  }

  async backlinks(): Promise<PageId[]> {
    return [];
  }

  async get(id: PageId): Promise<Page | null> {
    return this.pages.get(id)?.page ?? null;
  }

  async changedOutside(): Promise<boolean> {
    return false;
  }

  async create(input: {
    title?: string;
    parentId?: PageId | null;
    context?: string;
  }): Promise<Page> {
    this.seq += 1;
    const parentId = input.parentId ?? null;
    const page: Page = {
      id: `new-${this.seq}`,
      title: input.title ?? "",
      doc: { type: "doc" },
      parentId,
      context:
        (parentId ? this.pages.get(parentId)?.page.context : input.context) ?? "Set",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    };
    this.pages.set(page.id, { page, body: "" });
    return page;
  }

  async save(page: Page, body = ""): Promise<void> {
    const stored = this.pages.get(page.id);
    if (!stored) throw new Error(`unknown page ${page.id}`);
    // Like the real stores, a page keeps the place it was given, whatever the
    // copy being saved says.
    this.pages.set(page.id, { page: { ...page, order: stored.page.order }, body });
  }

  async move(
    _id: PageId,
    newParentId: PageId | null,
    orderedIds: PageId[],
  ): Promise<void> {
    orderedIds.forEach((id, i) => {
      const stored = this.pages.get(id);
      if (stored && stored.page.parentId === newParentId) stored.page.order = i;
    });
  }
  async remove(): Promise<void> {}
  async listTrash(): Promise<TrashEntry[]> {
    return [];
  }
  async listTrashIn(): Promise<TrashedPage[]> {
    return [];
  }
  async restore(id: string): Promise<string> {
    return id;
  }
  async restoreContext(): Promise<void> {}
  async deleteForever(): Promise<void> {}
  async deleteContextForever(): Promise<void> {}
  async clearTrash(): Promise<void> {}

  async putAsset(pageId: PageId, bytes: Uint8Array, kind: StoredAsset): Promise<string> {
    this.seq += 1;
    const fileName = `asset-${this.seq}.${kind.ext}`;
    this.assets.set(`${pageId}/${fileName}`, { bytes, kind });
    return `_/Set-page-assets/${fileName}`;
  }

  async assetUrl(): Promise<string | null> {
    return null;
  }

  async copyAsset(fromId: PageId, toId: PageId, ref: string): Promise<string | null> {
    const fileName = ref.split("/").pop()!;
    const held = this.assets.get(`${fromId}/${fileName}`);
    if (!held) return null;
    this.assets.set(`${toId}/${fileName}`, held);
    return `_/Set-page-assets/${fileName}`;
  }
}

function exported(
  id: PageId,
  title: string,
  parentId: PageId | null,
  opts: {
    body?: string;
    locked?: boolean;
    assets?: ExportedPage["assets"];
    context?: string;
    order?: number;
  } = {},
): ExportedPage {
  const page: Page = {
    id,
    title,
    doc: { type: "doc" },
    parentId,
    context: opts.context ?? "Set",
    locked: opts.locked,
    order: opts.order,
    createdAt: 1_600_000_000_000,
    updatedAt: 1_600_000_000_000,
  };
  return {
    file: composeFile(page, opts.body ?? ""),
    assets: opts.assets ?? [],
    ...(opts.context ? { context: opts.context } : {}),
  };
}

function bundle(pages: ExportedPage[]): ExportBundle {
  return { version: 2, exportedAt: Date.now(), pages };
}

describe("applyImportBundle", () => {
  it("recreates every page and reports how many landed", async () => {
    const store = new FakePageStore();
    const result = await applyImportBundle(
      store,
      bundle([exported("a", "Alpha", null), exported("b", "Beta", null)]),
    );
    expect(result).toEqual({ imported: 2, failed: 0 });
    expect([...store.pages.values()].map((p) => p.page.title).sort()).toEqual([
      "Alpha",
      "Beta",
    ]);
  });

  it("remaps parentId to the newly created ids, regardless of export order", async () => {
    const store = new FakePageStore();

    await applyImportBundle(
      store,
      bundle([exported("child", "Child", "parent"), exported("parent", "Parent", null)]),
    );
    const parent = [...store.pages.values()].find((p) => p.page.title === "Parent")!;
    const child = [...store.pages.values()].find((p) => p.page.title === "Child")!;
    expect(child.page.parentId).toBe(parent.page.id);
  });

  it("lands an orphaned page (its parent missing from the bundle) at the top level", async () => {
    const store = new FakePageStore();
    const result = await applyImportBundle(
      store,
      bundle([exported("child", "Child", "no-such-parent")]),
    );
    expect(result).toEqual({ imported: 1, failed: 0 });
    const child = [...store.pages.values()][0];
    expect(child.page.parentId).toBeNull();
  });

  it("carries the locked flag over", async () => {
    const store = new FakePageStore();
    await applyImportBundle(
      store,
      bundle([exported("a", "Locked", null, { locked: true })]),
    );
    expect([...store.pages.values()][0].page.locked).toBe(true);
  });

  it("copies each asset and rewrites the body to the new filename", async () => {
    const store = new FakePageStore();
    await applyImportBundle(
      store,
      bundle([
        exported("a", "With image", null, {
          body: "![](A/Set-page-assets/old.png)",
          assets: [
            { fileName: "old.png", ext: "png", type: "image/png", dataBase64: "AA==" },
          ],
        }),
      ]),
    );
    const stored = [...store.pages.values()][0];
    expect(stored.body).not.toContain("old.png");
    expect(stored.body).toMatch(/Set-page-assets\/asset-\d+\.png/);
    expect(store.assets.size).toBe(1);
  });

  it("points sub-page links at the new ids, leaving links to anything else alone", async () => {
    const store = new FakePageStore();
    await applyImportBundle(
      store,
      bundle([
        exported("parent", "Parent", null, {
          body: "[Child](page:child)\n\n[Gone](page:not-in-the-file)",
        }),
        exported("child", "Child", "parent"),
      ]),
    );

    const parent = [...store.pages.values()].find((p) => p.page.title === "Parent")!;
    const child = [...store.pages.values()].find((p) => p.page.title === "Child")!;
    expect(parent.body.trimEnd()).toBe(
      `[Child](page:${child.page.id})\n\n[Gone](page:not-in-the-file)`,
    );
  });

  it("puts sub-pages back in the order they were exported in", async () => {
    const store = new FakePageStore();
    await applyImportBundle(
      store,
      bundle([
        exported("parent", "Parent", null),
        exported("c", "Third", "parent", { order: 2 }),
        exported("a", "First", "parent", { order: 0 }),
        exported("b", "Second", "parent", { order: 1 }),
      ]),
    );

    const children = [...store.pages.values()]
      .filter((p) => p.page.parentId !== null)
      .sort((x, y) => (x.page.order ?? 0) - (y.page.order ?? 0))
      .map((p) => p.page.title);
    expect(children).toEqual(["First", "Second", "Third"]);
  });

  it("counts a failed page without losing the ones around it", async () => {
    const store = new FakePageStore();
    const failing = store.create.bind(store);
    let calls = 0;
    store.create = async (input) => {
      calls += 1;
      if (calls === 2) throw new Error("disk full");
      return failing(input);
    };
    const result = await applyImportBundle(
      store,
      bundle([
        exported("a", "First", null),
        exported("b", "Second", null),
        exported("c", "Third", null),
      ]),
    );
    expect(result).toEqual({ imported: 2, failed: 1 });
  });
});

describe("applyImportBundle: contexts", () => {
  it("imports into the context each page names, creating what's missing", async () => {
    const store = new FakePageStore();
    const result = await applyImportBundle(
      store,
      bundle([
        exported("a", "Standups", null, { context: "Work" }),
        exported("b", "Recipes", null, { context: "Personal" }),
      ]),
    );

    expect(result).toEqual({ imported: 2, failed: 0 });
    expect(store.contexts.sort()).toEqual(["Personal", "Set", "Work"]);
    expect(contextsByTitle(store)).toEqual(
      new Map([
        ["Standups", "Work"],
        ["Recipes", "Personal"],
      ]),
    );
  });

  it("merges into a context the notes folder already has, rather than suffixing one", async () => {
    const store = new FakePageStore();
    store.contexts = ["Set", "Work"];

    await applyImportBundle(
      store,
      bundle([exported("a", "Standups", null, { context: "Work" })]),
    );

    expect(store.contexts).toEqual(["Set", "Work"]);
    expect(contextsByTitle(store)).toEqual(new Map([["Standups", "Work"]]));
  });

  it("keeps a child in its parent's context, whatever the entry says", async () => {
    const store = new FakePageStore();
    await applyImportBundle(
      store,
      bundle([
        exported("a", "Standups", null, { context: "Work" }),
        exported("b", "Monday", "a", { context: "Personal" }),
      ]),
    );

    expect(contextsByTitle(store).get("Monday")).toBe("Work");
  });

  it("puts a version 1 bundle's pages in the default context", async () => {
    const store = new FakePageStore();
    const v1: ExportBundle = {
      version: 1,
      exportedAt: Date.now(),
      pages: [exported("a", "Standups", null)].map(({ file, assets }) => ({
        file,
        assets,
      })),
    };

    const result = await applyImportBundle(store, v1);

    expect(result).toEqual({ imported: 1, failed: 0 });
    expect(contextsByTitle(store).get("Standups")).toBe("Set");
    expect(store.contexts).toEqual(["Set"]);
  });
});

function contextsByTitle(store: FakePageStore): Map<string, string> {
  return new Map([...store.pages.values()].map(({ page }) => [page.title, page.context]));
}
