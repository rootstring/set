import { test, expect, type Page } from "@playwright/test";
import { booted, expand, openRow } from "./app";
import { putPages } from "./db";

const PAGES = [
  { id: "s-work", title: "Work", parentId: null },
  { id: "s-roadmap", title: "Roadmap", parentId: "s-work" },
  { id: "s-standups", title: "Standups", parentId: "s-work" },
  { id: "s-retro", title: "Retro", parentId: "s-work" },
  { id: "s-personal", title: "Personal", parentId: null },
];

async function seedPages(page: Page): Promise<void> {
  await putPages(page, PAGES);
  await page.evaluate(() => localStorage.removeItem("set:view-state"));
  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible();
}

const title = (page: Page) => page.locator("textarea.title");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await booted(page);
  await seedPages(page);
});

test("⌥⌘↑ / ⌥⌘↓ step through the pages sharing a parent", async ({ page }) => {
  await expand(page, "Work");
  await openRow(page, "Roadmap");
  await expect(title(page)).toHaveValue("Roadmap");

  await page.keyboard.press("ControlOrMeta+Alt+ArrowDown");
  await expect(title(page)).toHaveValue("Standups");
  await page.keyboard.press("ControlOrMeta+Alt+ArrowDown");
  await expect(title(page)).toHaveValue("Retro");

  await page.keyboard.press("ControlOrMeta+Alt+ArrowDown");
  await expect(title(page)).toHaveValue("Retro");

  await page.keyboard.press("ControlOrMeta+Alt+ArrowUp");
  await expect(title(page)).toHaveValue("Standups");
  await page.keyboard.press("ControlOrMeta+Alt+ArrowUp");
  await expect(title(page)).toHaveValue("Roadmap");
  await page.keyboard.press("ControlOrMeta+Alt+ArrowUp");
  await expect(title(page)).toHaveValue("Roadmap");

  await openRow(page, "Work");
  await expect(title(page)).toHaveValue("Work");
  await page.keyboard.press("ControlOrMeta+Alt+ArrowDown");
  await expect(title(page)).toHaveValue("Personal");
});

test("the sibling keys stay put on the page the tree is rooted at", async ({ page }) => {
  await expand(page, "Work");
  await openRow(page, "Work");
  await page.getByTestId("page-menu").click();
  await page.getByTestId("page-menu-chroot").click();
  await expect(title(page)).toHaveValue("Work");

  await page.keyboard.press("ControlOrMeta+Alt+ArrowDown");
  await expect(title(page)).toHaveValue("Work");
  await page.keyboard.press("ControlOrMeta+Alt+ArrowUp");
  await expect(title(page)).toHaveValue("Work");

  await openRow(page, "Roadmap");
  await expect(title(page)).toHaveValue("Roadmap");
  await page.keyboard.press("ControlOrMeta+Alt+ArrowDown");
  await expect(title(page)).toHaveValue("Standups");
});

test("the new-child key makes a page inside the open one", async ({ page }) => {
  await expand(page, "Work");
  await openRow(page, "Personal");
  await expect(title(page)).toHaveValue("Personal");

  await page.keyboard.press("ControlOrMeta+Alt+Shift+KeyN");
  await expect(title(page)).toHaveValue("");

  const personalRow = page.locator(".page-row", { hasText: "Personal" }).first();
  await expect(personalRow.locator(".twisty")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".page-row")).toHaveCount(6);

  await page.keyboard.press("ControlOrMeta+Alt+ArrowDown");
  await expect(title(page)).toHaveValue("");
});

test("⌘[ and ⌘] step back and forward through the pages you've opened", async ({
  page,
}) => {
  await openRow(page, "Work");
  await expect(title(page)).toHaveValue("Work");
  await openRow(page, "Personal");
  await expect(title(page)).toHaveValue("Personal");

  await page.keyboard.press("ControlOrMeta+BracketLeft");
  await expect(title(page)).toHaveValue("Work");

  await page.keyboard.press("ControlOrMeta+BracketRight");
  await expect(title(page)).toHaveValue("Personal");
});

test("opening the page you're already on is not a step to go back through", async ({
  page,
}) => {
  await openRow(page, "Work");
  await openRow(page, "Personal");
  await openRow(page, "Personal");
  await openRow(page, "Personal");

  // Three clicks, one entry.
  await page.keyboard.press("ControlOrMeta+BracketLeft");
  await expect(title(page)).toHaveValue("Work");
});

test("a reload doesn't lose the steps already taken", async ({ page }) => {
  await openRow(page, "Work");
  await expect(title(page)).toHaveValue("Work");
  await openRow(page, "Personal");
  await expect(title(page)).toHaveValue("Personal");

  await page.keyboard.press("ControlOrMeta+BracketLeft");
  await expect(title(page)).toHaveValue("Work");

  // The window's history survives a reload, so the count of it has to as well.
  await page.reload();
  await expect(page.locator(".ProseMirror")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+BracketRight");
  await expect(title(page)).toHaveValue("Personal");

  await page.keyboard.press("ControlOrMeta+BracketLeft");
  await expect(title(page)).toHaveValue("Work");
});

test("the back key is rebindable", async ({ page }) => {
  await openRow(page, "Work");
  await openRow(page, "Personal");

  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await page.getByTestId("settings-tab-shortcuts").click();
  const chip = page.getByTestId("shortcut-navBack");

  await expect(chip).toHaveText(/(⌘|Ctrl\+)\[/);
  await chip.click();
  await page.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
  await page.getByRole("button", { name: "Rebind" }).click();
  await expect(chip).toHaveText(/(⌘⌥|Ctrl\+Alt\+)←/);
  await page.keyboard.press("Escape");

  await page.keyboard.press("ControlOrMeta+Alt+ArrowLeft");
  await expect(title(page)).toHaveValue("Work");
});

test("focus mode takes the chrome away, and Escape brings it back", async ({ page }) => {
  await openRow(page, "Personal");
  await expect(page.locator("aside.sidebar")).toBeVisible();
  await expect(page.getByTestId("page-menu")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+Shift+KeyF");

  await expect(page.locator("aside.sidebar")).toBeHidden();
  await expect(page.getByTestId("page-menu")).toBeHidden();
  await expect(page.locator(".sidebar-reopen")).toBeHidden();

  await expect(page.locator(".ProseMirror")).toBeVisible();
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("still writing");
  await expect(page.locator(".ProseMirror")).toContainText("still writing");

  await page.keyboard.press("ControlOrMeta+Shift+KeyF");
  await expect(page.locator("aside.sidebar")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+Shift+KeyF");
  await expect(page.locator("aside.sidebar")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator("aside.sidebar")).toBeVisible();
  await expect(page.getByTestId("page-menu")).toBeVisible();
});

test("focus mode leaves a collapsed sidebar collapsed on the way out", async ({
  page,
}) => {
  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(page.locator("aside.sidebar")).toBeHidden();
  await expect(page.locator(".sidebar-reopen")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+Shift+KeyF");
  await expect(page.locator(".sidebar-reopen")).toBeHidden();

  await page.keyboard.press("ControlOrMeta+Shift+KeyF");
  await expect(page.locator("aside.sidebar")).toBeHidden();
  await expect(page.locator(".sidebar-reopen")).toBeVisible();
});

test("⌥⌘A flips the theme, and the choice sticks", async ({ page }) => {
  const root = page.locator("html");

  await expect(root).not.toHaveAttribute("data-theme");

  await page.keyboard.press("ControlOrMeta+Alt+KeyA");
  await expect(root).toHaveAttribute("data-theme", "dark");
  await page.keyboard.press("ControlOrMeta+Alt+KeyA");
  await expect(root).toHaveAttribute("data-theme", "light");

  await page.reload();
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await expect(root).toHaveAttribute("data-theme", "light");
});

test("the switcher sets the appearance mode, System included", async ({ page }) => {
  const root = page.locator("html");

  await expect(root).not.toHaveAttribute("data-theme");

  const type = async (query: string) => {
    await page.keyboard.press("ControlOrMeta+k");
    await page
      .getByRole("textbox", { name: "Search pages, text, and commands" })
      .fill(query);
  };
  const command = (label: string) =>
    page.getByTestId("command-result").filter({ hasText: label });

  await type("dark");
  await command("Dark theme").click();
  await expect(root).toHaveAttribute("data-theme", "dark");

  await type("theme");
  await expect(command("Dark theme")).toHaveCount(0);
  await expect(command("Light theme")).toHaveCount(1);

  await type("appearance");
  await command("System theme").click();
  await expect(root).not.toHaveAttribute("data-theme");
});

test("⌘⇧⌫ asks before trashing the open page, and the switcher's Open Trash command opens the trash", async ({
  page,
}) => {
  await openRow(page, "Personal");
  await expect(title(page)).toHaveValue("Personal");

  await page.keyboard.press("ControlOrMeta+Shift+Backspace");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Move to Trash? You can restore it later.");

  await expect(page.locator(".page-row")).toHaveCount(2);

  await dialog.getByRole("button", { name: "Move to Trash" }).click();
  await expect(page.locator(".page-row")).toHaveCount(1);

  await page.keyboard.press("ControlOrMeta+k");
  await page
    .getByRole("textbox", { name: "Search pages, text, and commands" })
    .fill("trash");
  await page.getByTestId("command-result").filter({ hasText: "Open Trash" }).click();
  const trash = page.getByRole("dialog", { name: "Trash" });
  await expect(trash).toBeVisible();
  await expect(trash).toContainText("Personal");
});

test("⌘⇧Y opens the trash, and the switcher says so", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+Shift+KeyY");
  const trash = page.getByRole("dialog", { name: "Trash" });
  await expect(trash).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trash).toBeHidden();

  await page.keyboard.press("ControlOrMeta+k");
  await page
    .getByRole("textbox", { name: "Search pages, text, and commands" })
    .fill("trash");
  await expect(
    page.getByTestId("command-result").filter({ hasText: "Open Trash" }),
  ).toContainText(/(⌘⇧|Ctrl\+Shift\+)Y/);
});

test("the page ⋯ menu's Delete asks before trashing the open page too", async ({
  page,
}) => {
  await openRow(page, "Personal");
  await expect(title(page)).toHaveValue("Personal");

  await page.getByTestId("page-menu").click();
  await page.getByTestId("page-menu-delete").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Move to Trash? You can restore it later.");
  await expect(page.locator(".page-row")).toHaveCount(2);

  await dialog.getByRole("button", { name: "Move to Trash" }).click();
  await expect(page.locator(".page-row")).toHaveCount(1);
});

test("the trash key is refused on a locked page, with the reason", async ({ page }) => {
  await openRow(page, "Personal");
  await expect(title(page)).toHaveValue("Personal");
  await page.keyboard.press("ControlOrMeta+Shift+KeyL");
  await expect(page.locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");

  await page.keyboard.press("ControlOrMeta+Shift+Backspace");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".toast")).toContainText("is locked");
  await expect(page.locator(".page-row")).toHaveCount(2);

  await page.keyboard.press("ControlOrMeta+Shift+KeyL");
  await expect(page.locator(".toast")).toHaveCount(0);
});
