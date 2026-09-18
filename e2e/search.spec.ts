import { test, expect, type Page } from "@playwright/test";
import { booted } from "./app";
import { putPages } from "./db";

const PAGES = [
  {
    id: "s-projects",
    title: "Projects",
    parentId: null,
    body: "Top level container for the work.\n",
  },
  {
    id: "s-alpha",
    title: "Project Alpha",
    parentId: "s-projects",
    body: "The alpha rollout plan.\nBudget approved in March.\n",
  },
  {
    id: "s-beta",
    title: "Project Beta",
    parentId: "s-projects",
    body: "Beta is blocked on the alpha rollout.\n",
  },
  {
    id: "s-notes",
    title: "Meeting Notes",
    parentId: null,
    body: "Discussed the alpha rollout with the team.\nThe alpha date slipped.\n",
  },
  {
    id: "s-groceries",
    title: "Groceries",
    parentId: null,
    body: "Milk, eggs, bread.\n",
  },
];

async function seedPages(page: Page): Promise<void> {
  await putPages(page, PAGES, { clear: false });
  await page.reload();
  await expect(page.locator(".ProseMirror")).toBeVisible();
}

async function search(page: Page, query: string): Promise<void> {
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByRole("textbox", { name: "Search pages, text, and commands" });
  await expect(input).toBeFocused();
  await input.fill(query);

  await page.waitForTimeout(400);
}

const titleResults = (page: Page) => page.getByTestId("title-result");
const contentResults = (page: Page) => page.getByTestId("content-result");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await booted(page);
  await seedPages(page);
});

test("splits results into title matches above content matches", async ({ page }) => {
  await search(page, "alpha");

  await expect(titleResults(page)).toHaveText([/Project Alpha/]);

  await expect(contentResults(page)).toHaveCount(2);
  await expect(contentResults(page)).toHaveText([/Meeting Notes/, /Project Beta/]);

  await expect(page.getByTestId("section-pages")).toHaveText("Pages");
  await expect(page.getByTestId("section-content")).toHaveText("Content");
  const headings = await page
    .getByTestId("switcher-results")
    .locator("p.section")
    .allTextContents();
  expect(headings).toEqual(["Pages", "Content"]);
});

test("shows the matching line under each content hit", async ({ page }) => {
  await search(page, "rollout");

  await expect(titleResults(page)).toHaveCount(0);
  await expect(page.getByTestId("section-pages")).toHaveCount(0);
  await expect(page.getByTestId("section-content")).toHaveText("Content");
  await expect(contentResults(page)).not.toHaveCount(0);

  const snippets = await page.getByTestId("snippet").allTextContents();
  expect(snippets).toContain("The alpha rollout plan.");
  expect(snippets).toContain("Beta is blocked on the alpha rollout.");
});

test("highlights the matched run in titles and in snippets", async ({ page }) => {
  await search(page, "alpha");

  const titleMarks = await titleResults(page).first().locator(".hit").allTextContents();
  expect(titleMarks).toEqual(["Alpha"]);

  const snippetMarks = await contentResults(page)
    .first()
    .locator(".result-snippet .hit")
    .allTextContents();
  expect(snippetMarks).toEqual(["alpha"]);
});

test("shows a bare list of pages when nothing matches on body text", async ({ page }) => {
  await search(page, "project");

  await expect(titleResults(page)).toHaveText([
    /Projects/,
    /Project Beta/,
    /Project Alpha/,
  ]);
  await expect(contentResults(page)).toHaveCount(0);

  await expect(page.getByTestId("section-pages")).toHaveText("Pages");
  await expect(page.getByTestId("section-content")).toHaveCount(0);
});

test("finds a page through its parent's title", async ({ page }) => {
  await search(page, "container");

  await expect(contentResults(page)).toHaveText([/Projects/]);
});

test("arrow keys cross the section boundary as one list", async ({ page }) => {
  await search(page, "alpha");

  await expect(titleResults(page).first()).toHaveClass(/active/);

  await page.keyboard.press("ArrowDown");
  await expect(titleResults(page).first()).not.toHaveClass(/active/);
  await expect(contentResults(page).first()).toHaveClass(/active/);

  await page.keyboard.press("ArrowUp");
  await expect(titleResults(page).first()).toHaveClass(/active/);
});

test("Enter opens the highlighted content match", async ({ page }) => {
  await search(page, "alpha");
  await page.keyboard.press("ArrowDown"); // into the content section
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/s-notes/);
  await expect(page.getByTestId("switcher-results")).toHaveCount(0);
});

test("Enter opens the highlighted title match", async ({ page }) => {
  await search(page, "groceries");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/s-groceries/);
});

test("says so when nothing matches at all", async ({ page }) => {
  await search(page, "zzzznothing");
  await expect(titleResults(page)).toHaveCount(0);
  await expect(contentResults(page)).toHaveCount(0);
  await expect(page.getByTestId("switcher-results")).toContainText(
    "No results for “zzzznothing”",
  );
});

test("an empty query lists every page under the Pages heading", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+k");

  await expect(titleResults(page).first()).toBeVisible();
  expect(await titleResults(page).count()).toBeGreaterThanOrEqual(PAGES.length);

  await expect(page.getByTestId("section-pages")).toHaveText("Pages");
  await expect(page.getByTestId("section-content")).toHaveCount(0);
  await expect(page.getByTestId("section-commands")).toHaveCount(0);
});

test("the sidebar search icon opens the same surface", async ({ page }) => {
  await page.getByTestId("sidebar-search").click();
  const input = page.getByRole("textbox", { name: "Search pages, text, and commands" });
  await expect(input).toBeFocused();

  await input.fill("alpha");
  await page.waitForTimeout(400);
  await expect(titleResults(page)).toHaveText([/Project Alpha/]);
  await expect(contentResults(page)).toHaveCount(2);
});

test("finds text typed moments ago, before the autosave would have fired", async ({
  page,
}) => {
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("Antidisestablishmentarianism");

  await search(page, "antidis");
  await expect(contentResults(page)).toContainText("Antidisestablishmentarianism");
});
