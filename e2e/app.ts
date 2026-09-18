import { expect, type Locator, type Page } from "@playwright/test";

/** A fresh profile has no pages: the app shows the empty state rather than inventing one. */

/** The shell is up: either a page is open, or the empty state says none is. */
export async function booted(page: Page): Promise<void> {
  await expect(
    page.locator('.ProseMirror, [data-testid="empty-new-page"]').first(),
  ).toBeVisible();
}

/** Open the app on a fresh profile and make the first page. */
export async function firstPage(page: Page): Promise<void> {
  await page.goto("/");
  await booted(page);

  const editor = page.locator(".ProseMirror");
  if (!(await editor.isVisible())) {
    await page.getByTestId("empty-new-page").click();
  }
  await expect(editor).toBeVisible();
}

/** A fresh profile's first page, with the caret in its body. */
export async function openEditor(page: Page): Promise<Locator> {
  await firstPage(page);
  const editor = page.locator(".ProseMirror");
  await editor.click();
  return editor;
}

/** Open a page from its row in the sidebar. */
export async function openRow(page: Page, title: string): Promise<void> {
  await page.locator(".page-row .page-item", { hasText: title }).first().click();
}

/** Unfold a sidebar row's children, if it has any and they are folded. */
export async function expand(page: Page, title: string): Promise<void> {
  const twisty = page.locator(".page-row", { hasText: title }).first().locator(".twisty");
  if (
    (await twisty.count()) &&
    (await twisty.getAttribute("aria-expanded")) === "false"
  ) {
    await twisty.click();
  }
}

/** Move the app to another context with the sidebar's switcher. */
export async function switchTo(page: Page, name: string): Promise<void> {
  const switcher = page.getByTestId("context-switcher");
  await switcher.click();
  await page.getByTestId("context-option").filter({ hasText: name }).click();
  await expect(switcher.locator(".context-name")).toHaveText(name);
}
