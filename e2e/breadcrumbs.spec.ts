import { test, expect, type Page } from "@playwright/test";
import { booted } from "./app";
import { putPages } from "./db";

const PAGES = [
  { id: "b-work", title: "Work", parentId: null },
  { id: "b-roadmap", title: "Roadmap", parentId: "b-work" },
  { id: "b-q3", title: "Q3", parentId: "b-roadmap" },
  { id: "b-goals", title: "Goals", parentId: "b-q3" },
  { id: "b-okrs", title: "OKRs", parentId: "b-goals" },
  { id: "b-personal", title: "Personal", parentId: null },
];

const crumbs = (page: Page) => page.getByTestId("breadcrumbs").locator(".crumb");

async function open(page: Page, title: string): Promise<void> {
  await page.keyboard.press("ControlOrMeta+k");
  await page
    .getByRole("textbox", { name: "Search pages, text, and commands" })
    .fill(title);
  await page.getByTestId("title-result").filter({ hasText: title }).first().click();
  await expect(page.locator(".title")).toHaveValue(title);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await booted(page);
  await putPages(page, PAGES);
  await page.evaluate(() => localStorage.removeItem("set:view-state"));
  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible();
});

test("a top-level page's breadcrumb is its own title", async ({ page }) => {
  await open(page, "Personal");
  await expect(crumbs(page)).toHaveText(["Personal"]);
});

test("the open page ends the trail, follows its title, and isn't a link", async ({
  page,
}) => {
  await open(page, "Q3");
  const here = page.getByTestId("breadcrumbs").locator('[aria-current="page"]');
  await expect(here).toHaveText("Q3");
  await expect(
    page.getByTestId("breadcrumbs").getByRole("button", { name: "Q3" }),
  ).toHaveCount(0);

  await page.locator(".title").fill("Q4");
  await expect(here).toHaveText("Q4");
  await page.locator(".title").fill("");
  await expect(here).toHaveText("Untitled");
});

test("a subpage shows the pages above it, and each one opens", async ({ page }) => {
  await open(page, "Q3");
  await expect(crumbs(page)).toHaveText(["Work", "Roadmap", "Q3"]);

  await page.getByTestId("breadcrumbs").getByRole("button", { name: "Work" }).click();
  await expect(page.locator(".title")).toHaveValue("Work");
  await expect(crumbs(page)).toHaveText(["Work"]);
});

test("sits at the left of the page, beside the sidebar, and doesn't scroll away", async ({
  page,
}) => {
  await open(page, "Q3");
  const trail = page.getByTestId("breadcrumbs");
  const sidebar = (await page.locator(".sidebar").first().boundingBox())!;
  const box = (await trail.boundingBox())!;
  const title = (await page.locator(".title").boundingBox())!;

  expect(box.x).toBeGreaterThanOrEqual(sidebar.x + sidebar.width);
  expect(box.x).toBeLessThan(title.x);
  expect(box.y + box.height).toBeLessThanOrEqual(title.y);

  await page.locator(".ProseMirror").click();
  for (let i = 0; i < 60; i++) await page.keyboard.press("Enter");
  await page.locator(".content").evaluate((el) => el.scrollTo(0, el.scrollHeight));
  expect((await trail.boundingBox())!.y).toBe(box.y);
});

test("follows the sidebar button when the sidebar is hidden", async ({ page }) => {
  await open(page, "Q3");
  await page.keyboard.press("ControlOrMeta+Backslash");
  const reopen = (await page
    .getByRole("button", { name: "Show sidebar" })
    .boundingBox())!;
  const box = (await page.getByTestId("breadcrumbs").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(reopen.x + reopen.width);
});

test("a deep trail folds its middle, and opens it on a click", async ({ page }) => {
  await open(page, "OKRs");
  await expect(crumbs(page)).toHaveText(["Work", "…", "Q3", "Goals", "OKRs"]);

  await page.getByRole("button", { name: "Show 1 more" }).click();
  await expect(crumbs(page)).toHaveText(["Work", "Roadmap", "Q3", "Goals", "OKRs"]);

  // Folded again on the next page.
  await page.getByTestId("breadcrumbs").getByRole("button", { name: "Goals" }).click();
  await expect(crumbs(page)).toHaveText(["Work", "Roadmap", "Q3", "Goals"]);
  await open(page, "OKRs");
  await expect(crumbs(page)).toHaveText(["Work", "…", "Q3", "Goals", "OKRs"]);
});

test("renaming an ancestor renames its crumb", async ({ page }) => {
  await open(page, "Roadmap");
  await page.locator(".title").fill("Plans");

  await open(page, "Q3");
  await expect(crumbs(page)).toHaveText(["Work", "Plans", "Q3"]);
});

test("inside a chroot the trail starts at the root", async ({ page }) => {
  await open(page, "Roadmap");
  await page.getByTestId("page-menu").click();
  await page.getByTestId("page-menu-chroot").click();
  await expect(page.locator(".crumb-here")).toHaveText("Roadmap");
  await expect(crumbs(page)).toHaveText(["Roadmap"]);

  await open(page, "Goals");
  await expect(crumbs(page)).toHaveText(["Roadmap", "Q3", "Goals"]);
});
