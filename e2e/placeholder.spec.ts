import { test, expect, type Page } from "@playwright/test";
import { firstPage } from "./app";

/**
 * The prompt belongs on a page with nothing on it and nowhere else. The decoration is still applied
 * elsewhere but carries no text.
 */

/** The empty lines currently showing a prompt, whatever it says. */
const prompts = (page: Page) =>
  page.locator('.ProseMirror [data-placeholder]:not([data-placeholder=""])');

test("the prompt is on an empty page, and only on an empty page", async ({ page }) => {
  await firstPage(page);
  const editor = page.locator(".ProseMirror");
  await editor.click();

  await expect(prompts(page)).toHaveAttribute("data-placeholder", /Write something/);

  // Write on it, and the prompt goes with the emptiness.
  await page.keyboard.type("First line");
  await expect(prompts(page)).toHaveCount(0);

  // A line below it is empty and has the caret, and still says nothing.
  await page.keyboard.press("Enter");
  await expect(editor.locator("p")).toHaveCount(2);
  await expect(prompts(page)).toHaveCount(0);

  // Nor does one between two written paragraphs.
  await page.keyboard.type("Third line");
  await page.keyboard.press("ArrowUp");
  await expect(prompts(page)).toHaveCount(0);

  // Empty the page again and it comes back.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await expect(prompts(page)).toHaveAttribute("data-placeholder", /Write something/);
});

test("on a page with nothing written yet, only the first line prompts", async ({
  page,
}) => {
  await firstPage(page);
  const editor = page.locator(".ProseMirror");
  await editor.click();

  // Lines below the first, all of them still empty: the page has no text, but
  // the caret is not on its first line.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(editor.locator("p")).toHaveCount(3);
  await expect(prompts(page)).toHaveCount(0);

  // Back on the first, it does.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(prompts(page)).toHaveAttribute("data-placeholder", /Write something/);
});

test("the line below an empty table says nothing", async ({ page }) => {
  await firstPage(page);
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("/table");
  await page.keyboard.press("Enter");
  await expect(page.locator(".ProseMirror table")).toHaveCount(1);

  // Down the empty cells and out of the table, onto the line below it.
  for (let i = 0; i < 3; i++) await page.keyboard.press("Enter");
  const caretBelowTable = () =>
    page.evaluate(() => {
      const at = window.getSelection()?.anchorNode;
      const line = at instanceof Element ? at : at?.parentElement;
      return line?.closest("p")?.parentElement?.classList.contains("ProseMirror");
    });
  await expect.poll(caretBelowTable).toBe(true);
  await expect(prompts(page)).toHaveCount(0);
});

test("an empty heading still says what it is, on a written page", async ({ page }) => {
  await firstPage(page);
  await page.locator(".ProseMirror").click();

  await page.keyboard.type("First line");
  await page.keyboard.press("Enter");
  await page.keyboard.type("## ");

  // The one naming the block, not the page prompt.
  await expect(prompts(page)).toHaveCount(1);
  await expect(prompts(page)).toHaveAttribute("data-placeholder", "Heading 2");
});
