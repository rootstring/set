import { test, expect, type Page } from "@playwright/test";
import { openEditor } from "./app";
import { storedBody } from "./db";

/** Every URL the page fetched that belongs to KaTeX: its script, its stylesheet, its fonts. */
function katexRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (request) => {
    if (/katex/i.test(request.url())) urls.push(request.url());
  });
  return urls;
}

const dialog = (page: Page) => page.getByTestId("math-dialog");
const source = (page: Page) => page.getByTestId("math-source");

test("dollars around LaTeX make an equation, and a price stays a price", async ({
  page,
}) => {
  const editor = await openEditor(page);

  await page.keyboard.type("costs $5 and $10, so $e^{i\\pi} + 1 = 0$ holds");

  const equation = editor.locator(".math-inline");
  await expect(equation).toHaveCount(1);
  await expect(equation.locator(".katex")).toHaveCount(1);
  await expect(editor.locator("p")).toContainText("costs $5 and $10, so");

  const body = "costs $5 and $10, so $e^{i\\pi} + 1 = 0$ holds";
  await expect.poll(() => storedBody(page)).toBe(body);

  await page.reload();
  await editor.waitFor();
  await expect(editor.locator(".math-inline .katex")).toHaveCount(1);
  await expect.poll(() => storedBody(page)).toBe(body);
});

test("$$ opens the dialog for a block, which draws the source as it is typed", async ({
  page,
}) => {
  const editor = await openEditor(page);

  await page.keyboard.type("$$ ");
  await expect(source(page)).toBeFocused();
  await expect(editor.locator(".math-block")).toHaveCount(1);

  await source(page).fill("\\frac{a}{b}");
  await expect(page.getByTestId("math-preview").locator(".katex")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveCount(0);

  const block = editor.locator(".math-block");
  await expect(block.locator(".katex-display")).toBeVisible();
  await expect(block.locator(".math-source")).toHaveCount(0);

  // The caret lands in a paragraph after the block.
  await page.keyboard.type("after");
  await expect(editor.locator("p")).toHaveText("after");
  await expect.poll(() => storedBody(page)).toBe("$$\n\\frac{a}{b}\n$$\n\nafter");

  // A click opens it again with the source; Shift+Enter is a second line, and Save writes the
  // change.
  await block.click();
  await expect(source(page)).toHaveValue("\\frac{a}{b}");
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("+ c");
  await expect(source(page)).toHaveValue("\\frac{a}{b}\n+ c");
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => storedBody(page)).toBe("$$\n\\frac{a}{b}\n+ c\n$$\n\nafter");

  await page.reload();
  await editor.waitFor();
  await expect(editor.locator(".math-block .katex-display")).toBeVisible();
});

test("a parse error shows in the dialog and cannot be saved", async ({ page }) => {
  const editor = await openEditor(page);

  await page.keyboard.type("$$ ");
  await source(page).fill("\\frac{a}{");
  const error = page.getByTestId("math-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("expected '}'");
  await expect(page.getByRole("button", { name: "Add equation" })).toBeDisabled();
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveCount(1);

  await source(page).fill("\\frac{a}{b}");
  await expect(error).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add equation" })).toBeEnabled();

  // Dismissed with nothing kept, a new block goes away.
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(editor.locator(".math-block")).toHaveCount(0);
  await expect.poll(() => storedBody(page)).toBe("");
});

test("the slash command inserts an inline equation through the dialog", async ({
  page,
}) => {
  const editor = await openEditor(page);

  await page.keyboard.type("Area: ");
  await page.keyboard.type("/inline");
  await page.keyboard.press("Enter");

  await expect(source(page)).toBeFocused();
  await source(page).fill("\\pi r^2");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveCount(0);

  await expect(editor.locator(".math-inline .katex")).toHaveCount(1);
  await page.keyboard.type(" done");
  await expect.poll(() => storedBody(page)).toBe("Area: $\\pi r^2$ done");

  // A click opens it again; Escape keeps what was there.
  await editor.locator(".math-inline").click();
  await expect(source(page)).toHaveValue("\\pi r^2");
  await source(page).fill("r");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(() => storedBody(page)).toBe("Area: $\\pi r^2$ done");

  // Enter on the selected equation opens it too; Backspace removes it.
  await editor.locator(".math-inline").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await expect(source(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Backspace");
  await expect(editor.locator(".math-inline")).toHaveCount(0);
  await expect.poll(() => storedBody(page)).toBe("Area:  done");
});

test("pasted prices stay prose, and a typed pair of dollars stays text in the file", async ({
  page,
}) => {
  const editor = await openEditor(page);

  await page.keyboard.type("costs ");
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "$5 and $10 each");
    document
      .querySelector(".ProseMirror")!
      .dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
  });
  await expect(editor.locator("p")).toHaveText("costs $5 and $10 each");
  await expect(editor.locator(".math-inline")).toHaveCount(0);
  await expect.poll(() => storedBody(page)).toBe("costs $5 and $10 each");

  // Typed with the closing dollar first, no rule fires; the file escapes it for the next load.
  await page.keyboard.press("Enter");
  await page.keyboard.type("$$");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("ab");
  await expect(editor.locator("p").nth(1)).toHaveText("$ab$");
  await expect(editor.locator(".math-inline")).toHaveCount(0);
  await expect.poll(() => storedBody(page)).toBe("costs $5 and $10 each\n\n\\$ab$");

  await page.reload();
  await editor.waitFor();
  await expect(editor.locator("p").nth(1)).toHaveText("$ab$");
  await expect(editor.locator(".math-inline")).toHaveCount(0);
});

test("KaTeX is fetched for the first equation, not for the app", async ({ page }) => {
  const requests = katexRequests(page);
  const editor = await openEditor(page);

  await page.keyboard.type("no math here yet");
  await expect(editor.locator("p")).toHaveText("no math here yet");
  expect(requests).toEqual([]);

  await page.keyboard.press("Enter");
  await page.keyboard.type("$x^2$");
  await expect(editor.locator(".math-inline .katex")).toHaveCount(1);
  // The script's chunk carries a hash for a name; the stylesheet and fonts keep theirs.
  expect(requests.some((url) => /katex.*\.css$/i.test(url))).toBe(true);
});
