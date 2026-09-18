import { test, expect, type Page } from "@playwright/test";
import { booted } from "./app";
import { livePages, putPages } from "./db";

const PAGES = [
  { id: "s-work", title: "Work", parentId: null },
  { id: "s-alpha", title: "Alpha", parentId: "s-work" },
  { id: "s-beta", title: "Beta", parentId: "s-work" },
  { id: "s-gamma", title: "Gamma", parentId: "s-work" },
  { id: "s-deep", title: "Deep", parentId: "s-alpha" },
  { id: "s-personal", title: "Personal", parentId: null },
  { id: "s-notes", title: "Notes", parentId: null },
];

async function seedPages(page: Page): Promise<void> {
  await putPages(page, PAGES);
  await page.evaluate(() => {
    localStorage.removeItem("set:view-state");
    localStorage.removeItem("set:sidebar:expanded");
  });
  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible();
}

const rowOf = (page: Page, title: string) =>
  page.locator(".page-row", {
    has: page.locator(".page-title", { hasText: new RegExp(`^${title}$`) }),
  });

async function expand(page: Page, ...titles: string[]): Promise<void> {
  for (const title of titles) {
    const twisty = rowOf(page, title).locator(".twisty");
    if (
      (await twisty.count()) &&
      (await twisty.getAttribute("aria-expanded")) === "false"
    ) {
      await twisty.click();
    }
  }
}

async function tree(page: Page): Promise<string[]> {
  return page.locator(".page-row").evaluateAll((els) =>
    els
      .map((el) => ({
        key: `${getComputedStyle(el).getPropertyValue("--depth").trim()}:${
          el.querySelector(".page-title")?.textContent?.trim() ?? ""
        }`,
        top: parseFloat((el as HTMLElement).style.top || "0"),
      }))
      .sort((a, b) => a.top - b.top)
      .map((r) => r.key),
  );
}

/** The tree as storage holds it, depth-first: "0:Work", "1:Roadmap", … */
async function stored(page: Page): Promise<string[]> {
  const live = await livePages(page);
  const out: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const r of live.filter((x) => x.parentId === parent)) {
      out.push(`${depth}:${r.title}`);
      walk(r.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

async function drag(
  page: Page,
  from: string,
  to: string | null,
  where: "before" | "after" | "inside" | "empty",
): Promise<void> {
  const src = rowOf(page, from);
  const srcBox = (await src.boundingBox())!;
  let x: number, y: number;
  if (to === null) {
    const nav = (await page.locator("nav.pages").boundingBox())!;
    x = nav.x + nav.width / 2;
    y = nav.y + nav.height - 4;
  } else {
    const box = (await rowOf(page, to).boundingBox())!;
    x = box.x + box.width / 2;
    y =
      box.y +
      (where === "before"
        ? box.height * 0.1
        : where === "after"
          ? box.height * 0.9
          : box.height * 0.5);
  }
  await page.mouse.move(srcBox.x + srcBox.width / 2, srcBox.y + srcBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 10 });
  await page.mouse.move(x, y);
  await page.mouse.up();
}

async function fileOf(page: Page, title: string): Promise<string> {
  const live = await livePages(page);
  return live.find((r) => r.title === title)?.file ?? "";
}

async function childLinks(page: Page, title: string): Promise<string[]> {
  await rowOf(page, title).locator(".page-item").click();
  await expect(page.locator("textarea.title")).toHaveValue(title);
  return page.locator(".ProseMirror .page-link .page-link-title").allTextContents();
}

async function addChild(page: Page, parent: string, title: string): Promise<void> {
  await rowOf(page, parent).hover();
  await rowOf(page, parent)
    .getByRole("button", { name: `Add a page inside “${parent}”` })
    .click();
  await expect(page.locator("textarea.title")).toHaveValue("");
  await page.locator("textarea.title").fill(title);
  await expect(rowOf(page, title)).toHaveCount(1);

  await expect.poll(() => fileOf(page, title)).toContain(`title: "${title}"`);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await booted(page);
  await seedPages(page);
});

test("nesting a page under a sibling moves it in the tree and in storage", async ({
  page,
}) => {
  await expand(page, "Work");
  await expect
    .poll(() => tree(page))
    .toEqual(["0:Work", "1:Alpha", "1:Beta", "1:Gamma", "0:Personal", "0:Notes"]);

  await drag(page, "Gamma", "Beta", "inside");

  await expect
    .poll(() => tree(page))
    .toEqual(["0:Work", "1:Alpha", "1:Beta", "2:Gamma", "0:Personal", "0:Notes"]);
  await expect
    .poll(() => stored(page))
    .toEqual([
      "0:Work",
      "1:Alpha",
      "2:Deep",
      "1:Beta",
      "2:Gamma",
      "0:Personal",
      "0:Notes",
    ]);
});

test("a nested page brings its whole subtree with it", async ({ page }) => {
  await expand(page, "Work", "Alpha");
  await drag(page, "Alpha", "Gamma", "inside");
  await expand(page, "Gamma", "Alpha");

  await expect
    .poll(() => tree(page))
    .toEqual([
      "0:Work",
      "1:Beta",
      "1:Gamma",
      "2:Alpha",
      "3:Deep",
      "0:Personal",
      "0:Notes",
    ]);
  await expect
    .poll(() => stored(page))
    .toEqual([
      "0:Work",
      "1:Beta",
      "1:Gamma",
      "2:Alpha",
      "3:Deep",
      "0:Personal",
      "0:Notes",
    ]);
});

test("reordering within a group survives a reload", async ({ page }) => {
  await expand(page, "Work");
  await drag(page, "Gamma", "Alpha", "before");
  await expect
    .poll(() => tree(page))
    .toEqual(["0:Work", "1:Gamma", "1:Alpha", "1:Beta", "0:Personal", "0:Notes"]);

  await page.reload();
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await expand(page, "Work");
  await expect
    .poll(() => tree(page))
    .toEqual(["0:Work", "1:Gamma", "1:Alpha", "1:Beta", "0:Personal", "0:Notes"]);
});

test("dropping after an expanded page makes a sibling, not a child", async ({ page }) => {
  await expand(page, "Work");

  await drag(page, "Notes", "Work", "after");

  await expect
    .poll(() => tree(page))
    .toEqual(["0:Work", "1:Alpha", "1:Beta", "1:Gamma", "0:Notes", "0:Personal"]);
  await expect
    .poll(() => stored(page))
    .toEqual([
      "0:Work",
      "1:Alpha",
      "2:Deep",
      "1:Beta",
      "1:Gamma",
      "0:Notes",
      "0:Personal",
    ]);
});

test("a child can be pulled back out to the top level", async ({ page }) => {
  await expand(page, "Work");
  await drag(page, "Beta", "Personal", "before");

  await expect
    .poll(() => tree(page))
    .toEqual(["0:Work", "1:Alpha", "1:Gamma", "0:Beta", "0:Personal", "0:Notes"]);
  await expect
    .poll(() => stored(page))
    .toEqual([
      "0:Work",
      "1:Alpha",
      "2:Deep",
      "1:Gamma",
      "0:Beta",
      "0:Personal",
      "0:Notes",
    ]);
});

test("dropping into the empty space below the list lands at the top level's end", async ({
  page,
}) => {
  await expand(page, "Work");
  await drag(page, "Beta", null, "empty");

  await expect
    .poll(() => tree(page))
    .toEqual(["0:Work", "1:Alpha", "1:Gamma", "0:Personal", "0:Notes", "0:Beta"]);
});

test("a page can't be dropped into its own subtree", async ({ page }) => {
  await expand(page, "Work", "Alpha");
  const before = await tree(page);
  await drag(page, "Alpha", "Deep", "inside");
  await page.waitForTimeout(300);
  expect(await tree(page)).toEqual(before);
  await expect
    .poll(() => stored(page))
    .toEqual([
      "0:Work",
      "1:Alpha",
      "2:Deep",
      "1:Beta",
      "1:Gamma",
      "0:Personal",
      "0:Notes",
    ]);
});

test("emptying a parent takes its twisty away; filling one gives it one", async ({
  page,
}) => {
  await expand(page, "Work", "Alpha");
  await expect(rowOf(page, "Alpha").locator(".twisty")).toHaveCount(1);
  await expect(rowOf(page, "Beta").locator(".twisty")).toHaveCount(0);

  await drag(page, "Deep", "Beta", "inside");

  await expect(rowOf(page, "Alpha").locator(".twisty")).toHaveCount(0);
  await expect(rowOf(page, "Beta").locator(".twisty")).toHaveCount(1);
  await expect
    .poll(() => tree(page))
    .toEqual([
      "0:Work",
      "1:Alpha",
      "1:Beta",
      "2:Deep",
      "1:Gamma",
      "0:Personal",
      "0:Notes",
    ]);
});

test("nesting into a collapsed page opens it so the moved page is visible", async ({
  page,
}) => {
  await expand(page, "Work");

  await expect(rowOf(page, "Alpha").locator(".twisty")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await drag(page, "Gamma", "Alpha", "inside");

  await expect
    .poll(() => tree(page))
    .toEqual([
      "0:Work",
      "1:Alpha",
      "2:Deep",
      "2:Gamma",
      "1:Beta",
      "0:Personal",
      "0:Notes",
    ]);
});

test("nesting appends after the target's existing children", async ({ page }) => {
  await expand(page, "Work", "Alpha");
  await drag(page, "Beta", "Alpha", "inside");
  await expect
    .poll(() => tree(page))
    .toEqual([
      "0:Work",
      "1:Alpha",
      "2:Deep",
      "2:Beta",
      "1:Gamma",
      "0:Personal",
      "0:Notes",
    ]);
  await expect
    .poll(() => stored(page))
    .toEqual([
      "0:Work",
      "1:Alpha",
      "2:Deep",
      "2:Beta",
      "1:Gamma",
      "0:Personal",
      "0:Notes",
    ]);
});

test("the moved page stays where it was put when it is the open one", async ({
  page,
}) => {
  await expand(page, "Work");
  await rowOf(page, "Gamma").locator(".page-item").click();
  await expect(page.locator("textarea.title")).toHaveValue("Gamma");

  await drag(page, "Gamma", "Personal", "inside");
  await expect
    .poll(() => tree(page))
    .toEqual(["0:Work", "1:Alpha", "1:Beta", "0:Personal", "1:Gamma", "0:Notes"]);

  await page.locator(".ProseMirror").click();
  await page.keyboard.type("hello");
  await page.waitForTimeout(1200);
  await expect
    .poll(() => stored(page))
    .toEqual([
      "0:Work",
      "1:Alpha",
      "2:Deep",
      "1:Beta",
      "0:Personal",
      "1:Gamma",
      "0:Notes",
    ]);
});

test("a page dragged to a new parent takes its child-page block with it", async ({
  page,
}) => {
  await addChild(page, "Personal", "Errand");
  expect(await childLinks(page, "Personal")).toEqual(["Errand"]);

  await expand(page, "Personal");
  await drag(page, "Errand", "Notes", "inside");
  await expect
    .poll(() => tree(page))
    .toEqual(["0:Work", "0:Personal", "0:Notes", "1:Errand"]);

  await expect.poll(() => childLinks(page, "Personal")).toEqual([]);
  expect(await childLinks(page, "Notes")).toEqual(["Errand"]);
});

test("the same move rewrites both parents' stored Markdown", async ({ page }) => {
  await addChild(page, "Personal", "Errand");
  await expect.poll(() => fileOf(page, "Personal")).toContain("(page:");

  await expand(page, "Personal");
  await drag(page, "Errand", "Notes", "inside");

  await expect.poll(() => fileOf(page, "Personal")).not.toContain("(page:");
  await expect.poll(() => fileOf(page, "Notes")).toContain("[Errand](page:");
});

test("pulling a page out to the top level drops its old parent's block", async ({
  page,
}) => {
  await addChild(page, "Personal", "Errand");
  await expand(page, "Personal");

  await drag(page, "Errand", "Work", "before");
  await expect
    .poll(() => tree(page))
    .toEqual(["0:Errand", "0:Work", "0:Personal", "0:Notes"]);
  await expect.poll(() => childLinks(page, "Personal")).toEqual([]);
});

test("reordering siblings leaves the parent's blocks alone", async ({ page }) => {
  await addChild(page, "Personal", "First");
  await addChild(page, "Personal", "Second");
  await expand(page, "Personal");
  expect(await childLinks(page, "Personal")).toEqual(["First", "Second"]);

  await drag(page, "Second", "First", "before");
  await expect
    .poll(() => tree(page))
    .toEqual(["0:Work", "0:Personal", "1:Second", "1:First", "0:Notes"]);

  await expect.poll(() => childLinks(page, "Personal")).toEqual(["First", "Second"]);
});

test("a refused move into the page's own subtree changes no body", async ({ page }) => {
  await addChild(page, "Personal", "Errand");
  await addChild(page, "Errand", "Sub");
  await expand(page, "Personal", "Errand");

  await drag(page, "Errand", "Sub", "inside");
  await page.waitForTimeout(400);

  await expect
    .poll(() => tree(page))
    .toEqual(["0:Work", "0:Personal", "1:Errand", "2:Sub", "0:Notes"]);
  expect(await childLinks(page, "Personal")).toEqual(["Errand"]);
  expect(await childLinks(page, "Errand")).toEqual(["Sub"]);
});

test("moving the open page's parent updates the body under the caret", async ({
  page,
}) => {
  await addChild(page, "Personal", "Errand");
  await expand(page, "Personal");

  await rowOf(page, "Personal").locator(".page-item").click();
  await expect(page.locator("textarea.title")).toHaveValue("Personal");
  await expect(page.locator(".ProseMirror .page-link")).toHaveCount(1);

  await drag(page, "Errand", "Notes", "inside");
  await expect(page.locator(".ProseMirror .page-link")).toHaveCount(0);
  await expect(page.locator("textarea.title")).toHaveValue("Personal");
});
