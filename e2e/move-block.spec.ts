import { test, expect, type Locator, type Page } from "@playwright/test";
import { booted } from "./app";
import { livePages, putPages, storedPages } from "./db";

/**
 * A block carrying a subpage link is that subpage to the sidebar; the destination has to have it
 * before this page loses it.
 */

const PAGES = [
  { id: "m-alpha", title: "Alpha", parentId: null },
  { id: "m-beta", title: "Beta", parentId: null },
];

async function seed(page: Page): Promise<void> {
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

async function open(page: Page, title: string): Promise<void> {
  await rowOf(page, title).locator(".page-item").click();
  await expect(page.locator("textarea.title")).toHaveValue(title);
}

async function bodyOf(page: Page, title: string): Promise<string> {
  return (await livePages(page)).find((r) => r.title === title)?.file ?? "";
}

async function blockMenu(page: Page, text: string): Promise<void> {
  const block = page.locator(".ProseMirror p", { hasText: text }).first();
  await block.hover({ position: { x: 12, y: 6 } });
  const handle = page.locator(".drag-handle");
  await expect(handle).toBeVisible();
  await handle.click();
  await expect(page.locator(".block-menu")).toBeVisible();
}

const moveItem = (page: Page) =>
  page.locator(".block-menu-item", { hasText: "Move to page" });

/** Make a subpage of the open page with `/page`, and come back to the parent. */
async function addChild(page: Page, title: string, parent: string): Promise<void> {
  await page.locator(".ProseMirror").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("/page");
  await expect(page.locator(".slash-menu .item").first()).toBeVisible();
  await page.keyboard.press("Enter");

  await expect(page.locator("textarea.title")).toHaveValue("");
  await page.locator("textarea.title").fill(title);
  await expect(rowOf(page, title)).toHaveCount(1);
  await open(page, parent);
}

/** Two moves for the drop, because one leaves the browser with no drag to finish. */
async function dragOnto(page: Page, text: string, target: Locator): Promise<void> {
  const block = page
    .locator(
      ".ProseMirror p, .ProseMirror h2, .ProseMirror .page-link, .ProseMirror .image-block",
      {
        hasText: text,
      },
    )
    .first();
  await block.hover({ position: { x: 12, y: 6 } });
  const handle = page.locator(".drag-handle");
  await expect(handle).toBeVisible();

  const grip = (await handle.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 16 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2);
}

const childLink = (page: Page, title: string) =>
  page.locator(".ProseMirror .page-link", { hasText: title });

/** Every page and the page it sits under, by title — ids here are generated. */
async function parentage(page: Page): Promise<string[]> {
  const rows = await storedPages(page);
  const titles = new Map(rows.map((r) => [r.id, r.title]));
  return rows
    .map((r) => `${r.title} < ${r.parentId ? titles.get(r.parentId) : "/"}`)
    .sort();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await booted(page);
  await seed(page);
});

test("the toast's Open follows the block to where it went", async ({ page }) => {
  await open(page, "Alpha");
  await addChild(page, "Child", "Alpha");
  await page.locator(".ProseMirror").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("file me");
  await expect.poll(() => bodyOf(page, "Alpha")).toContain("file me");

  await dragOnto(page, "file me", childLink(page, "Child"));
  await page.mouse.up();

  await page.getByTestId("toast-action").click();
  await expect(page.locator("textarea.title")).toHaveValue("Child");
  await expect(page.locator(".ProseMirror")).toContainText("file me");
});

test("no block menu offers Move to page", async ({ page }) => {
  await open(page, "Alpha");
  await addChild(page, "Child", "Alpha");
  await page.locator(".ProseMirror").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("a paragraph");

  await blockMenu(page, "a paragraph");
  await expect(page.locator(".block-menu-item")).toHaveText([
    "Copy",
    "Duplicate",
    "Delete",
  ]);
  await page.keyboard.press("Escape");
  await expect(page.locator(".block-menu")).toBeHidden();

  await childLink(page, "Child").click({ button: "right" });
  await expect(page.locator(".block-menu")).toBeVisible();
  await expect(page.locator(".block-menu-item")).toHaveText(["Duplicate", "Delete"]);
  await expect(moveItem(page)).toHaveCount(0);
});

test("a locked destination refuses the block, and says why", async ({ page }) => {
  await open(page, "Alpha");
  await addChild(page, "Child", "Alpha");
  await open(page, "Child");
  await page.getByTestId("page-menu").click();
  await page.getByTestId("page-menu-lock").click();
  await expect(page.getByTestId("breadcrumb-unlock")).toBeVisible();

  await open(page, "Alpha");
  await page.locator(".ProseMirror").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("file me");
  await expect.poll(() => bodyOf(page, "Alpha")).toContain("file me");

  await dragOnto(page, "file me", childLink(page, "Child"));
  await page.mouse.up();

  await expect(page.locator(".toast")).toContainText("Page is locked");
  // Refused in place: the block is still here, and Child is untouched.
  await expect(page.locator(".ProseMirror")).toContainText("file me");
  await expect.poll(() => bodyOf(page, "Child")).not.toContain("file me");
});

test("dropping a block on a child-page block files it inside that page", async ({
  page,
}) => {
  await open(page, "Alpha");
  await addChild(page, "Child", "Alpha");

  await page.locator(".ProseMirror").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("a loose paragraph");
  await expect.poll(() => bodyOf(page, "Alpha")).toContain("a loose paragraph");

  const link = childLink(page, "Child");
  await dragOnto(page, "a loose paragraph", link);
  // The page says it will take the block, rather than the line between two
  // blocks promising it will land beside it.
  await expect(link).toHaveClass(/drop-into/);
  await page.mouse.up();

  await expect(page.locator(".toast")).toContainText("Moved to “Child”");
  await expect(link).not.toHaveClass(/drop-into/);
  await expect(page.locator(".ProseMirror")).not.toContainText("a loose paragraph");

  await expect.poll(() => bodyOf(page, "Child")).toContain("a loose paragraph");
  await expect.poll(() => bodyOf(page, "Alpha")).not.toContain("a loose paragraph");

  // The reload is the only assertion that says it was written.
  await page.reload();
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await open(page, "Child");
  await expect(page.locator(".ProseMirror")).toContainText("a loose paragraph");
  await open(page, "Alpha");
  await expect(page.locator(".ProseMirror")).not.toContainText("a loose paragraph");
});

for (const { kind, typed, stored } of [
  { kind: "a bullet", typed: "- ", stored: "- dragged line" },
  { kind: "a todo", typed: "- [ ] ", stored: "- [ ] dragged line" },
  { kind: "a heading", typed: "## ", stored: "## dragged line" },
]) {
  test(`dropping ${kind} on a child-page block files it inside that page`, async ({
    page,
  }) => {
    await open(page, "Alpha");
    await addChild(page, "Child", "Alpha");

    await page.locator(".ProseMirror").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(`${typed}dragged line`);
    await expect.poll(() => bodyOf(page, "Alpha")).toContain("dragged line");

    const link = childLink(page, "Child");
    await dragOnto(page, "dragged line", link);
    await expect(link).toHaveClass(/drop-into/);
    await page.mouse.up();

    await expect(page.locator(".toast")).toContainText("Moved to “Child”");
    await expect(page.locator(".ProseMirror")).not.toContainText("dragged line");
    // It arrives as what it was: a list item comes inside a list of its kind.
    await expect.poll(() => bodyOf(page, "Child")).toContain(stored);
    await expect.poll(() => bodyOf(page, "Alpha")).not.toContain("dragged line");
  });
}

test("dropping several selected blocks on a child-page block files them all, in order", async ({
  page,
}) => {
  await open(page, "Alpha");
  await addChild(page, "Child", "Alpha");

  await page.locator(".ProseMirror").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("first line");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- second line");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("third line");
  await expect.poll(() => bodyOf(page, "Alpha")).toContain("third line");

  // From the end of the last line back to the start of the first.
  await page.keyboard.press("Shift+ArrowUp");
  await page.keyboard.press("Shift+ArrowUp");
  await page.keyboard.press("Shift+Home");

  const link = childLink(page, "Child");
  await dragOnto(page, "third line", link);
  await expect(link).toHaveClass(/drop-into/);
  await page.mouse.up();

  await expect(page.locator(".toast")).toContainText("Moved to “Child”");
  const alpha = page.locator(".ProseMirror");
  await expect(alpha).not.toContainText("first line");
  await expect(alpha).not.toContainText("second line");
  await expect(alpha).not.toContainText("third line");
  await expect(childLink(page, "Child")).toHaveCount(1);

  await expect
    .poll(() => bodyOf(page, "Child"))
    .toMatch(/first line\s+- second line\s+third line/);
  await expect.poll(() => bodyOf(page, "Alpha")).not.toContain("line");
});

test("a selection that holds the child-page block isn't dropped into it", async ({
  page,
}) => {
  await open(page, "Alpha");
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("above");
  await page.keyboard.press("Enter");
  await addChild(page, "Child", "Alpha");
  await page.locator(".ProseMirror").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("below");
  await expect.poll(() => bodyOf(page, "Alpha")).toContain("below");

  // From the end of "below", over the link, to the start of "above".
  await page.keyboard.press("Shift+ArrowUp");
  await page.keyboard.press("Shift+ArrowUp");
  await page.keyboard.press("Shift+Home");
  // The link is among what's picked up, so it can't take the rest.
  await expect
    .poll(() => page.evaluate(() => String(window.getSelection())))
    .toMatch(/^above[\s\S]*below$/);

  const link = childLink(page, "Child");
  await dragOnto(page, "below", link);
  await expect(link).not.toHaveClass(/drop-into/);
  await page.keyboard.press("Escape");
  await page.mouse.up();

  await expect.poll(() => bodyOf(page, "Child")).not.toContain("above");
  await expect(page.locator(".ProseMirror")).toContainText("above");
});

test("dropping a child page on a child page nests it", async ({ page }) => {
  await open(page, "Alpha");
  await addChild(page, "Child", "Alpha");
  await addChild(page, "Other", "Alpha");

  await dragOnto(page, "Other", childLink(page, "Child"));
  await expect(childLink(page, "Child")).toHaveClass(/drop-into/);
  await page.mouse.up();

  // The tree followed the block, and the link went with it.
  await expect
    .poll(() => parentage(page))
    .toEqual(["Alpha < /", "Beta < /", "Child < Alpha", "Other < Child"]);
  await expect(childLink(page, "Other")).toHaveCount(0);

  await open(page, "Child");
  await expect(page.locator(".ProseMirror .page-link-title")).toHaveText(["Other"]);
});

test("a block dropped anywhere else still just moves within the page", async ({
  page,
}) => {
  await open(page, "Alpha");
  await addChild(page, "Child", "Alpha");

  await page.locator(".ProseMirror").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("two");
  await expect.poll(() => bodyOf(page, "Alpha")).toContain("two");

  const second = page.locator(".ProseMirror p", { hasText: "two" }).first();
  await dragOnto(page, "one", second);
  await expect(childLink(page, "Child")).not.toHaveClass(/drop-into/);
  const box = (await second.boundingBox())!;
  await page.mouse.move(box.x + 60, box.y + box.height - 1);
  await page.mouse.up();

  // Both lines are still on this page, in the other order.
  await expect.poll(() => bodyOf(page, "Alpha")).toContain("two");
  await expect.poll(() => bodyOf(page, "Alpha")).toContain("one");
  await expect.poll(() => bodyOf(page, "Child")).not.toContain("one");
});

test("a todo filed on another page lands there as a todo, with its own under it", async ({
  page,
}) => {
  await open(page, "Alpha");
  await addChild(page, "Child", "Alpha");
  await page.locator(".ProseMirror").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("- [ ] parent");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("child");
  await expect.poll(() => bodyOf(page, "Alpha")).toContain("child");

  await dragOnto(page, "parent", childLink(page, "Child"));
  await page.mouse.up();
  await expect(page.locator(".toast")).toContainText("Moved to “Child”");

  // A list item arrives inside a list of the same kind it left.
  await expect.poll(() => bodyOf(page, "Child")).toContain("- [ ] parent");
  await expect.poll(() => bodyOf(page, "Child")).toContain("- [ ] child");
  // `parentId` lives in the frontmatter, so this asks after the todo itself.
  await expect.poll(() => bodyOf(page, "Alpha")).not.toContain("[ ] parent");

  await page.reload();
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await open(page, "Child");
  await expect(page.locator('.ProseMirror li input[type="checkbox"]')).toHaveCount(2);
});
