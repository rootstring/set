import { test, expect, type Page } from "@playwright/test";
import { booted, switchTo } from "./app";
import { putPages } from "./db";

/**
 * Nothing is created behind you when the last page goes; the context stays put and says it is
 * empty.
 */

const PAGES = [
  { id: "e-work", title: "Standups", context: "Work" },
  { id: "e-personal", title: "Recipes", context: "Personal" },
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

const contextName = (page: Page) =>
  page.getByTestId("context-switcher").locator(".context-name");
const rows = (page: Page) => page.locator(".page-row .page-title");

async function trashOpenPage(page: Page): Promise<void> {
  await page.getByTestId("page-menu").click();
  await page.getByTestId("page-menu-delete").click();
  await page.getByRole("dialog").getByRole("button", { name: "Move to Trash" }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await booted(page);
  await seedPages(page);
});

test("deleting the last page in a context leaves you in that context", async ({
  page,
}) => {
  await switchTo(page, "Work");
  await trashOpenPage(page);

  await expect(contextName(page)).toHaveText("Work");
  await expect(page.getByTestId("empty-new-page")).toBeVisible();
  await expect(rows(page)).toHaveCount(0);

  // and the other context is still there, untouched
  await switchTo(page, "Personal");
  await expect(rows(page)).toHaveText(["Recipes"]);
});

test("an emptied context stays empty across a reload", async ({ page }) => {
  await switchTo(page, "Work");
  await trashOpenPage(page);
  await expect(page.getByTestId("empty-new-page")).toBeVisible();

  await page.reload();

  await expect(contextName(page)).toHaveText("Work");
  await expect(page.getByTestId("empty-new-page")).toBeVisible();
  await expect(page.locator(".ProseMirror")).toBeHidden();
});

test("the empty state makes the page it offers", async ({ page }) => {
  await switchTo(page, "Work");
  await trashOpenPage(page);

  await page.getByTestId("empty-new-page").click();

  await expect(page.locator(".ProseMirror")).toBeVisible();
  await page.locator(".title").fill("Sprint notes");
  await expect(rows(page)).toHaveText(["Sprint notes"]);
  await expect(contextName(page)).toHaveText("Work");
});

test("undo brings back the last page, and the context never moved", async ({ page }) => {
  await switchTo(page, "Work");
  await trashOpenPage(page);
  await expect(page.getByTestId("empty-new-page")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+z");

  await expect(rows(page)).toHaveText(["Standups"]);
  await expect(contextName(page)).toHaveText("Work");
});
