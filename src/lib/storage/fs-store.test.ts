import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string | null>();

const isDir = (p: string) => files.get(p) === null;
const parentPath = (p: string) => p.slice(0, p.lastIndexOf("/"));

function mkdirp(path: string): void {
  const parts = path.split("/");
  for (let i = 2; i <= parts.length; i++) {
    const p = parts.slice(0, i).join("/");
    if (!files.has(p)) files.set(p, null);
  }
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("no native shell");
  }),
  convertFileSrc: (p: string) => `asset://${p}`,
  isTauri: () => false,
}));

vi.mock("./markdown", () => ({
  docToMarkdown: (doc: { content?: { text?: string }[] }) => doc.content?.[0]?.text ?? "",
  markdownToDoc: (md: string) => ({ type: "doc", content: [{ type: "raw", text: md }] }),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  async exists(path: string) {
    return files.has(path);
  },
  async mkdir(path: string) {
    mkdirp(path);
  },
  async readDir(path: string) {
    if (!files.has(path)) throw new Error(`ENOENT ${path}`);
    const out: { name: string; isFile: boolean; isDirectory: boolean }[] = [];
    for (const [p, v] of files) {
      if (parentPath(p) !== path || p === path) continue;
      out.push({
        name: p.slice(path.length + 1),
        isFile: v !== null,
        isDirectory: v === null,
      });
    }
    return out;
  },
  async readTextFile(path: string) {
    const v = files.get(path);
    if (typeof v !== "string") throw new Error(`ENOENT ${path}`);
    return v;
  },
  async writeTextFile(path: string, contents: string) {
    mkdirp(parentPath(path));
    files.set(path, contents);
  },
  async writeFile(path: string, bytes: Uint8Array) {
    mkdirp(parentPath(path));
    files.set(path, `<${bytes.length} bytes>`);
  },
  async rename(from: string, to: string) {
    if (!files.has(from)) throw new Error(`ENOENT ${from}`);
    mkdirp(parentPath(to));

    for (const [p, v] of [...files]) {
      if (p !== from && !p.startsWith(`${from}/`)) continue;
      files.delete(p);
      files.set(to + p.slice(from.length), v);
    }
  },
  async remove(path: string, opts?: { recursive?: boolean }) {
    if (!files.has(path)) throw new Error(`ENOENT ${path}`);
    if (opts?.recursive) {
      for (const p of [...files.keys()]) {
        if (p === path || p.startsWith(`${path}/`)) files.delete(p);
      }
    } else {
      files.delete(path);
    }
  },
  async copyFile(from: string, to: string) {
    mkdirp(parentPath(to));
    files.set(to, files.get(from) ?? "");
  },
  async stat(path: string) {
    if (!files.has(path)) throw new Error(`ENOENT ${path}`);
    return { size: (files.get(path) ?? "").length };
  },
}));

const { FsPageStore } = await import("./fs-store");
const { ChangedOnDiskError } = await import("./store");
const { invoke } = await import("@tauri-apps/api/core");

const ROOT = "/notes";

const CTX = "Set";
const CTX_ROOT = `${ROOT}/${CTX}`;

function pageFile(
  p: { rel: string; id: string; title: string; order?: number },
  ts: number,
): string {
  const order = p.order === undefined ? "" : `order: ${p.order}\n`;
  return (
    `---\nid: ${JSON.stringify(p.id)}\ntitle: ${JSON.stringify(p.title)}\n` +
    `${order}createdAt: ${ts}\nupdatedAt: ${ts}\n---\n\nbody of ${p.title}\n`
  );
}

function seed(pages: { rel: string; id: string; title: string; order?: number }[]): void {
  seedAt(CTX_ROOT, pages);
}

function seedAt(
  dir: string,
  pages: { rel: string; id: string; title: string; order?: number }[],
): void {
  files.clear();
  mkdirp(dir);
  pages.forEach((p, i) => {
    const abs = `${dir}/${p.rel}.md`;
    mkdirp(abs.slice(0, abs.lastIndexOf("/")));
    files.set(abs, pageFile(p, 1700000000000 + i));
  });
}

type Store = InstanceType<typeof FsPageStore>;

/** Seed a notes folder and open a store on it — how most of these start. */
async function storeOn(pages: Parameters<typeof seed>[0]): Promise<Store> {
  return storeOnAt(CTX_ROOT, pages);
}

async function storeOnAt(dir: string, pages: Parameters<typeof seed>[0]): Promise<Store> {
  seedAt(dir, pages);
  const fresh = new FsPageStore(ROOT);
  await fresh.init();
  return fresh;
}

async function treeOf(store: Store): Promise<string[]> {
  const pages = await store.list();
  const out: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const p of pages.filter((x) => x.parentId === parent)) {
      out.push(`${"  ".repeat(depth)}${p.title}`);
      walk(p.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

async function treeOnDisk(): Promise<string[]> {
  const fresh = new FsPageStore(ROOT);
  await fresh.init();
  return treeOf(fresh);
}

function paths(): string[] {
  return pathsUnder(CTX_ROOT);
}

function pathsUnder(dir: string): string[] {
  return [...files]
    .filter(([p, v]) => v !== null && p.endsWith(".md") && p.startsWith(`${dir}/`))
    .map(([p]) => p.slice(dir.length + 1))
    .sort();
}

let store: InstanceType<typeof FsPageStore>;

async function open(): Promise<void> {
  store = await storeOn([
    { rel: "Work", id: "work", title: "Work" },
    { rel: "Work/Alpha", id: "alpha", title: "Alpha" },
    { rel: "Work/Alpha/Deep", id: "deep", title: "Deep" },
    { rel: "Work/Beta", id: "beta", title: "Beta" },
    { rel: "Work/Gamma", id: "gamma", title: "Gamma" },
    { rel: "Personal", id: "personal", title: "Personal" },
    { rel: "Notes", id: "notes", title: "Notes" },
  ]);
}

async function group(
  parent: string | null,
  moved: string,
  at: number,
): Promise<string[]> {
  const ids = (await store.list())
    .filter((p) => p.parentId === parent && p.id !== moved)
    .map((p) => p.id);
  ids.splice(at, 0, moved);
  return ids;
}

beforeEach(open);

describe("move", () => {
  it("nests a page under a sibling, on disk and in the index", async () => {
    await store.move("gamma", "beta", await group("beta", "gamma", 0));

    const expected = [
      "Work",
      "  Alpha",
      "    Deep",
      "  Beta",
      "    Gamma",
      "Personal",
      "Notes",
    ];
    expect(await treeOf(store)).toEqual(expected);
    expect(await treeOnDisk()).toEqual(expected);
    expect(paths()).toContain("Work/Beta/Gamma.md");
  });

  it("carries the moved page's whole subtree with it", async () => {
    await store.move("alpha", "gamma", await group("gamma", "alpha", 0));

    const expected = [
      "Work",
      "  Beta",
      "  Gamma",
      "    Alpha",
      "      Deep",
      "Personal",
      "Notes",
    ];
    expect(await treeOf(store)).toEqual(expected);
    expect(await treeOnDisk()).toEqual(expected);
    expect(paths()).toContain("Work/Gamma/Alpha/Deep.md");
  });

  it("pulls a child back out to the top level", async () => {
    await store.move("beta", null, await group(null, "beta", 1));

    const expected = [
      "Work",
      "  Alpha",
      "    Deep",
      "  Gamma",
      "Beta",
      "Personal",
      "Notes",
    ];
    expect(await treeOf(store)).toEqual(expected);
    expect(await treeOnDisk()).toEqual(expected);
  });

  it("reorders a sibling group without touching parentage", async () => {
    await store.move("gamma", "work", await group("work", "gamma", 0));

    const expected = [
      "Work",
      "  Gamma",
      "  Alpha",
      "    Deep",
      "  Beta",
      "Personal",
      "Notes",
    ];
    expect(await treeOf(store)).toEqual(expected);
    expect(await treeOnDisk()).toEqual(expected);
  });

  it("refuses to move a page into its own subtree", async () => {
    const before = await treeOf(store);
    await store.move("alpha", "deep", ["alpha"]);
    expect(await treeOf(store)).toEqual(before);
    expect(await treeOnDisk()).toEqual(before);
  });

  it("keeps the destination group's order when a page arrives in the middle", async () => {
    await store.move("notes", "work", await group("work", "notes", 1));

    const expected = [
      "Work",
      "  Alpha",
      "    Deep",
      "  Notes",
      "  Beta",
      "  Gamma",
      "Personal",
    ];
    expect(await treeOf(store)).toEqual(expected);
    expect(await treeOnDisk()).toEqual(expected);
  });

  it("moves a page whose title collides with one already in the destination", async () => {
    seed([
      { rel: "Work", id: "work", title: "Work" },
      { rel: "Work/Notes", id: "inner", title: "Notes" },
      { rel: "Notes", id: "outer", title: "Notes" },
    ]);
    store = new FsPageStore(ROOT);
    await store.init();

    await store.move("outer", "work", await group("work", "outer", 1));

    expect(await treeOf(store)).toEqual(["Work", "  Notes", "  Notes"]);
    expect(await treeOnDisk()).toEqual(["Work", "  Notes", "  Notes"]);
    expect(paths()).toEqual(["Work.md", "Work/Notes 2.md", "Work/Notes.md"]);
  });

  it("leaves a re-parented page's images reachable", async () => {
    mkdirp(`${CTX_ROOT}/Work/Gamma/Set-page-assets`);
    files.set(`${CTX_ROOT}/Work/Gamma/Set-page-assets/pic.png`, "<bytes>");
    files.set(
      `${CTX_ROOT}/Work/Gamma.md`,
      (files.get(`${CTX_ROOT}/Work/Gamma.md`) as string) +
        "\n![](Gamma/Set-page-assets/pic.png)\n",
    );
    store = new FsPageStore(ROOT);
    await store.init();

    await store.move("gamma", "personal", ["gamma"]);

    expect(paths()).toContain("Personal/Gamma.md");
    expect(files.has(`${CTX_ROOT}/Personal/Gamma/Set-page-assets/pic.png`)).toBe(true);
    const body = files.get(`${CTX_ROOT}/Personal/Gamma.md`) as string;
    expect(body).toContain("Gamma/Set-page-assets/pic.png");
  });
});

describe("contexts", () => {
  it("derives a page's context from the folder it sits in", async () => {
    store = await storeOnAt(ROOT, [
      { rel: "Work/Standups", id: "s", title: "Standups" },
      { rel: "Work/Standups/Monday", id: "m", title: "Monday" },
      { rel: "Personal/Recipes", id: "r", title: "Recipes" },
    ]);

    const pages = await store.list();
    expect(byId(pages, "s").context).toBe("Work");

    expect(byId(pages, "m").context).toBe("Work");
    expect(byId(pages, "r").context).toBe("Personal");
    expect(await store.listContexts()).toEqual([
      { name: "Personal", pages: 1 },
      { name: "Work", pages: 2 },
    ]);
  });

  it("adopts pages left at the notes root into the default context", async () => {
    store = await storeOnAt(ROOT, [
      { rel: "Ideas", id: "i", title: "Ideas" },
      { rel: "Ideas/Later", id: "l", title: "Later" },
    ]);

    expect(pathsUnder(ROOT)).toEqual(["Set/Ideas.md", "Set/Ideas/Later.md"]);
    expect(await treeOf(store)).toEqual(["Ideas", "  Later"]);
    expect(store.migrated).toBe(1);
    expect((await store.list()).every((p) => p.context === "Set")).toBe(true);
  });

  it("adopts a loose page without displacing one already in the context", async () => {
    store = await storeOnAt(ROOT, [
      { rel: "Set/Ideas", id: "kept", title: "Ideas" },
      { rel: "Ideas", id: "loose", title: "Ideas" },
    ]);

    expect(pathsUnder(ROOT).sort()).toEqual(["Set/Ideas 2.md", "Set/Ideas.md"]);

    expect((await store.list()).map((p) => p.id).sort()).toEqual(["kept", "loose"]);
  });

  it("leaves an existing context alone and starts an empty notes folder with one", async () => {
    files.clear();
    mkdirp(ROOT);
    store = new FsPageStore(ROOT);
    await store.init();

    expect(store.migrated).toBe(0);
    expect(await store.listContexts()).toEqual([{ name: "Set", pages: 0 }]);
  });

  it("creates a page at the top of the context it's told to", async () => {
    store = await storeOnAt(ROOT, [{ rel: "Work/Standups", id: "s", title: "Standups" }]);
    await store.createContext("Personal");

    const page = await store.create({ title: "Recipes", context: "Personal" });
    expect(page.context).toBe("Personal");
    expect(pathsUnder(ROOT)).toContain("Personal/Recipes.md");

    const child = await store.create({
      title: "Monday",
      parentId: "s",
      context: "Personal",
    });
    expect(child.context).toBe("Work");
    expect(pathsUnder(ROOT)).toContain("Work/Standups/Monday.md");
  });

  it("renames a context without rewriting a single page", async () => {
    store = await storeOnAt(ROOT, [{ rel: "Work/Standups", id: "s", title: "Standups" }]);
    const before = files.get(`${ROOT}/Work/Standups.md`);

    expect(await store.renameContext("Work", "Job")).toBe("Job");

    expect(pathsUnder(ROOT)).toEqual(["Job/Standups.md"]);
    expect(byId(await store.list(), "s").context).toBe("Job");

    expect(files.get(`${ROOT}/Job/Standups.md`)).toBe(before);

    expect(byId(await (await freshStore()).list(), "s").context).toBe("Job");
  });

  it("moves a deleted context, and everything in it, to the trash", async () => {
    store = await storeOnAt(ROOT, [
      { rel: "Work/Standups", id: "s", title: "Standups" },
      { rel: "Work/Standups/Monday", id: "m", title: "Monday" },
      { rel: "Personal/Recipes", id: "r", title: "Personal note" },
    ]);

    await store.deleteContext("Work");

    expect((await store.listContexts()).map((c) => c.name)).toEqual(["Personal"]);
    expect(pathsUnder(ROOT)).toEqual([
      "Personal/Recipes.md",
      "Set-Trash/Work/Standups.md",
      "Set-Trash/Work/Standups/Monday.md",
    ]);
    expect(files.has(`${ROOT}/Work`)).toBe(false);
    expect((await store.list()).map((p) => p.id)).toEqual(["r"]);
  });

  it("deletes an emptied context", async () => {
    store = await storeOnAt(ROOT, [{ rel: "Work/Standups", id: "s", title: "Standups" }]);
    await store.createContext("Personal");

    await store.deleteContext("Personal");
    expect((await store.listContexts()).map((c) => c.name)).toEqual(["Work"]);

    expect(await store.listTrash()).toEqual([
      { kind: "context", name: "Personal", pages: 0, trashedAt: 0 },
    ]);
  });

  it("moves a page and its subtree to another context, at the top", async () => {
    store = await storeOnAt(ROOT, [
      { rel: "Work/Standups", id: "s", title: "Standups" },
      { rel: "Work/Standups/Monday", id: "m", title: "Monday" },
      { rel: "Personal/Recipes", id: "r", title: "Recipes" },
    ]);

    await store.move("s", "r", ["s"]);

    await store.moveToContext("s", "Work");

    const pages = await store.list();
    expect(byId(pages, "s").context).toBe("Work");
    expect(byId(pages, "s").parentId).toBe(null);

    expect(byId(pages, "m").context).toBe("Work");
    expect(byId(pages, "m").parentId).toBe("s");
    expect(pathsUnder(ROOT).sort()).toEqual([
      "Personal/Recipes.md",
      "Work/Standups.md",
      "Work/Standups/Monday.md",
    ]);

    expect(await treeOf(await freshStore())).toEqual(["Standups", "  Monday", "Recipes"]);
  });

  it("keeps a moved page's images with it", async () => {
    seedAt(ROOT, [{ rel: "Work/Standups", id: "s", title: "Standups" }]);
    mkdirp(`${ROOT}/Work/Standups/Set-page-assets`);
    files.set(`${ROOT}/Work/Standups/Set-page-assets/pic.png`, "<bytes>");
    files.set(
      `${ROOT}/Work/Standups.md`,
      `${files.get(`${ROOT}/Work/Standups.md`)}\n![](Standups/Set-page-assets/pic.png)\n`,
    );
    store = new FsPageStore(ROOT);
    await store.init();
    await store.createContext("Personal");

    await store.moveToContext("s", "Personal");

    expect(files.has(`${ROOT}/Personal/Standups/Set-page-assets/pic.png`)).toBe(true);
    expect(files.has(`${ROOT}/Work/Standups/Set-page-assets/pic.png`)).toBe(false);
  });
});

describe("trash, laid out like the notes folder", () => {
  it("files a deleted page under the context it came from", async () => {
    store = await storeOnAt(ROOT, [
      { rel: "Work/Standups", id: "s", title: "Standups" },
      { rel: "Personal/Recipes", id: "r", title: "Recipes" },
    ]);

    await store.remove("s");
    await store.remove("r");

    expect(pathsUnder(ROOT).sort()).toEqual([
      "Personal/Set-Trash/Recipes.md",
      "Work/Set-Trash/Standups.md",
    ]);
    const trash = await store.listTrash();
    expect(
      new Map(trash.map((t) => [t.kind === "page" ? t.id : t.name, t.kind])),
    ).toEqual(
      new Map([
        ["s", "page"],
        ["r", "page"],
      ]),
    );
    expect(
      new Map(trash.map((t) => [t.kind === "page" ? t.id : "", context(t)])),
    ).toEqual(
      new Map([
        ["s", "Work"],
        ["r", "Personal"],
      ]),
    );
  });

  it("gives a second trashed copy of a page an id of its own", async () => {
    seed([{ rel: "Kept", id: "kept", title: "Kept" }]);
    const bin = `${CTX_ROOT}/Set-Trash`;
    mkdirp(bin);
    files.set(`${bin}/Syncing.md`, pageFile({ rel: "", id: "dup", title: "Syncing" }, 2));
    files.set(
      `${bin}/Syncing 2.md`,
      pageFile({ rel: "", id: "dup", title: "Syncing" }, 1),
    );
    store = new FsPageStore(ROOT);
    await store.init();

    const ids = (await store.listTrash()).map((t) => (t.kind === "page" ? t.id : ""));
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain("dup");

    // " 2" sorts before "." byte-wise, so that copy is the one found first
    const healed = files.get(`${bin}/Syncing.md`)!;
    expect(healed).not.toContain(`id: "dup"`);
    expect(healed.replace(/^id: .*$/m, "")).toBe(
      pageFile({ rel: "", id: "dup", title: "Syncing" }, 2).replace(/^id: .*$/m, ""),
    );

    // settled: listing again rewrites nothing
    await store.listTrash();
    expect(files.get(`${bin}/Syncing.md`)).toBe(healed);

    // and each copy comes back on its own
    for (const id of ids) await store.restore(id);
    expect((await store.list()).map((p) => p.title).sort()).toEqual([
      "Kept",
      "Syncing",
      "Syncing",
    ]);
    expect(await store.listTrash()).toEqual([]);
  });

  it("takes a deleted page's subtree into the trash inside it", async () => {
    await store.remove("alpha");

    expect(pathsUnder(`${CTX_ROOT}/Set-Trash`)).toEqual(["Alpha.md", "Alpha/Deep.md"]);
    expect(await store.listTrash()).toEqual([
      {
        kind: "page",
        id: "alpha",
        title: "Alpha",
        context: "Set",
        descendants: 1,
        trashedAt: 0,
      },
    ]);

    expect(await treeOnDisk()).toEqual([
      "Work",
      "  Beta",
      "  Gamma",
      "Personal",
      "Notes",
    ]);
  });

  it("opens a trashed branch one level at a time", async () => {
    await store.remove("work");

    const [entry] = await store.listTrash();
    expect(entry).toMatchObject({ kind: "page", id: "work", descendants: 4 });

    expect(
      (await store.listTrashIn({ kind: "page", id: "work" })).map((e) => e.title),
    ).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(await store.listTrashIn({ kind: "page", id: "alpha" })).toMatchObject([
      { id: "deep", title: "Deep", descendants: 0 },
    ]);

    expect(await store.listTrashIn({ kind: "page", id: "deep" })).toEqual([]);
    expect(await store.listTrashIn({ kind: "page", id: "notes" })).toEqual([]);
  });

  it("restores one page out of a deleted branch, leaving the rest deleted", async () => {
    await store.remove("work");

    await store.restore("alpha");

    expect(await treeOf(await freshStore())).toEqual([
      "Alpha",
      "  Deep",
      "Personal",
      "Notes",
    ]);

    expect(await store.listTrash()).toMatchObject([{ id: "work", descendants: 2 }]);
    expect(pathsUnder(`${CTX_ROOT}/Set-Trash`)).toEqual([
      "Work.md",
      "Work/Beta.md",
      "Work/Gamma.md",
    ]);
  });

  it("deletes one page out of a deleted branch for good", async () => {
    await store.remove("work");

    await store.deleteForever("alpha");

    expect(pathsUnder(`${CTX_ROOT}/Set-Trash`)).toEqual([
      "Work.md",
      "Work/Beta.md",
      "Work/Gamma.md",
    ]);
    expect(await store.listTrash()).toMatchObject([{ id: "work", descendants: 2 }]);
  });

  it("opens a deleted context onto the pages it holds", async () => {
    store = await storeOnAt(ROOT, [
      { rel: "Work/Standups", id: "s", title: "Standups" },
      { rel: "Work/Standups/Monday", id: "m", title: "Monday" },
      { rel: "Work/Retro", id: "t", title: "Retro" },
      { rel: "Personal/Recipes", id: "r", title: "Recipes" },
    ]);
    await store.deleteContext("Work");

    expect(
      (await store.listTrashIn({ kind: "context", name: "Work" })).map((e) => e.title),
    ).toEqual(["Standups", "Retro"]);
    expect(await store.listTrashIn({ kind: "page", id: "s" })).toMatchObject([
      { id: "m", title: "Monday" },
    ]);

    await store.restore("m");
    expect(byId(await store.list(), "m").context).toBe("Work");
    expect((await store.listContexts()).map((c) => c.name)).toEqual(["Personal", "Work"]);
  });

  it("restores a page with everything that was under it, still nested", async () => {
    await store.remove("alpha");
    await store.restore("alpha");

    expect(await treeOf(await freshStore())).toEqual([
      "Work",
      "  Beta",
      "  Gamma",
      "Alpha",
      "  Deep",
      "Personal",
      "Notes",
    ]);
    expect(await store.listTrash()).toEqual([]);
  });

  it("restores a page to the context it was trashed from", async () => {
    store = await storeOnAt(ROOT, [
      { rel: "Work/Standups", id: "s", title: "Standups" },
      { rel: "Personal/Recipes", id: "r", title: "Recipes" },
    ]);
    await store.remove("s");

    await store.restore("s");

    expect(byId(await store.list(), "s").context).toBe("Work");
    expect(pathsUnder(ROOT)).toContain("Work/Standups.md");
  });

  it("recreates a context that was deleted while a page of it sat in the trash", async () => {
    store = await storeOnAt(ROOT, [
      { rel: "Work/Standups", id: "s", title: "Standups" },
      { rel: "Work/Retro", id: "t", title: "Retro" },
      { rel: "Personal/Recipes", id: "r", title: "Recipes" },
    ]);
    await store.remove("s");
    await store.deleteContext("Work");
    expect((await store.listContexts()).map((c) => c.name)).toEqual(["Personal"]);

    await store.restore("s");

    expect(byId(await store.list(), "s").context).toBe("Work");
    expect((await store.listContexts()).map((c) => c.name)).toEqual(["Personal", "Work"]);
  });

  it("lists a deleted context as one entry, and restores it whole", async () => {
    store = await storeOnAt(ROOT, [
      { rel: "Work/Standups", id: "s", title: "Standups" },
      { rel: "Work/Standups/Monday", id: "m", title: "Monday" },
      { rel: "Work/Retro", id: "t", title: "Retro" },
      { rel: "Personal/Recipes", id: "r", title: "Recipes" },
    ]);

    await store.remove("t");

    await store.deleteContext("Work");

    // Retro was already deleted; being carried inside the context's trash does not make it one of
    // its pages.
    expect(await store.listTrash()).toEqual([
      { kind: "context", name: "Work", pages: 2, trashedAt: 0 },
    ]);

    await store.restoreContext("Work");

    expect((await store.listContexts()).map((c) => c.name)).toEqual(["Personal", "Work"]);

    expect(await treeOf(await freshStore())).toEqual(["Standups", "  Monday", "Recipes"]);

    // and what was in the trash when the context went is still in the trash
    expect(await store.listTrash()).toMatchObject([{ kind: "page", id: "t" }]);
    expect(pathsUnder(`${ROOT}/Work/Set-Trash`)).toEqual(["Retro.md"]);
  });

  it("lists a trashed context's pages individually once a context of that name is back", async () => {
    store = await storeOnAt(ROOT, [
      { rel: "Work/Standups", id: "s", title: "Standups" },
      { rel: "Personal/Recipes", id: "r", title: "Recipes" },
    ]);
    await store.deleteContext("Work");
    expect(await store.listTrash()).toEqual([
      { kind: "context", name: "Work", pages: 1, trashedAt: 0 },
    ]);

    await store.createContext("Work");

    expect(await store.listTrash()).toEqual([
      {
        kind: "page",
        id: "s",
        title: "Standups",
        context: "Work",
        descendants: 0,
        trashedAt: 0,
      },
    ]);
  });

  it("deletes a trashed subtree, and a trashed context, for good", async () => {
    store = await storeOnAt(ROOT, [
      { rel: "Work/Standups", id: "s", title: "Standups" },
      { rel: "Work/Standups/Monday", id: "m", title: "Monday" },
      { rel: "Personal/Recipes", id: "r", title: "Recipes" },
    ]);
    await store.remove("s");
    await store.deleteForever("s");
    expect(pathsUnder(`${ROOT}/Work/Set-Trash`)).toEqual([]);

    await store.deleteContext("Personal");
    await store.deleteContextForever("Personal");
    expect(await store.listTrash()).toEqual([]);
    expect(files.has(`${ROOT}/Set-Trash/Personal`)).toBe(false);
  });

  it("keeps a deleted page's images with it, there and back", async () => {
    seedAt(ROOT, [{ rel: "Work/Standups", id: "s", title: "Standups" }]);
    mkdirp(`${ROOT}/Work/Standups/Set-page-assets`);
    files.set(`${ROOT}/Work/Standups/Set-page-assets/pic.png`, "<bytes>");
    store = new FsPageStore(ROOT);
    await store.init();

    await store.remove("s");
    expect(files.has(`${ROOT}/Work/Set-Trash/Standups/Set-page-assets/pic.png`)).toBe(
      true,
    );

    expect((await store.listTrash())[0]).toMatchObject({ descendants: 0 });

    await store.restore("s");
    expect(files.has(`${ROOT}/Work/Standups/Set-page-assets/pic.png`)).toBe(true);
  });

  it("takes a context's trash with it when the context is renamed", async () => {
    store = await storeOnAt(ROOT, [
      { rel: "Work/Standups", id: "s", title: "Standups" },
      { rel: "Work/Retro", id: "t", title: "Retro" },
    ]);
    await store.remove("s");

    await store.renameContext("Work", "Team");

    // A trash at the root, keyed by context name, would read as a *deleted
    // context* called "Work" after this.
    expect(await store.listTrash()).toMatchObject([
      { kind: "page", id: "s", context: "Team" },
    ]);
    expect(pathsUnder(`${ROOT}/Team/Set-Trash`)).toEqual(["Standups.md"]);

    await store.restore("s");
    expect(byId(await store.list(), "s").context).toBe("Team");
  });

  it("restores one page out of a deleted context's own trash", async () => {
    store = await storeOnAt(ROOT, [
      { rel: "Work/Standups", id: "s", title: "Standups" },
      { rel: "Work/Retro", id: "t", title: "Retro" },
      { rel: "Personal/Recipes", id: "r", title: "Recipes" },
    ]);
    await store.remove("s");
    await store.deleteContext("Work");

    await store.restore("s");

    expect(byId(await store.list(), "s").context).toBe("Work");
    expect((await store.listContexts()).map((c) => c.name)).toEqual(["Personal", "Work"]);
  });

  it("clears the root trash away once it holds no deleted context", async () => {
    store = await storeOnAt(ROOT, [{ rel: "Work/Standups", id: "s", title: "Standups" }]);

    await store.remove("s");
    expect(files.has(`${ROOT}/Set-Trash`)).toBe(false);

    await store.createContext("Personal");
    await store.deleteContext("Personal");
    expect(files.has(`${ROOT}/Set-Trash`)).toBe(true);

    await store.deleteContextForever("Personal");
    expect(files.has(`${ROOT}/Set-Trash`)).toBe(false);
  });

  it("empties every context's trash, and the deleted contexts with it", async () => {
    store = await storeOnAt(ROOT, [
      { rel: "Work/Standups", id: "s", title: "Standups" },
      { rel: "Personal/Recipes", id: "r", title: "Recipes" },
    ]);
    await store.remove("s");
    await store.remove("r");
    await store.createContext("Old");
    await store.deleteContext("Old");

    await store.clearTrash();

    expect(await store.listTrash()).toEqual([]);
    expect(files.has(`${ROOT}/Work/Set-Trash`)).toBe(false);
    expect(files.has(`${ROOT}/Personal/Set-Trash`)).toBe(false);
    expect(files.has(`${ROOT}/Set-Trash`)).toBe(false);
  });
});

function context(
  entry: Awaited<ReturnType<InstanceType<typeof FsPageStore>["listTrash"]>>[number],
): string {
  return entry.kind === "page" ? entry.context : entry.name;
}

function byId(
  pages: Awaited<ReturnType<InstanceType<typeof FsPageStore>["list"]>>,
  id: string,
) {
  const found = pages.find((p) => p.id === id);
  if (!found) throw new Error(`no page ${id} in [${pages.map((p) => p.id)}]`);
  return found;
}

async function freshStore(): Promise<InstanceType<typeof FsPageStore>> {
  const fresh = new FsPageStore(ROOT);
  await fresh.init();
  return fresh;
}

describe("two notes carrying one id", () => {
  function seedTwins(): void {
    seed([
      { rel: "Notes", id: "twin", title: "Notes" },
      { rel: "Notes copy", id: "twin", title: "Notes copy" },
      { rel: "Notes copy/Inside", id: "inside", title: "Inside" },
    ]);
  }

  async function expectBothKept(): Promise<void> {
    const pages = await store.list();
    expect(pages.map((p) => p.title).sort()).toEqual(["Inside", "Notes", "Notes copy"]);

    const original = pages.find((p) => p.title === "Notes")!;
    const copy = pages.find((p) => p.title === "Notes copy")!;
    // "Notes copy.md" sorts before "Notes.md", so it's the one that keeps the id
    expect(copy.id).toBe("twin");
    expect(original.id).not.toBe("twin");
    expect(files.get(`${CTX_ROOT}/Notes.md`)).toContain(`id: "${original.id}"`);
    expect(pages.find((p) => p.title === "Inside")!.parentId).toBe("twin");
  }

  it("keeps both when the folder is read by the fallback scan", async () => {
    seedTwins();
    store = new FsPageStore(ROOT);
    await store.init();
    await expectBothKept();
  });

  it("keeps both when the native scan reads it, children and all", async () => {
    seedTwins();
    // What `scan_notes` reports: the child's parent comes from the folder's owner.
    const at = (relPath: string, id: string, title: string, parentId: string | null) => ({
      id,
      parentId,
      title,
      order: null,
      locked: false,
      createdAt: 1,
      updatedAt: 1,
      relPath,
    });
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd !== "scan_notes") throw new Error("no native shell");
      return [
        at("Set/Notes.md", "twin", "Notes", null),
        at("Set/Notes/Kid.md", "kid", "Kid", "twin"),
        at("Set/Notes copy.md", "twin", "Notes copy", null),
        at("Set/Notes copy/Inside.md", "inside", "Inside", "twin"),
      ];
    });
    try {
      store = new FsPageStore(ROOT);
      await store.init();
    } finally {
      vi.mocked(invoke).mockImplementation(async () => {
        throw new Error("no native shell");
      });
    }

    const pages = await store.list();
    const original = pages.find((p) => p.title === "Notes")!;
    expect(original.id).not.toBe("twin");
    expect(pages.find((p) => p.title === "Notes copy")!.id).toBe("twin");
    expect(pages.find((p) => p.title === "Kid")!.parentId).toBe(original.id);
    expect(pages.find((p) => p.title === "Inside")!.parentId).toBe("twin");
  });

  it("brings a trashed page back under a new id when a live one has taken it", async () => {
    seed([{ rel: "Syncing", id: "dup", title: "Syncing" }]);
    const bin = `${CTX_ROOT}/Set-Trash`;
    mkdirp(bin);
    files.set(`${bin}/Syncing.md`, pageFile({ rel: "", id: "dup", title: "Syncing" }, 1));
    store = new FsPageStore(ROOT);
    await store.init();

    const back = await store.restore("dup");

    expect(back).not.toBe("dup");
    const pages = await store.list();
    expect(pages.map((p) => p.id).sort()).toEqual([back, "dup"].sort());
    expect(await store.listTrash()).toEqual([]);
  });
});

describe("a page that changed on disk under its editor", () => {
  const A = `${CTX_ROOT}/A.md`;
  const doc = (text: string) => ({ type: "doc", content: [{ type: "raw", text }] });

  beforeEach(async () => {
    store = await storeOn([{ rel: "A", id: "a", title: "A" }]);
  });

  it("refuses a save over what a sync wrote since the page was read, and writes nothing", async () => {
    const page = (await store.get("a"))!;
    const synced = files.get(A)!.replace("body of A", "from the other device");
    files.set(A, synced);

    page.doc = doc("typed here") as typeof page.doc;
    await expect(store.save(page)).rejects.toBeInstanceOf(ChangedOnDiskError);
    expect(files.get(A)).toBe(synced);
  });

  it("lets a save through once the page is read again", async () => {
    const page = (await store.get("a"))!;
    page.doc = doc("first") as typeof page.doc;
    await store.save(page);
    page.doc = doc("second") as typeof page.doc;
    await store.save(page);
    expect(files.get(A)).toContain("second");
  });

  it("never makes a blank page in place of one that has gone", async () => {
    const page = (await store.get("a"))!;
    await store.remove("a");
    page.doc = doc("typed into a page already gone") as typeof page.doc;
    await expect(store.save(page)).rejects.toBeInstanceOf(ChangedOnDiskError);
    expect(await store.list()).toEqual([]);
  });

  it("folds the edits into the other device's, and saves the result against it", async () => {
    const page = (await store.get("a"))!;
    const synced = files.get(A)!.replace("body of A", "body of A\nfrom the other device");
    files.set(A, synced);
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd !== "merge_note") throw new Error("no native shell");
      const { theirs } = args as { base: string; ours: string; theirs: string };
      return theirs.replace("from the other device", "from the other device\ntyped here");
    });
    try {
      page.doc = doc("body of A\ntyped here") as typeof page.doc;
      const outcome = await store.rebase(page);
      expect(outcome.kind).toBe("merged");
      if (outcome.kind !== "merged") return;
      expect(outcome.body).toContain("from the other device");
      expect(outcome.body).toContain("typed here");
      expect(files.get(A)).toBe(synced); // nothing written until it's adopted

      store.adopt("a", outcome.theirs);
      await store.save(outcome.page, outcome.body);
      expect(files.get(A)).toContain("typed here");
      expect(files.get(A)).toContain("from the other device");
    } finally {
      vi.mocked(invoke).mockImplementation(async () => {
        throw new Error("no native shell");
      });
    }
  });

  it("asks when the two can't be folded", async () => {
    const page = (await store.get("a"))!;
    files.set(A, files.get(A)!.replace("body of A", "rewritten there"));
    page.doc = doc("rewritten here") as typeof page.doc;
    expect(await store.rebase(page)).toEqual({ kind: "conflict" });
  });

  it("finds a page a sync moved, and saves it where it is now", async () => {
    const page = (await store.get("a"))!;
    files.set(
      `${CTX_ROOT}/Renamed.md`,
      files.get(A)!.replace('title: "A"', 'title: "Renamed"'),
    );
    files.delete(A);

    page.doc = doc("typed here") as typeof page.doc;
    await expect(store.save(page)).rejects.toBeInstanceOf(ChangedOnDiskError);
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd !== "merge_note") throw new Error("no native shell");
      const { ours } = args as { ours: string };
      return ours.replace('title: "A"', 'title: "Renamed"');
    });
    try {
      const outcome = await store.rebase(page);
      expect(outcome.kind).toBe("merged");
      if (outcome.kind !== "merged") return;
      store.adopt("a", outcome.theirs);
      await store.save(outcome.page, outcome.body);
    } finally {
      vi.mocked(invoke).mockImplementation(async () => {
        throw new Error("no native shell");
      });
    }
    expect(paths()).toEqual(["Renamed.md"]);
    expect(files.get(`${CTX_ROOT}/Renamed.md`)).toContain("typed here");
  });

  it("says whether a page that has gone went to the trash", async () => {
    const page = (await store.get("a"))!;
    mkdirp(`${CTX_ROOT}/Set-Trash`);
    files.set(`${CTX_ROOT}/Set-Trash/A.md`, files.get(A)!);
    files.delete(A);
    expect(await store.rebase(page)).toEqual({ kind: "gone", trashed: true });

    files.delete(`${CTX_ROOT}/Set-Trash/A.md`);
    expect(await store.rebase(page)).toEqual({ kind: "gone", trashed: false });
  });

  it("writes edits to a deleted page back under its own id", async () => {
    const page = (await store.get("a"))!;
    files.delete(A);
    await store.reload();
    page.doc = doc("kept") as typeof page.doc;
    await store.recreate(page);
    const pages = await store.list();
    expect(pages.map((p) => p.id)).toEqual(["a"]);
    expect(files.get(A)).toContain("kept");
  });

  it("keeps the version a save is checked against in step with its own reordering", async () => {
    store = await storeOn([
      { rel: "A", id: "a", title: "A" },
      { rel: "B", id: "b", title: "B" },
    ]);
    const page = (await store.get("a"))!;
    await store.move("a", null, ["b", "a"]);
    page.doc = doc("typed after the reorder") as typeof page.doc;
    await store.save(page);
    expect(files.get(A)).toContain("typed after the reorder");
  });

  it("overwrites the file on disk when told to keep what's on screen", async () => {
    const page = (await store.get("a"))!;
    files.set(A, files.get(A)!.replace("body of A", "rewritten there"));
    page.doc = doc("mine") as typeof page.doc;
    await expect(store.save(page)).rejects.toBeInstanceOf(ChangedOnDiskError);
    await store.overwriteNext("a");
    await store.save(page);
    expect(files.get(A)).toContain("mine");
    expect(files.get(A)).not.toContain("rewritten there");
  });
});
