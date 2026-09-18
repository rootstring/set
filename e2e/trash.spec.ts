import { test, expect, type Page } from "@playwright/test";
import { booted } from "./app";
import { livePages, putPages } from "./db";

const PAGES = [
  { id: "t-standups", title: "Standups", parentId: null, context: "Work" },
  { id: "t-monday", title: "Monday sync", parentId: "t-standups", context: "Work" },
  { id: "t-budget", title: "Q3 budget", parentId: null, context: "Work" },
  { id: "t-recipes", title: "Recipes", parentId: null, context: "Personal" },
];

async function seedPages(page: Page): Promise<void> {
  await putPages(
    page,
    PAGES.map((p) => ({ ...p, body: `Notes about ${p.title}.` })),
    { contexts: ["Personal", "Work"] },
  );
  await page.evaluate(() => localStorage.removeItem("set:view-state"));
  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible();
}

/** The tree as storage holds it: "Work/  Monday sync", context and depth. */
async function stored(page: Page): Promise<string[]> {
  const live = await livePages(page);
  const out: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const r of live.filter((x) => x.parentId === parent)) {
      out.push(`${r.context}/${"  ".repeat(depth)}${r.title}`);
      walk(r.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

const sidebar = (page: Page) => page.locator(".sidebar");
const panel = (page: Page) => page.getByRole("dialog", { name: "Trash" });

const switcher = (page: Page) => sidebar(page).getByTestId("context-switcher");
const trashSwitcher = (page: Page) => panel(page).getByTestId("context-switcher");
const trashRows = (page: Page) => page.getByTestId("trash-item");

async function switchTo(page: Page, name: string): Promise<void> {
  await switcher(page).click();
  await sidebar(page).getByTestId("context-option").filter({ hasText: name }).click();
  await expect(switcher(page).locator(".context-name")).toHaveText(name);
}

/** Point the trash at another context, without moving the app to it. */
async function scopeTrashTo(page: Page, name: string): Promise<void> {
  await trashSwitcher(page).click();
  await panel(page).getByTestId("context-option").filter({ hasText: name }).click();
  await expect(trashSwitcher(page).locator(".context-name")).toHaveText(name);
}

async function openTrash(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+k");
  await page
    .getByRole("textbox", { name: "Search pages, text, and commands" })
    .fill("trash");
  await page.getByTestId("command-result").filter({ hasText: "Open Trash" }).click();
  await expect(panel(page)).toBeVisible();
}

/** Trash the page named, through the row's own button and the confirmation. */
async function trashRow(page: Page, title: string): Promise<void> {
  const row = page.locator(".page-row", { hasText: title }).first();
  await row.hover();
  await row.locator(".delete-btn").click();
  await page.getByRole("dialog").getByRole("button", { name: "Move to Trash" }).click();
}

/** Delete a whole context from Settings → Contexts, and close the panel. */
async function deleteContext(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByTestId("settings-tab-contexts").click();
  await page.getByRole("button", { name: `Delete “${name}”` }).click();
  await page
    .getByRole("dialog", { name: `Delete “${name}”` })
    .getByRole("button", { name: "Delete context" })
    .click();
  await page.keyboard.press("Escape");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await booted(page);
  await seedPages(page);
});

test("a deleted page keeps its children inside it, and hands them back", async ({
  page,
}) => {
  await switchTo(page, "Work");
  await trashRow(page, "Standups");

  await expect.poll(() => stored(page)).toEqual(["Work/Q3 budget", "Personal/Recipes"]);

  await openTrash(page);

  await expect(trashRows(page)).toHaveCount(1);
  await expect(trashRows(page).first()).toContainText("Standups");
  await expect(trashRows(page).first()).toContainText("1 page inside");

  await page.getByRole("button", { name: "Restore “Standups”" }).click();

  await expect
    .poll(() => stored(page))
    .toEqual([
      "Work/Standups",
      "Work/  Monday sync",
      "Work/Q3 budget",
      "Personal/Recipes",
    ]);
});

test("a branch opens in the trash, and one page comes back out of it", async ({
  page,
}) => {
  await switchTo(page, "Work");
  await trashRow(page, "Standups");
  await expect.poll(() => stored(page)).toEqual(["Work/Q3 budget", "Personal/Recipes"]);

  await openTrash(page);

  await expect(trashRows(page)).toHaveCount(1);
  await page.getByRole("button", { name: "Expand “Standups”" }).click();

  await expect(trashRows(page)).toHaveCount(2);
  const child = trashRows(page).nth(1);
  await expect(child).toContainText("Monday sync");
  await expect(child).toHaveAttribute("data-depth", "1");

  await expect(
    child.getByRole("button", { name: "Restore “Monday sync”" }),
  ).toHaveAttribute("title", "Restore to the top of “Work”");
  await child.getByRole("button", { name: "Restore “Monday sync”" }).click();

  await expect
    .poll(() => stored(page))
    .toEqual(["Work/Monday sync", "Work/Q3 budget", "Personal/Recipes"]);

  await expect(trashRows(page)).toHaveCount(1);
  await expect(trashRows(page).first()).toContainText("Standups");
  await expect(page.getByRole("button", { name: /Expand/ })).toHaveCount(0);
});

test("a deleted context is one entry in the trash, and comes back whole", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByTestId("settings-tab-contexts").click();
  await page.getByRole("button", { name: "Delete “Work”" }).click();

  const confirm = page.getByRole("dialog", { name: "Delete “Work”" });
  await expect(confirm).toContainText("3 pages");
  await confirm.getByRole("button", { name: "Delete context" }).click();
  await page.keyboard.press("Escape");

  await expect.poll(() => stored(page)).toEqual(["Personal/Recipes"]);

  await openTrash(page);

  await expect(trashRows(page)).toHaveCount(1);
  await expect(trashRows(page).first()).toContainText("Work");
  await expect(trashRows(page).first()).toContainText("context with 3 pages");

  await page.getByRole("button", { name: "Restore “Work”" }).click();

  await expect(switcher(page).locator(".context-name")).toHaveText("Work");
  await expect
    .poll(() => stored(page))
    .toEqual([
      "Work/Standups",
      "Work/  Monday sync",
      "Work/Q3 budget",
      "Personal/Recipes",
    ]);
});

test("a deleted context opens too, down to a page inside a page", async ({ page }) => {
  await deleteContext(page, "Work");
  await expect.poll(() => stored(page)).toEqual(["Personal/Recipes"]);

  await openTrash(page);
  await page.getByRole("button", { name: "Expand “Work”" }).click();

  await expect(trashRows(page)).toHaveCount(3);
  await expect(trashRows(page).nth(1)).toContainText("Standups");
  await expect(trashRows(page).nth(2)).toContainText("Q3 budget");

  await page.getByRole("button", { name: "Expand “Standups”" }).click();
  await expect(trashRows(page).nth(2)).toContainText("Monday sync");
  await expect(trashRows(page).nth(2)).toHaveAttribute("data-depth", "2");

  await trashRows(page)
    .nth(2)
    .getByRole("button", { name: "Restore “Monday sync”" })
    .click();
  await expect.poll(() => stored(page)).toEqual(["Work/Monday sync", "Personal/Recipes"]);

  // Restoring the page brought “Work” back, so what is left of it in the trash
  // is now that context's, not this one's.
  await expect(trashRows(page)).toHaveCount(0);
  await expect(panel(page)).toContainText("Nothing deleted in “Personal”");

  await scopeTrashTo(page, "Work");
  await expect(trashRows(page)).toHaveCount(2);
  await expect(trashRows(page).filter({ hasText: "Standups" })).toHaveCount(1);
});

test("⌘Z takes back a deleted context, in one step", async ({ page }) => {
  await deleteContext(page, "Work");
  await expect.poll(() => stored(page)).toEqual(["Personal/Recipes"]);

  await page.locator(".ProseMirror").click();
  await page.keyboard.press("ControlOrMeta+z");

  await expect
    .poll(() => stored(page))
    .toEqual([
      "Work/Standups",
      "Work/  Monday sync",
      "Work/Q3 budget",
      "Personal/Recipes",
    ]);
  await openTrash(page);
  await expect(panel(page)).toContainText("Trash is empty");
});

test("the trash shows one context at a time, and switches between them", async ({
  page,
}) => {
  for (const [context, title] of [
    ["Personal", "Recipes"],
    ["Work", "Q3 budget"],
  ]) {
    await switchTo(page, context);
    const row = page.locator(".page-row", { hasText: title }).first();
    await row.hover();
    await row.locator(".delete-btn").click();
    await page.getByRole("dialog").getByRole("button", { name: "Move to Trash" }).click();
  }
  await expect.poll(() => stored(page)).toEqual(["Work/Standups", "Work/  Monday sync"]);

  // Opens on the context you're in, “Work”, where the last delete happened.
  await openTrash(page);
  await expect(trashSwitcher(page).locator(".context-name")).toHaveText("Work");
  await expect(trashRows(page)).toHaveCount(1);
  await expect(trashRows(page).first()).toContainText("Q3 budget");

  await scopeTrashTo(page, "Personal");
  await expect(trashRows(page)).toHaveCount(1);
  await expect(trashRows(page).first()).toContainText("Recipes");

  // The scope is the trash's own: the app stayed in “Work”.
  await expect(switcher(page).locator(".context-name")).toHaveText("Work");

  // And emptying it takes only what is on screen.
  await page.getByRole("button", { name: "Empty" }).click();
  const confirm = page.getByRole("dialog", { name: "Empty trash" });
  await expect(confirm).toContainText("1 page");
  await confirm.getByRole("button", { name: "Empty trash" }).click();

  await expect(panel(page)).toContainText("Nothing deleted in “Personal”");
  await expect(panel(page)).toContainText("1 page is in the trash of another context");

  await scopeTrashTo(page, "Work");
  await expect(trashRows(page)).toHaveCount(1);
  await expect(trashRows(page).first()).toContainText("Q3 budget");
});

test("restoring from another context's trash takes the app there", async ({ page }) => {
  await switchTo(page, "Work");
  const row = page.locator(".page-row", { hasText: "Q3 budget" }).first();
  await row.hover();
  await row.locator(".delete-btn").click();
  await page.getByRole("dialog").getByRole("button", { name: "Move to Trash" }).click();
  await expect
    .poll(() => stored(page))
    .toEqual(["Work/Standups", "Work/  Monday sync", "Personal/Recipes"]);

  await switchTo(page, "Personal");
  await openTrash(page);
  await expect(trashRows(page)).toHaveCount(0);

  await scopeTrashTo(page, "Work");
  await page.getByRole("button", { name: "Restore “Q3 budget”" }).click();

  await expect(panel(page)).toHaveCount(0);
  await expect(switcher(page).locator(".context-name")).toHaveText("Work");
  await expect(page.locator(".page-row.active")).toContainText("Q3 budget");
});

test("the confirmation opens beside the row that asked, not in the middle", async ({
  page,
}) => {
  await switchTo(page, "Work");
  const row = page.locator(".page-row", { hasText: "Q3 budget" }).first();
  await row.hover();
  const button = row.locator(".delete-btn");
  await button.click();

  const popover = page.getByTestId("confirm-popover");
  await expect(popover).toBeVisible();

  const near = await button.boundingBox();
  const box = await popover.boundingBox();
  if (!near || !box) throw new Error("no layout to measure");

  // Within arm's reach of the button, rather than out at the window's centre.
  const gap = Math.abs(near.x + near.width / 2 - (box.x + box.width / 2));
  expect(gap).toBeLessThan(200);
  expect(box.y).toBeGreaterThan(near.y);
});

test("“Don't ask again” trades the confirmation for an undo toast", async ({ page }) => {
  await switchTo(page, "Work");

  const first = page.locator(".page-row", { hasText: "Q3 budget" }).first();
  await first.hover();
  await first.locator(".delete-btn").click();

  const popover = page.getByTestId("confirm-popover");
  await popover.getByRole("checkbox").check();
  await popover.getByRole("button", { name: "Move to Trash" }).click();
  await expect
    .poll(() => stored(page))
    .toEqual(["Work/Standups", "Work/  Monday sync", "Personal/Recipes"]);

  // The next delete goes straight through; the toast is what stands behind it.
  const second = page.locator(".page-row", { hasText: "Standups" }).first();
  await second.hover();
  await second.locator(".delete-btn").click();

  await expect(popover).toHaveCount(0);
  const toast = page.getByRole("alert").filter({ hasText: "moved to Trash" });
  await expect(toast).toBeVisible();
  await expect.poll(() => stored(page)).toEqual(["Personal/Recipes"]);

  await toast.getByTestId("toast-action").click();
  await expect
    .poll(() => stored(page))
    .toEqual(["Work/Standups", "Work/  Monday sync", "Personal/Recipes"]);
});

test("emptying the trash still asks, even with confirmations turned off", async ({
  page,
}) => {
  await switchTo(page, "Work");
  const row = page.locator(".page-row", { hasText: "Q3 budget" }).first();
  await row.hover();
  await row.locator(".delete-btn").click();

  const popover = page.getByTestId("confirm-popover");
  await popover.getByRole("checkbox").check();
  await popover.getByRole("button", { name: "Move to Trash" }).click();
  await expect
    .poll(() => stored(page))
    .toEqual(["Work/Standups", "Work/  Monday sync", "Personal/Recipes"]);

  await openTrash(page);
  await expect(trashRows(page)).toHaveCount(1);

  // Nothing brings this one back, so it asks whatever the setting says, and
  // offers no way to turn the asking off.
  await page.getByRole("button", { name: "Empty" }).click();
  await expect(popover).toBeVisible();
  await expect(popover.getByRole("checkbox")).toHaveCount(0);

  await popover.getByRole("button", { name: "Empty trash" }).click();
  await expect(trashRows(page)).toHaveCount(0);
});
