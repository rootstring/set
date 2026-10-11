import { test, expect, type Page } from "@playwright/test";
import { booted } from "./app";
import { livePages, putPages } from "./db";

/** A drag held at the top or bottom of the page scrolls it, so the drop can go out of view. */

const PAGE = "d-scroll";
const LINES = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`);

const scrollTop = (page: Page) => page.locator(".content").evaluate((el) => el.scrollTop);

async function body(page: Page): Promise<string[]> {
  const file = (await livePages(page)).find((p) => p.id === PAGE)?.file ?? "";
  return file
    .replace(/^---\n[\s\S]*?\n---\n*/, "")
    .split("\n")
    .filter((line) => line.trim());
}

/** Pick up the block reading `text` by its handle, and leave it held. */
async function pickUp(page: Page, text: string): Promise<void> {
  const block = page.locator(".ProseMirror > p", { hasText: new RegExp(`^${text}$`) });
  const box = (await block.boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  const handle = page.locator(".drag-handle");
  await expect(handle).toBeVisible();
  await page.waitForTimeout(120);
  const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await booted(page);
  await putPages(page, [{ id: PAGE, title: "Scroll", body: LINES.join("\n\n") }]);
  await page.goto("/");
  await expect(page.locator(".ProseMirror > p").first()).toBeVisible();
});

test("a block held at the bottom edge scrolls the page down, and drops there", async ({
  page,
}) => {
  const area = (await page.locator(".content").boundingBox())!;
  const x = area.x + area.width / 2;
  expect(await scrollTop(page)).toBe(0);

  await pickUp(page, "line 2");
  await page.mouse.move(x, area.y + area.height - 8, { steps: 12 });
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(600);

  // Back into the middle: it stops, and the drop lands on what scrolled into view.
  await page.mouse.move(x, area.y + area.height / 2, { steps: 4 });
  await page.waitForTimeout(100);
  const settled = await scrollTop(page);
  await page.waitForTimeout(200);
  expect(await scrollTop(page)).toBe(settled);

  await page.mouse.up();
  await expect.poll(async () => (await body(page)).indexOf("line 2")).toBeGreaterThan(15);
  expect(await body(page)).toHaveLength(LINES.length);
});

test("a block held at the top edge scrolls the page back up", async ({ page }) => {
  const content = page.locator(".content");
  await content.evaluate((el) => (el.scrollTop = el.scrollHeight));
  const start = await scrollTop(page);
  expect(start).toBeGreaterThan(600);

  const area = (await content.boundingBox())!;
  await pickUp(page, "line 78");
  await page.mouse.move(area.x + area.width / 2, area.y + 8, { steps: 12 });
  await expect.poll(() => scrollTop(page)).toBeLessThan(start - 600);

  await page.mouse.up();
  // It stops with the drop.
  await page.waitForTimeout(100);
  const settled = await scrollTop(page);
  await page.waitForTimeout(200);
  expect(await scrollTop(page)).toBe(settled);
});
