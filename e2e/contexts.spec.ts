import { test, expect, type Page } from "@playwright/test";
import { booted, openRow, switchTo } from "./app";
import { putPages } from "./db";

const PAGES = [
  { id: "x-standups", title: "Standups", parentId: null, context: "Work" },
  { id: "x-monday", title: "Monday sync", parentId: "x-standups", context: "Work" },
  { id: "x-budget", title: "Q3 budget", parentId: null, context: "Work" },
  { id: "x-recipes", title: "Recipes", parentId: null, context: "Personal" },
  { id: "x-trip", title: "Trip plan", parentId: null, context: "Personal" },
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

const rows = (page: Page) => page.locator(".page-row .page-title");
const switcher = (page: Page) => page.getByTestId("context-switcher");

const contextName = (page: Page) =>
  page.getByTestId("context-switcher").locator(".context-name");
const switcherTitles = (page: Page) =>
  page.getByTestId("title-result").locator(".result-title");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await booted(page);
  await seedPages(page);
});

test("the sidebar shows one context, and the header names it", async ({ page }) => {
  await expect(contextName(page)).toHaveText("Personal");
  await expect(rows(page)).toHaveText(["Recipes", "Trip plan"]);

  await switchTo(page, "Work");

  await expect(rows(page)).toHaveText(["Standups", "Q3 budget"]);
});

test("a new page lands in the context you're looking at", async ({ page }) => {
  await switchTo(page, "Work");

  await page.getByRole("button", { name: "New page" }).click();
  await expect(page.locator(".title")).toHaveValue("");
  await page.locator(".title").fill("Sprint notes");

  await expect(rows(page)).toContainText(["Sprint notes"]);

  await switchTo(page, "Personal");
  await expect(rows(page)).toHaveText(["Recipes", "Trip plan"]);
  await switchTo(page, "Work");
  await expect(rows(page)).toContainText(["Sprint notes"]);
});

test("⌘K searches this context, and Tab widens it", async ({ page }) => {
  await switchTo(page, "Work");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Search pages, text, and commands…").fill("recipes");

  await expect(switcherTitles(page)).toHaveCount(0);

  await expect(
    page.getByTestId("command-result").filter({ hasText: "Search all" }),
  ).toHaveCount(0);

  await page.keyboard.press("Tab");

  await expect(page.getByTestId("scope-chip")).toHaveText("All contexts");
  await expect(switcherTitles(page)).toHaveText(["Recipes"]);
  await expect(page.getByTestId("title-result").locator(".result-path")).toHaveText(
    "Personal",
  );
});

test("opening a page in another context switches to it", async ({ page }) => {
  await switchTo(page, "Work");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Search pages, text, and commands…").fill("recipes");
  await page.keyboard.press("Tab");
  await switcherTitles(page).first().click();

  await expect(page.locator(".title")).toHaveValue("Recipes");
  await expect(contextName(page)).toHaveText("Personal");
  await expect(rows(page)).toHaveText(["Recipes", "Trip plan"]);
});

test("each context remembers the page you were reading", async ({ page }) => {
  await switchTo(page, "Work");
  await openRow(page, "Q3 budget");
  await expect(page.locator(".title")).toHaveValue("Q3 budget");

  await switchTo(page, "Personal");
  await openRow(page, "Trip plan");
  await expect(page.locator(".title")).toHaveValue("Trip plan");

  await switchTo(page, "Work");
  await expect(page.locator(".title")).toHaveValue("Q3 budget");

  await page.reload();
  await expect(page.locator(".title")).toHaveValue("Q3 budget");
  await expect(contextName(page)).toHaveText("Work");
});

test("moving a page to another context files it, and leaves you where you were", async ({
  page,
}) => {
  await switchTo(page, "Work");
  await openRow(page, "Standups");

  await page.getByTestId("page-menu").click();
  await page.getByTestId("page-menu-move-context").click();
  await page.getByTestId("page-menu-move-target").filter({ hasText: "Personal" }).click();

  await expect(contextName(page)).toHaveText("Work");
  await expect(rows(page)).toHaveText(["Q3 budget"]);

  // The page you filed away cannot stay open here either.
  await expect(page.locator(".title")).toHaveValue("Q3 budget");

  await switchTo(page, "Personal");
  await expect(rows(page)).toContainText(["Standups"]);
  await page.locator(".page-row .twisty").first().click();
  await expect(rows(page)).toContainText(["Monday sync"]);
});

test("filing the last page away leaves the empty state, not the page", async ({
  page,
}) => {
  for (const title of ["Recipes", "Trip plan"]) {
    await openRow(page, title);
    await page.getByTestId("page-menu").click();
    await page.getByTestId("page-menu-move-context").click();
    await page.getByTestId("page-menu-move-target").filter({ hasText: "Work" }).click();
  }

  await expect(contextName(page)).toHaveText("Personal");
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByTestId("empty-new-page")).toBeVisible();
  await expect(page.locator(".ProseMirror")).toHaveCount(0);
});

test("a locked page can't be filed into another context", async ({ page }) => {
  await switchTo(page, "Work");
  await openRow(page, "Q3 budget");
  await expect(page.locator(".title")).toHaveValue("Q3 budget");
  await page.keyboard.press("ControlOrMeta+Shift+KeyL");
  await expect(page.getByTestId("breadcrumb-unlock")).toBeVisible();

  await page.getByTestId("page-menu").click();
  const move = page.getByTestId("page-menu-move-context");
  await expect(move).toBeDisabled();
  await expect(move).toHaveAttribute("title", "Page is locked");

  await move.hover();
  await expect(page.getByTestId("page-menu-move-target")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(rows(page)).toContainText(["Q3 budget"]);

  // A locked page inside blocks its parent's move too, the way the trash does.
  await page.locator(".page-row .twisty").first().click();
  await openRow(page, "Monday sync");
  await expect(page.locator(".title")).toHaveValue("Monday sync");
  await page.keyboard.press("ControlOrMeta+Shift+KeyL");
  await expect(page.getByTestId("breadcrumb-unlock")).toBeVisible();
  await openRow(page, "Standups");
  await expect(page.locator(".title")).toHaveValue("Standups");
  await page.getByTestId("page-menu").click();
  await page.getByTestId("page-menu-move-context").click();
  await page.getByTestId("page-menu-move-target").filter({ hasText: "Personal" }).click();

  await expect(page.locator(".toast")).toContainText("inside is locked");
  await expect(rows(page)).toContainText(["Standups"]);
});

test("a context made from the switcher is switched to, and says it's empty", async ({
  page,
}) => {
  await switcher(page).click();
  await page.getByTestId("context-new").click();
  await page.getByTestId("context-name-input").fill("Reading");
  await page.keyboard.press("Enter");

  await expect(contextName(page)).toHaveText("Reading");

  // No page is made on your behalf; the empty state offers to make the first.
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByTestId("empty-new-page")).toBeVisible();

  await page.getByTestId("empty-new-page").click();
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await expect(page.locator(".title")).toHaveValue("");
});

async function openManage(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByTestId("settings-tab-contexts").click();
  await expect(page.getByTestId("context-row-name").first()).toBeVisible();
}

test("the switcher's new-context field refuses a name that's taken", async ({ page }) => {
  await switcher(page).click();
  await page.getByTestId("context-new").click();
  await page.getByTestId("context-name-input").fill("Work");

  await expect(page.getByTestId("context-name-note")).toHaveText(/already exists/);
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("context-name-input")).toBeVisible();
  await expect(contextName(page)).toHaveText("Personal");
  await expect(page.getByTestId("context-option")).toHaveCount(2);
});

test("a name the filesystem can't take is refused rather than mangled", async ({
  page,
}) => {
  await switcher(page).click();
  await page.getByTestId("context-new").click();

  await page.getByTestId("context-name-input").fill("///");
  await expect(page.getByTestId("context-name-note")).toHaveText(/letters or numbers/);

  await page.getByTestId("context-name-input").fill("Side/Projects");
  await expect(page.getByTestId("context-name-note")).toHaveText(
    /Saved as “Side-Projects”/,
  );
  await page.keyboard.press("Enter");
  await expect(contextName(page)).toHaveText("Side-Projects");
});

test("the switcher's menu is walkable with the arrow keys", async ({ page }) => {
  await switcher(page).click();

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(contextName(page)).toHaveText("Work");
});

test("⌘K offers the other contexts by name, and Enter switches", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByPlaceholder("Search pages, text, and commands…").fill("work");

  const row = page.getByTestId("context-result");
  await expect(row).toHaveText(/Work/);

  await expect(row).toHaveCount(1);

  await page.keyboard.press("Enter");
  await expect(contextName(page)).toHaveText("Work");
  await expect(rows(page)).toHaveText(["Standups", "Q3 budget"]);
});

test("the scope chip names what ⌘K is searching, and switches it both ways", async ({
  page,
}) => {
  await switchTo(page, "Work");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByTestId("scope-chip")).toHaveText("Work");

  await page.getByPlaceholder("Search pages, text, and commands…").fill("recipes");
  await expect(switcherTitles(page)).toHaveCount(0);

  await page.getByTestId("scope-chip").click();
  await expect(page.getByTestId("scope-chip")).toHaveText("All contexts");
  await expect(switcherTitles(page)).toHaveText(["Recipes"]);

  await page.getByTestId("scope-chip").click();
  await expect(page.getByTestId("scope-chip")).toHaveText("Work");
  await expect(switcherTitles(page)).toHaveCount(0);
});

test("⌘K says out loud that Tab is what widens the search", async ({ page }) => {
  await switchTo(page, "Work");
  await page.keyboard.press("ControlOrMeta+k");

  // The chip says where it is looking; the hint says how to change it, which
  // nothing else on screen does.
  const hint = page.getByTestId("switcher-tab-hint");
  await expect(hint).toContainText("Tab");
  await expect(hint).toContainText("Search all contexts");

  // And once you are looking everywhere, it names the way back.
  await page.keyboard.press("Tab");
  await expect(hint).toContainText("Search only “Work”");
});

test("the add field makes nothing until it's asked to", async ({ page }) => {
  await openManage(page);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByTestId("context-new-input").fill("Reading");

  await page.getByTestId("settings-tab-appearance").click();
  await page.getByTestId("settings-tab-contexts").click();
  await expect(page.getByTestId("context-row-name")).toHaveCount(2);

  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByTestId("context-new-input").fill("Work");
  await expect(page.getByTestId("context-note")).toHaveText(/already exists/);
  await expect(page.getByRole("button", { name: "Create" })).toBeDisabled();

  await page.getByTestId("context-new-input").fill("Reading");
  await page.getByRole("button", { name: "Create" }).click();

  await expect(contextName(page)).toHaveText("Reading");
});

test("renaming onto a name that's taken keeps the one it had", async ({ page }) => {
  await openManage(page);
  await page.getByTestId("context-rename").first().click(); // Personal
  await page.getByTestId("context-rename-input").fill("Work");
  await expect(page.getByTestId("context-rename-note")).toHaveText(/already exists/);

  await page.getByTestId("settings-tab-appearance").click();
  await page.getByTestId("settings-tab-contexts").click();
  await expect(page.getByTestId("context-row-name").first()).toHaveText("Personal");
});

test("the grip reorders the list, and ⌥⌘1…⌥⌘9 follow it", async ({ page }) => {
  await openManage(page);

  await page.getByRole("button", { name: /^Reorder “Personal”/ }).focus();
  await page.keyboard.press("ArrowDown");

  await expect(page.getByTestId("context-row-name")).toHaveText(["Work", "Personal"]);

  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.keyboard.press("ControlOrMeta+Alt+Digit1");
  await expect(contextName(page)).toHaveText("Work");
});

test("back and forward carry an empty context along with the pages", async ({ page }) => {
  await putPages(page, [], { contexts: ["Ideas"], clear: false });
  await page.reload();
  await expect(contextName(page)).toHaveText("Personal");
  await expect(page.locator(".title")).toHaveValue("Recipes");

  await switchTo(page, "Ideas");
  await expect(page.getByTestId("empty-new-page")).toBeVisible();
  await expect(page).toHaveURL(/\/ideas$/);

  await page.keyboard.press("ControlOrMeta+BracketLeft");
  await expect(contextName(page)).toHaveText("Personal");
  await expect(page.locator(".title")).toHaveValue("Recipes");

  // The empty state names no page, so without its context forward would open the wrong one.
  await page.keyboard.press("ControlOrMeta+BracketRight");
  await expect(contextName(page)).toHaveText("Ideas");
  await expect(page.getByTestId("empty-new-page")).toBeVisible();
  await expect(page.getByTestId("page-menu")).toBeHidden();

  await page.reload();
  await expect(contextName(page)).toHaveText("Ideas");
  await expect(page.getByTestId("empty-new-page")).toBeVisible();
});

test("the address names the context the page is in", async ({ page }) => {
  await expect(page).toHaveURL(/\/personal\/pages\/recipes-x-recipes$/);

  await switchTo(page, "Work");
  await expect(page).toHaveURL(/\/work\/pages\/standups-x-standups$/);
});

test("an address naming the wrong context opens the page where it lives", async ({
  page,
}) => {
  // What a link made before the page was moved looks like.
  await page.goto("/Personal/pages/q3-budget-x-budget");
  await expect(page.locator(".title")).toHaveValue("Q3 budget");
  await expect(contextName(page)).toHaveText("Work");
  await expect(page).toHaveURL(/\/work\/pages\/q3-budget-x-budget$/);
});

test("a context's own address opens its last page, whatever the case", async ({
  page,
}) => {
  await page.goto("/WORK");
  await expect(contextName(page)).toHaveText("Work");
  await expect(page.locator(".title")).toHaveValue("Standups");
  await expect(page).toHaveURL(/\/work\/pages\/standups-x-standups$/);
});

test("a context that no longer exists sends you to the front door", async ({ page }) => {
  await page.goto("/Nowhere");
  await expect(contextName(page)).toHaveText("Personal");
  await expect(page).toHaveURL(/\/personal\/pages\/recipes-x-recipes$/);
});

test("renaming the open context renames the address, page or empty", async ({ page }) => {
  await openManage(page);
  await page.getByTestId("context-rename").first().click(); // Personal
  await page.getByTestId("context-rename-input").fill("Home Notes");
  await page.keyboard.press("Enter");
  await expect(contextName(page)).toHaveText("Home Notes");
  await expect(page).toHaveURL(/\/home-notes\/pages\/recipes-x-recipes$/);
  await page.keyboard.press("Escape");

  await putPages(page, [], { contexts: ["Ideas"], clear: false });
  await page.reload();
  await switchTo(page, "Ideas");
  await expect(page).toHaveURL(/\/ideas$/);

  await openManage(page);
  await page.getByRole("button", { name: "Rename “Ideas”" }).click();
  await page.getByTestId("context-rename-input").fill("Someday");
  await page.keyboard.press("Enter");
  await expect(contextName(page)).toHaveText("Someday");
  await expect(page).toHaveURL(/\/someday$/);
});

test("two contexts whose names make the same slug each keep their own address", async ({
  page,
}) => {
  await putPages(page, [], { contexts: ["My Notes", "My-Notes"], clear: false });
  await page.reload();

  // `my-notes` would stand for either, so both are addressed by name.
  await switchTo(page, "My-Notes");
  await expect(page).toHaveURL(/\/My-Notes$/);
  await switchTo(page, "My Notes");
  await expect(page).toHaveURL(/\/My%20Notes$/);

  await page.keyboard.press("ControlOrMeta+BracketLeft");
  await expect(contextName(page)).toHaveText("My-Notes");
  await page.reload();
  await expect(contextName(page)).toHaveText("My-Notes");
});
