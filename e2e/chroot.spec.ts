import { test, expect, type Page } from "@playwright/test";
import { booted, expand, openRow } from "./app";
import { putPages, removePages } from "./db";

const PAGES = [
  { id: "c-work", title: "Work", parentId: null },
  { id: "c-roadmap", title: "Roadmap", parentId: "c-work" },
  { id: "c-goals", title: "Q3 goals", parentId: "c-roadmap" },
  { id: "c-standups", title: "Standups", parentId: "c-work" },
  { id: "c-personal", title: "Personal", parentId: null },
];

async function seedPages(page: Page): Promise<void> {
  await putPages(page, PAGES);
  await page.evaluate(() => localStorage.removeItem("set:view-state"));
  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible();
}

const rows = (page: Page) => page.locator(".page-row .page-title");

const switcherTitles = (page: Page) =>
  page.getByTestId("title-result").locator(".result-title");

async function chrootHere(page: Page): Promise<void> {
  await page.getByTestId("page-menu").click();
  await page.getByTestId("page-menu-chroot").click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await booted(page);
  await seedPages(page);
});

test("roots the tree at the page, dropping its own row and everything outside", async ({
  page,
}) => {
  await expand(page, "Work");
  await expect(rows(page)).toHaveText(["Work", "Roadmap", "Standups", "Personal"]);

  await openRow(page, "Work");
  await chrootHere(page);

  await expect(rows(page)).toHaveText(["Roadmap", "Standups"]);
  await expect(page.locator(".crumb-here")).toHaveText("Work");
  await expect(page.getByTestId("chroot-exit")).toBeVisible();

  await expect(page.getByTestId("context-switcher")).toHaveText("Set");
});

test("the leading / goes back to all your notes", async ({ page }) => {
  await openRow(page, "Work");
  await chrootHere(page);
  await expect(rows(page)).toHaveText(["Roadmap", "Standups"]);

  await page.getByTestId("chroot-exit").click();

  await expect(rows(page)).toHaveText(["Work", "Personal"]);
  await expect(page.getByTestId("context-switcher")).toHaveText("Set");
  await expect(page.getByTestId("chroot-exit")).toHaveCount(0);
});

test("a top-level create lands inside the root", async ({ page }) => {
  await openRow(page, "Work");
  await chrootHere(page);

  await page.getByRole("button", { name: /New page inside/ }).click();
  await expect(page.locator(".title")).toBeFocused();
  await page.keyboard.type("Hiring");

  await expect(rows(page)).toHaveText(["Roadmap", "Standups", "Hiring"]);

  await page.getByTestId("chroot-exit").click();
  await expect(rows(page)).toHaveText([
    "Work",
    "Roadmap",
    "Standups",
    "Hiring",
    "Personal",
  ]);
});

test("opening a page outside the root keeps the root and highlights nothing", async ({
  page,
}) => {
  await openRow(page, "Work");
  await chrootHere(page);

  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByRole("textbox", { name: "Search pages, text, and commands" });
  await input.fill("Personal");
  await page.keyboard.press("Enter");
  await expect(page.locator(".title")).toHaveValue("Personal");

  await expect(page.locator(".crumb-here")).toHaveText("Work");
  await expect(rows(page)).toHaveText(["Roadmap", "Standups"]);

  await expect(page.locator(".page-row.active")).toHaveCount(0);
});

test("the root survives a reload", async ({ page }) => {
  await openRow(page, "Work");
  await chrootHere(page);

  await page.reload();
  await expect(page.locator(".ProseMirror")).toBeVisible();

  await expect(page.locator(".crumb-here")).toHaveText("Work");
  await expect(rows(page)).toHaveText(["Roadmap", "Standups"]);
});

test("one key roots the tree and un-roots it, from wherever you are", async ({
  page,
}) => {
  await expand(page, "Work");
  await openRow(page, "Work");

  await page.locator(".ProseMirror").click();
  await page.keyboard.press("ControlOrMeta+Shift+Period");
  await expect(page.locator(".crumb-here")).toHaveText("Work");
  await expect(rows(page)).toHaveText(["Roadmap", "Standups"]);

  await expect(page.locator(".ProseMirror")).toHaveText("");

  await openRow(page, "Roadmap");
  await expect(page.locator(".title")).toHaveValue("Roadmap");
  await page.keyboard.press("ControlOrMeta+Shift+Period");
  await expect(page.getByTestId("context-switcher")).toHaveText("Set");

  await expect(rows(page)).toHaveText(["Work", "Roadmap", "Standups", "Personal"]);

  await page.keyboard.press("ControlOrMeta+Shift+Period");
  await expect(page.locator(".crumb-here")).toHaveText("Roadmap");
  await expect(rows(page)).toHaveText(["Q3 goals"]);
});

test("the menu says which way the key will go", async ({ page }) => {
  await openRow(page, "Work");
  await expect(page.getByTestId("page-menu-chroot")).toHaveCount(0);
  await page.getByTestId("page-menu").click();
  await expect(page.getByTestId("page-menu-chroot")).toContainText("Chroot");
  await page.getByTestId("page-menu-chroot").click();

  await openRow(page, "Standups");
  await page.getByTestId("page-menu").click();
  await expect(page.getByTestId("page-menu-chroot")).toContainText("Un-chroot");
  await page.getByTestId("page-menu-chroot").click();
  await expect(page.getByTestId("context-switcher")).toHaveText("Set");
});

test("the chroot key is rebindable", async ({ page }) => {
  await openRow(page, "Work");

  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await page.getByTestId("settings-tab-shortcuts").click();
  const chip = page.getByTestId("shortcut-chroot");

  await expect(chip).toHaveText(/(⌘⇧|Ctrl\+Shift\+)\./);
  await chip.click();
  await expect(chip).toHaveText("Press keys");
  await page.keyboard.press("ControlOrMeta+Shift+KeyY");
  await page.getByRole("button", { name: "Rebind" }).click();
  await expect(chip).toHaveText(/(⌘⇧|Ctrl\+Shift\+)Y/);
  await page.keyboard.press("Escape");

  await page.keyboard.press("ControlOrMeta+Shift+KeyY");
  await expect(page.locator(".crumb-here")).toHaveText("Work");

  await page.keyboard.press("ControlOrMeta+Shift+Period");
  await expect(page.locator(".crumb-here")).toHaveText("Work");
});

test("the quick switcher puts the root's pages above the rest of your notes", async ({
  page,
}) => {
  await openRow(page, "Work");
  await chrootHere(page);

  await page.keyboard.press("ControlOrMeta+k");

  await expect(page.getByTestId("section-in-root")).toHaveText("Pages in Work");
  await expect(page.getByTestId("section-outside-root")).toHaveText("Pages outside Work");
  await expect(switcherTitles(page)).toHaveText([
    "Work",
    "Roadmap",
    "Q3 goals",
    "Standups",
    "Personal",
  ]);

  await page.getByRole("textbox", { name: "Search pages, text, and commands" }).fill("p");
  await expect(switcherTitles(page)).toHaveText([
    "Roadmap",
    "Standups",
    "Q3 goals",
    "Personal",
  ]);

  await page.keyboard.press("Enter");
  await expect(page.locator(".title")).toHaveValue("Roadmap");

  await page.getByTestId("chroot-exit").click();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByTestId("section-pages")).toHaveText("Pages");
  await expect(page.getByTestId("section-in-root")).toHaveCount(0);
  await expect(page.getByTestId("section-outside-root")).toHaveCount(0);
});

test("a root that stops existing falls back to all your notes", async ({ page }) => {
  await expand(page, "Work");
  await openRow(page, "Roadmap");
  await chrootHere(page);
  await expect(rows(page)).toHaveText(["Q3 goals"]);

  await page.goto("/set/pages/c-work");
  await expect(page.locator(".title")).toHaveValue("Work");

  await removePages(page, ["c-roadmap", "c-goals"]);
  await page.reload();
  await expect(page.locator(".ProseMirror")).toBeVisible();

  await expect(page.getByTestId("context-switcher")).toHaveText("Set");
  await expect(page.getByTestId("chroot-exit")).toHaveCount(0);
  await expect(rows(page)).toHaveText(["Work", "Standups", "Personal"]);
});
