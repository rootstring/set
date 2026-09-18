import { test, expect, type Page } from "@playwright/test";
import { openEditor } from "./app";
import { storedBody, storedFiles } from "./db";

const lockItem = (page: Page) => page.getByTestId("page-menu-lock");
/** The lock in the breadcrumb: the one mark of a locked page on the page. */
const lock = (page: Page) => page.getByTestId("breadcrumb-unlock");

async function toggleLock(page: Page, expecting: "Lock" | "Unlock"): Promise<void> {
  const before = await storedFiles(page);
  await page.getByTestId("page-menu").click();
  await expect(lockItem(page)).toHaveText(new RegExp(expecting));
  await lockItem(page).click();
  await expect(lockItem(page)).toBeHidden();
  await expect.poll(() => storedFiles(page)).not.toBe(before);
}

test("a locked page refuses edits, and says so", async ({ page }) => {
  const editor = await openEditor(page);
  await page.keyboard.type("before the lock");
  await expect.poll(() => storedFiles(page)).toContain("before the lock");

  await toggleLock(page, "Lock");

  await expect(lock(page)).toBeVisible();
  await expect(page.locator(".page-row .lock-badge")).toHaveCount(1);
  await expect(editor).toHaveAttribute("contenteditable", "false");
  await expect(page.locator("textarea.title")).toHaveAttribute("readonly", "");

  await editor.click();
  await page.keyboard.type("after the lock");
  await page.reload();
  await expect(page.locator(".ProseMirror")).toBeVisible();

  const file = await storedFiles(page);
  expect(file).toContain("before the lock");
  expect(file).not.toContain("after the lock");

  expect(file).toContain("locked: true");
  await expect(lock(page)).toBeVisible();
});

test("unlocking gives editing back, and that survives a reload too", async ({ page }) => {
  const editor = await openEditor(page);
  await page.keyboard.type("first");
  await expect.poll(() => storedFiles(page)).toContain("first");

  await toggleLock(page, "Lock");
  await expect(lock(page)).toBeVisible();

  await toggleLock(page, "Unlock");
  await expect(lock(page)).toHaveCount(0);
  await expect(page.locator(".page-row .lock-badge")).toHaveCount(0);
  await expect(editor).toHaveAttribute("contenteditable", "true");

  expect(await storedFiles(page)).not.toContain("locked");

  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" and second");
  await expect.poll(() => storedFiles(page)).toContain("first and second");

  await page.reload();
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await expect(lock(page)).toHaveCount(0);
  await expect(page.locator(".ProseMirror")).toHaveAttribute("contenteditable", "true");
  await page.getByTestId("page-menu").click();
  await expect(lockItem(page)).toHaveText(/^\s*Lock/);
});

test("the breadcrumb's lock asks before unlocking", async ({ page }) => {
  const editor = await openEditor(page);
  await expect(lock(page)).toHaveCount(0);

  await toggleLock(page, "Lock");
  await expect(lock(page)).toBeVisible();
  const popover = page.getByTestId("confirm-popover");

  // Backing out leaves the lock on.
  await lock(page).click();
  await expect(popover).toBeVisible();
  await popover.getByRole("button", { name: "Cancel" }).click();
  await expect(popover).toBeHidden();
  await expect(lock(page)).toBeVisible();
  await expect(editor).toHaveAttribute("contenteditable", "false");

  await lock(page).click();
  await popover.getByRole("button", { name: "Unlock" }).click();
  await expect(lock(page)).toHaveCount(0);
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await expect(page.locator(".page-row .lock-badge")).toHaveCount(0);
  await expect.poll(() => storedFiles(page)).not.toContain("locked");
});

test("typing at a locked page shakes the lock, and nothing else", async ({ page }) => {
  const editor = await openEditor(page);
  await toggleLock(page, "Lock");
  await expect(lock(page)).toHaveAttribute("data-shakes", "0");

  // Getting about is fine.
  await editor.click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ControlOrMeta+KeyA");
  await expect(lock(page)).toHaveAttribute("data-shakes", "0");

  await page.keyboard.type("a");
  await expect(lock(page)).toHaveAttribute("data-shakes", "1");
  await page.keyboard.press("Enter");
  await expect(lock(page)).toHaveAttribute("data-shakes", "2");
  await expect(page.locator(".toast")).toHaveCount(0);

  // Keys meant for something else — the search box — leave it alone.
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("textbox", { name: "Search pages, text, and commands" }).fill("q");
  await expect(lock(page)).toHaveAttribute("data-shakes", "2");
});

test("the sidebar's lock icon only marks the page, it doesn't unlock it", async ({
  page,
}) => {
  const editor = await openEditor(page);
  await toggleLock(page, "Lock");

  const badge = page.locator(".page-row .lock-badge");
  await expect(badge).toHaveCount(1);
  await expect(
    page.locator(".page-row").getByRole("button", { name: /Unlock/ }),
  ).toHaveCount(0);

  await badge.click();
  await expect(page.getByTestId("confirm-popover")).toBeHidden();
  await expect(lock(page)).toBeVisible();
  await expect(editor).toHaveAttribute("contenteditable", "false");
  expect(await storedFiles(page)).toContain("locked: true");
});

test("the keyboard shortcut locks and unlocks the open page", async ({ page }) => {
  const editor = await openEditor(page);
  await page.keyboard.type("typed before the key");
  await expect.poll(() => storedFiles(page)).toContain("typed before the key");

  await page.keyboard.press("ControlOrMeta+Shift+KeyL");
  await expect(editor).toHaveAttribute("contenteditable", "false");
  await expect.poll(() => storedFiles(page)).toContain("locked: true");

  await page.keyboard.press("ControlOrMeta+Shift+KeyL");
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await expect.poll(() => storedFiles(page)).not.toContain("locked");

  await page.getByTestId("page-menu").click();
  await expect(lockItem(page)).toHaveText(/^\s*Lock/);
});

test("a locked page can't be trashed, from its own row or its parent's", async ({
  page,
}) => {
  await openEditor(page);

  await page.locator(".page-row").first().hover();
  await page.locator(".page-row .add-btn").first().click();
  await expect(page.locator(".page-row")).toHaveCount(2);
  const parentRow = page.locator(".page-row").first();
  const childRow = page.locator(".page-row").nth(1);
  await childRow.locator(".page-item").click();
  await expect(page.locator(".ProseMirror")).toBeVisible();

  await toggleLock(page, "Lock");

  await childRow.hover();
  const childDelete = childRow.locator(".delete-btn");
  await expect(childDelete).toHaveAttribute("aria-disabled", "true");
  await expect(childDelete).toHaveAttribute("title", "Page is locked");

  // The disabled button says why, so the click is simply refused. No toast.
  await childDelete.click({ force: true });
  await expect(page.locator(".toast")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".page-row")).toHaveCount(2);

  await parentRow.hover();
  const parentDelete = parentRow.locator(".delete-btn");
  await expect(parentDelete).toHaveAttribute("aria-disabled", "true");
  await expect(parentDelete).toHaveAttribute("title", "“Untitled” inside is locked");

  await parentDelete.click({ force: true });

  await expect(page.locator(".toast")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".page-row")).toHaveCount(2);

  await toggleLock(page, "Unlock");

  await expect(page.locator(".toast")).toHaveCount(0);

  await childRow.hover();
  await expect(childDelete).toHaveAttribute("aria-disabled", "false");

  await expect(childDelete).toHaveAttribute("title", /^Move to Trash/);
  await parentRow.hover();
  await expect(parentDelete).toHaveAttribute("aria-disabled", "false");

  await parentDelete.click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.locator(".toast")).toHaveCount(0);
});

test("a locked page won't take a new page inside it", async ({ page }) => {
  await openEditor(page);
  await toggleLock(page, "Lock");

  const row = page.locator(".page-row").first();
  await row.hover();
  const add = row.locator(".add-btn");
  await expect(add).toHaveAttribute("aria-disabled", "true");
  await expect(add).toHaveAttribute("title", "Page is locked");

  // Refused in place, like the trash button: the tooltip is the whole message.
  await add.click({ force: true });
  await expect(page.locator(".toast")).toHaveCount(0);
  await expect(page.locator(".page-row")).toHaveCount(1);

  // The keyboard has no tooltip to read, so that path does say it.
  await page.locator(".ProseMirror").click();
  await page.keyboard.press("ControlOrMeta+Alt+Shift+KeyN");
  await expect(page.locator(".toast")).toContainText("Page is locked");
  await expect(page.locator(".page-row")).toHaveCount(1);

  await toggleLock(page, "Unlock");

  await row.hover();
  await expect(add).toHaveAttribute("aria-disabled", "false");
  await add.click();
  await expect(page.locator(".page-row")).toHaveCount(2);
});

test("a locked page's dates are what the note says, not a control", async ({ page }) => {
  const editor = await openEditor(page);
  await page.keyboard.type("due @today");
  // `@` opens the date menu; Enter is what writes the mention.
  await expect(page.locator(".mention-menu .item").first()).toBeVisible();
  await page.keyboard.press("Enter");

  const mention = page.locator(".ProseMirror .date-mention");
  await expect(mention).toHaveText("Today");
  await expect.poll(() => storedFiles(page)).toContain("date:");
  const before = await storedBody(page);

  await toggleLock(page, "Lock");

  await mention.click();
  await expect(page.locator(".date-picker")).toHaveCount(0);
  await expect(mention).toHaveText("Today");
  // It stops offering, too — the pointer is the promise the click would keep.
  expect(await mention.evaluate((el) => getComputedStyle(el).cursor)).toBe("default");

  // The picker writes past `markDirty`'s guard, so the cost shows only when the page is saved for
  // another reason.
  await toggleLock(page, "Unlock");
  expect(await storedBody(page)).toBe(before);

  await mention.click();
  await expect(page.locator(".date-picker")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(editor).toHaveAttribute("contenteditable", "true");
});

test("the page menu greys out what a locked page can't do", async ({ page }) => {
  await openEditor(page);
  await page.keyboard.type("something to keep");

  await toggleLock(page, "Lock");

  await page.getByTestId("page-menu").click();
  const trash = page.getByTestId("page-menu-delete");
  await expect(trash).toBeDisabled();
  await expect(trash).toHaveAttribute("title", "Page is locked");
  // The two that are about the view rather than the document stay live.
  await expect(page.getByTestId("page-menu-chroot")).toBeEnabled();
  await expect(lockItem(page)).toBeEnabled();

  await trash.click({ force: true });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".page-row")).toHaveCount(1);

  await page.keyboard.press("Escape");
  await toggleLock(page, "Unlock");
  await page.getByTestId("page-menu").click();
  await expect(page.getByTestId("page-menu-delete")).toBeEnabled();
});

test("a locked page's child-page block offers no menu of its own", async ({ page }) => {
  await openEditor(page);
  await page.keyboard.type("/page");
  await expect(page.locator(".slash-menu .item").first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("textarea.title")).toHaveValue("");
  await page.locator("textarea.title").fill("Child");
  await expect(page.locator(".page-row")).toHaveCount(2);

  await page.locator(".page-row").first().locator(".page-item").click();
  await expect(page.locator(".ProseMirror .page-link")).toHaveCount(1);
  await toggleLock(page, "Lock");

  // Duplicate would write the copy's link into this page, which is locked.
  await page.locator(".ProseMirror .page-link").click({ button: "right" });
  await expect(page.locator(".block-menu")).toHaveCount(0);
  await expect(page.locator(".page-row")).toHaveCount(2);

  await toggleLock(page, "Unlock");
  await page.locator(".ProseMirror .page-link").click({ button: "right" });
  await expect(page.locator(".block-menu")).toHaveCount(1);
});

test("a locked page's link menu still opens and copies, but won't edit", async ({
  page,
}) => {
  await openEditor(page);
  await page.keyboard.type("[Download](https://example.com/download)");
  await expect(page.locator(".ProseMirror a")).toHaveCount(1);
  await toggleLock(page, "Lock");

  const item = (name: string) => page.locator(".block-menu-item", { hasText: name });

  // Reading the link is not editing the page, so half the menu still works.
  await page.locator(".ProseMirror a").click({ button: "right" });
  await expect(page.locator(".block-menu")).toHaveCount(1);
  await expect(item("Open link")).toBeEnabled();
  await expect(item("Copy link")).toBeEnabled();
  await expect(item("Edit link")).toBeDisabled();
  await expect(item("Remove link")).toBeDisabled();

  await page.keyboard.press("Escape");
  await toggleLock(page, "Unlock");
  await page.locator(".ProseMirror a").click({ button: "right" });
  await expect(item("Edit link")).toBeEnabled();
  await expect(item("Remove link")).toBeEnabled();
});
