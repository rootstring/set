import { test, expect, type Page } from "@playwright/test";
import { booted } from "./app";
import { putPages } from "./db";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await booted(page);
  await putPages(page, [
    {
      id: "d-headings",
      title: "Headings",
      body: "# Heading one\n\nA paragraph.\n\n## Heading two\n\nA paragraph.\n\n### Heading three",
    },
  ]);
  await page.goto("/");
  await expect(page.locator(".ProseMirror h1")).toBeVisible();
});

test("the handle only comes up near its own column", async ({ page }) => {
  const block = page.locator(".ProseMirror > p").first();
  const handle = page.locator(".drag-handle");
  const box = (await block.boundingBox())!;
  const middle = box.y + box.height / 2;

  // Over the block, but well into the text: nothing.
  await page.mouse.move(box.x + 200, middle);
  await page.waitForTimeout(100);
  await expect(handle).toBeHidden();

  // Over its first word: there.
  await page.mouse.move(box.x + 12, middle);
  await expect(handle).toBeVisible();

  // Out in the margin, where the handle stands: still there.
  await page.mouse.move(box.x - 30, middle);
  await expect(handle).toBeVisible();

  // Back into the text: gone again, and it comes back on the way out.
  await page.mouse.move(box.x + 200, middle);
  await expect(handle).toBeHidden();
  await page.mouse.move(box.x + 12, middle);
  await expect(handle).toBeVisible();
});

/** How far the handle's middle is from the middle of the block's first line. */
async function offCentre(page: Page, selector: string): Promise<number> {
  const block = page.locator(`.ProseMirror > ${selector}`).first();
  await block.hover({ position: { x: 20, y: 5 } });
  await expect(page.locator(".drag-handle")).toBeVisible();
  // Give the handle a frame to settle where it's going.
  await page.waitForTimeout(100);
  return page.evaluate((selector) => {
    const block = document.querySelector(`.ProseMirror > ${selector}`)!;
    const handle = document.querySelector(".drag-handle")!.getBoundingClientRect();
    const line = parseFloat(getComputedStyle(block).lineHeight);
    const top = block.getBoundingClientRect().top;
    return handle.top + handle.height / 2 - (top + line / 2);
  }, selector);
}

for (const heading of ["h1", "h2", "h3"]) {
  test(`the handle is centred on an ${heading}'s first line`, async ({ page }) => {
    expect(Math.abs(await offCentre(page, heading))).toBeLessThanOrEqual(1);
  });
}

test("moving from a heading to a paragraph puts the handle back", async ({ page }) => {
  await offCentre(page, "h1");
  expect(Math.abs(await offCentre(page, "p"))).toBeLessThanOrEqual(1);
});
