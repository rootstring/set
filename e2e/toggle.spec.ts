import { test, expect, type Page } from "@playwright/test";
import { openEditor } from "./app";
import { storedBody } from "./db";

/**
 * Converting a line with text must keep it as the summary and win over the blockquote rule, which
 * shares the `> ` marker.
 */

/**
 * The wait is load bearing: a native caret move reaches ProseMirror on a later `selectionchange`.
 * Chrome now and then drops a Home that lands a few milliseconds after a keystroke, so it is
 * pressed again until the caret moves.
 */
async function typeAtLineStart(page: Page, text: string) {
  await expect(async () => {
    await page.keyboard.press("Home");
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.anchorOffset ?? -1), {
        timeout: 1000,
      })
      .toBe(0);
  }).toPass();
  await page.keyboard.type(text);
}

test("`> ` in front of a written line keeps the line as the summary", async ({
  page,
}) => {
  const editor = await openEditor(page);

  await page.keyboard.type("groceries");
  await typeAtLineStart(page, "> ");

  const summary = editor.locator(".details .details-summary");
  await expect(summary).toHaveText("groceries");
  await expect(editor.locator("blockquote")).toHaveCount(0);

  // The caret stays where it was, in front of the text it just re-homed.
  await page.keyboard.type("weekly ");
  await expect(summary).toHaveText("weekly groceries");
});

test("`> ` on a heading makes a toggle, not a quote", async ({ page }) => {
  const editor = await openEditor(page);

  await page.keyboard.type("## plans");
  await typeAtLineStart(page, "> ");

  await expect(editor.locator("blockquote")).toHaveCount(0);
  await expect(editor.locator(".details .details-summary")).toHaveText("plans");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("ship it");

  await expect
    .poll(() => storedBody(page))
    .toBe("<details open>\n<summary>plans</summary>\n\nship it\n\n\n</details>");
});

test("the slash command converts the line it was typed on", async ({ page }) => {
  const editor = await openEditor(page);

  await page.keyboard.type("packing list /toggle");
  await page.keyboard.press("Enter");

  await expect(editor.locator(".details .details-summary")).toHaveText("packing list");
});
