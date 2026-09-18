import { test, expect, type Page } from "@playwright/test";
import { bodyOf, putPages, storedPages } from "./db";

/**
 * Writing a wikilink; reading one is `markdown.spec.ts`. A link may point out of the context, and
 * Tab widens the search as in ⌘K.
 */

interface Seed {
  id: string;
  title: string;
  context: string;
  body?: string;
}

const PAGES: Seed[] = [
  { id: "p-notes", title: "Rollout notes", context: "Personal", body: "Start here." },
  { id: "p-plan", title: "Launch plan", context: "Personal" },
  { id: "p-risks", title: "Open risks", context: "Personal" },
  { id: "w-budget", title: "Budget review", context: "Work" },
];

async function seed(page: Page, pages: Seed[] = PAGES): Promise<void> {
  await page.goto("/");
  await page.waitForSelector(".sidebar");
  await putPages(
    page,
    pages.map((p, i) => ({ ...p, order: i })),
    { contexts: ["Personal", "Work"] },
  );
  await page.evaluate(() => localStorage.removeItem("set:view-state"));
  await page.goto("/");
  await page.waitForSelector(".ProseMirror");
}

async function open(page: Page, title: string): Promise<void> {
  await page
    .locator(".sidebar")
    .getByRole("button", { name: title, exact: true })
    .click();
  await page.locator(".ProseMirror").waitFor();
}

async function stored(page: Page, id: string): Promise<string> {
  const rows = await storedPages(page);
  return bodyOf(rows.find((r) => r.id === id)?.file ?? "");
}

const picker = (page: Page) => page.getByTestId("page-picker");

/** `/` only opens after a break. */
async function onABlankLine(page: Page): Promise<void> {
  await page.locator(".ProseMirror").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
}

/**
 * Both link commands answer to "link" and the shorter title leads. The slash query stops at a
 * space.
 */
async function slashLinkToPage(page: Page): Promise<void> {
  await page.keyboard.type("/link");
  await expect(page.locator(".slash-menu .item .title").first()).toHaveText("Link");
  await expect(page.locator(".slash-menu .item .title").nth(1)).toHaveText(
    "Link to page",
  );
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(picker(page)).toBeVisible();
}

test("the slash command writes a link to a page you already have", async ({ page }) => {
  await seed(page);
  await open(page, "Rollout notes");
  await onABlankLine(page);
  await page.keyboard.type("See ");

  await slashLinkToPage(page);
  await page.keyboard.type("launch");
  await expect(page.getByTestId("picker-result").first()).toContainText("Launch plan");
  await page.keyboard.press("Enter");

  // A wikilink in the document, and `[[Title]]` in the file.
  const link = page.locator(".ProseMirror .wiki-link");
  await expect(link.locator(".wiki-link-title")).toHaveText("Launch plan");
  await expect(link).not.toHaveClass(/missing/);
  await expect.poll(() => stored(page, "p-notes")).toBe("See [[Launch plan]]");

  // And it goes where it says it goes.
  await link.click();
  await expect(page.locator("textarea.title")).toHaveValue("Launch plan");
});

test("the picker starts in this context and Tab widens it, as ⌘K does", async ({
  page,
}) => {
  await seed(page);
  await open(page, "Rollout notes");
  await onABlankLine(page);
  await slashLinkToPage(page);

  // Scoped to where you are: the chip names it, and Work is not on offer.
  const chip = page.getByTestId("picker-scope-chip");
  await expect(chip).toHaveText("Personal");
  await page.keyboard.type("budget");
  await expect(page.getByTestId("picker-result")).toHaveCount(0);

  // And the hint under it says what the chip can't: that Tab is the way.
  const hint = page.getByTestId("picker-tab-hint");
  await expect(hint).toContainText("Tab");
  await expect(hint).toContainText("Search all contexts");

  // Tab widens, and the page in the other context appears.
  await page.keyboard.press("Tab");
  await expect(chip).toHaveText("All contexts");
  await expect(hint).toContainText("Search only “Personal”");
  await expect(page.getByTestId("picker-result").first()).toContainText("Budget review");

  // Tab again goes back, and the chip goes with it.
  await page.keyboard.press("Tab");
  await expect(chip).toHaveText("Personal");
  await expect(page.getByTestId("picker-result")).toHaveCount(0);

  // Widen once more and take it: a link may point out of the context.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.locator(".ProseMirror .wiki-link-title")).toHaveText("Budget review");
});

test("a link with nothing to point at isn't offered, and an empty scope says so", async ({
  page,
}) => {
  // One page, with no title, in a workspace of one context.
  await seed(page, [
    { id: "only", title: "Just this", context: "Personal", body: "Alone." },
    { id: "blank", title: "", context: "Personal" },
  ]);
  await open(page, "Just this");
  await onABlankLine(page);
  await slashLinkToPage(page);

  // Untitled pages are hidden: a wikilink names its page by title.
  await expect(page.getByTestId("picker-result")).toHaveCount(1);
  await expect(page.getByTestId("picker-result")).toContainText("Just this");

  // One context, so there is no wider place to look, and neither the chip nor
  // the hint about Tab has anything to offer.
  await expect(page.getByTestId("picker-scope-chip")).toHaveCount(0);
  await expect(page.getByTestId("picker-tab-hint")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(picker(page)).toHaveCount(0);
});

test("the picker opens beside the line being written, not over the page", async ({
  page,
}) => {
  await seed(page);
  await open(page, "Rollout notes");
  await onABlankLine(page);
  await page.keyboard.type("See ");

  const line = await page.locator(".ProseMirror p").first().boundingBox();
  await slashLinkToPage(page);
  const panel = await picker(page).boundingBox();
  if (!line || !panel) throw new Error("nothing to measure");

  // Under the sentence it is being written into, and close enough to it to
  // read as part of it — not centred in the window like a page of its own.
  expect(panel.y).toBeGreaterThan(line.y);
  expect(panel.y - (line.y + line.height)).toBeLessThan(40);

  // No backdrop: the words behind are still clickable.
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator("textarea.title")).toHaveValue("Rollout notes");
});

test("the menu on a link re-points it, keeping what you called it", async ({ page }) => {
  await seed(page, [
    {
      id: "p-notes",
      title: "Rollout notes",
      context: "Personal",
      body: "See [[Launch plan|the plan]].",
    },
    { id: "p-plan", title: "Launch plan", context: "Personal" },
    { id: "p-risks", title: "Open risks", context: "Personal" },
  ]);
  await open(page, "Rollout notes");

  const link = page.locator(".ProseMirror .wiki-link");
  await expect(link.locator(".wiki-link-title")).toHaveText("the plan");

  await link.click({ button: "right" });
  await page.locator(".block-menu").getByText("Change page…").click();
  await expect(picker(page)).toBeVisible();
  await page.keyboard.type("risks");
  await page.keyboard.press("Enter");

  // Pointing somewhere else is no reason to take your words back.
  await expect(link.locator(".wiki-link-title")).toHaveText("the plan");
  await expect.poll(() => stored(page, "p-notes")).toBe("See [[Open risks|the plan]].");

  // And the row that gives the label back is only there while there is one.
  await link.click({ button: "right" });
  await page.locator(".block-menu").getByText("Use the page's name").click();
  await expect(link.locator(".wiki-link-title")).toHaveText("Open risks");
  await expect.poll(() => stored(page, "p-notes")).toBe("See [[Open risks]].");

  await link.click({ button: "right" });
  await expect(page.locator(".block-menu").getByText("Use the page's name")).toHaveCount(
    0,
  );
});

test("the menu removes a link and leaves the words behind", async ({ page }) => {
  await seed(page, [
    {
      id: "p-notes",
      title: "Rollout notes",
      context: "Personal",
      body: "See [[Launch plan]] first.",
    },
    { id: "p-plan", title: "Launch plan", context: "Personal" },
  ]);
  await open(page, "Rollout notes");

  await page.locator(".ProseMirror .wiki-link").click({ button: "right" });
  await page.locator(".block-menu").getByText("Remove link").click();

  await expect(page.locator(".ProseMirror .wiki-link")).toHaveCount(0);
  await expect(page.locator(".ProseMirror")).toContainText("See Launch plan first.");
  await expect.poll(() => stored(page, "p-notes")).toBe("See Launch plan first.");
});
