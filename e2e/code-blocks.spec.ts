import { test, expect, type Page } from "@playwright/test";
import { openEditor } from "./app";
import { storedBody } from "./db";

async function codeBlocks(page: Page): Promise<string[]> {
  return page.locator(".ProseMirror pre code").allInnerTexts();
}

test("``` turns into a code block and takes a language", async ({ page }) => {
  const editor = await openEditor(page);

  await page.keyboard.type("```js ");

  await expect(page.locator(".ProseMirror pre code.language-js")).toHaveCount(1);

  await page.keyboard.type("const x = 1");

  await expect(page.locator(".ProseMirror pre code .hljs-keyword")).toHaveText("const");

  await expect.poll(() => storedBody(page)).toBe("```js\nconst x = 1\n```");

  await expect(page.locator(".ProseMirror pre")).toHaveAttribute("spellcheck", "false");
});

test("the slash command inserts a code block that types normally", async ({ page }) => {
  const editor = await openEditor(page);

  await page.keyboard.type("/code");
  await page.keyboard.press("Enter");
  const block = page.locator(".ProseMirror pre code");
  await expect(block).toHaveCount(1);

  await page.keyboard.type("one");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("two");
  await expect(editor.locator("pre")).toHaveCount(1);
  await expect(block).toHaveText("one\n  two");

  await expect.poll(() => storedBody(page)).toBe("```plaintext\none\n  two\n```");
});

test("a code block containing a fence survives the round trip", async ({ page }) => {
  await openEditor(page);

  await page.keyboard.type("```md ");
  await page.keyboard.type("```js");
  await page.keyboard.press("Enter");
  await page.keyboard.type("const x = 1");
  await page.keyboard.press("Enter");
  await page.keyboard.type("```");
  const body = "```js\nconst x = 1\n```";
  expect(await codeBlocks(page)).toEqual([body]);

  await expect.poll(() => storedBody(page)).toBe("````md\n" + body + "\n````");

  await page.reload();
  await page.locator(".ProseMirror").waitFor();
  await expect(page.locator(".ProseMirror pre")).toHaveCount(1);
  expect(await codeBlocks(page)).toEqual([body]);
});

test("content after a fenced code block is never swallowed", async ({ page }) => {
  await openEditor(page);

  await page.keyboard.type("```md ");
  await page.keyboard.type("```");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("the paragraph after");

  await expect
    .poll(() => storedBody(page))
    .toBe("````md\n```\n````\n\nthe paragraph after");

  await page.reload();
  const editor = page.locator(".ProseMirror");
  await editor.waitFor();
  await expect(editor.locator("pre")).toHaveCount(1);
  await expect(editor.locator("p")).toHaveText("the paragraph after");

  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("!");
  await expect(editor.locator("p")).toHaveText("the paragraph after!");
});

test("inline code holding a backtick round-trips too", async ({ page }) => {
  const editor = await openEditor(page);

  await page.keyboard.type("run `a` now");
  await expect(editor.locator("code")).toHaveText("a");

  await expect.poll(() => storedBody(page)).toBe("run `a` now");

  await page.reload();
  await editor.waitFor();
  await expect(editor.locator("code")).toHaveText("a");
  await expect(editor.locator("p")).toHaveText("run a now");
});
