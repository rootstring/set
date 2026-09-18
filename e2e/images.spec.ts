import { test, expect, type Page } from "@playwright/test";
import { firstPage } from "./app";
import { storedFiles } from "./db";

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">' +
  '<rect width="400" height="300" fill="tomato"/></svg>';

async function pasteImage(page: Page): Promise<void> {
  await page.evaluate((svg) => {
    const file = new File([svg], "sunset.svg", { type: "image/svg+xml" });
    const data = new DataTransfer();
    data.items.add(file);
    document.querySelector(".ProseMirror")!.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, SVG);
}

async function dropImage(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(
    ({ svg, x, y }) => {
      const file = new File([svg], "dropped.svg", { type: "image/svg+xml" });
      const data = new DataTransfer();
      data.items.add(file);
      document.querySelector(".ProseMirror")!.dispatchEvent(
        new DragEvent("drop", {
          dataTransfer: data,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { svg: SVG, x, y },
  );
}

test("an image dropped from the OS lands sized to fit", async ({ page }) => {
  await firstPage(page);
  const editor = page.locator(".ProseMirror");
  await editor.click();

  const box = (await editor.boundingBox())!;
  await dropImage(page, box.x + box.width / 2, box.y + 20);

  const img = page.locator(".image-block img");
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("src", /^blob:/);

  const shown = (await img.boundingBox())!;
  expect(shown.width).toBeLessThanOrEqual(box.width);
  expect(await img.evaluate((el: HTMLImageElement) => el.style.width)).toBe("");
  await expect
    .poll(() => storedFiles(page), { timeout: 15_000 })
    .toMatch(/!\[dropped]\(Untitled\/Set-page-assets\/[a-z0-9]+\.svg\)/);
});

test("an image pastes, renders, and round-trips through Markdown", async ({ page }) => {
  await firstPage(page);
  const editor = page.locator(".ProseMirror");
  await editor.click();

  await pasteImage(page);

  const img = page.locator(".image-block img");
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("src", /^blob:/);
  await expect(page.locator(".image-block.missing")).toHaveCount(0);

  expect(await img.evaluate((el: HTMLImageElement) => el.style.width)).toBe("");
  const dropped = (await img.boundingBox())!;
  expect(Math.round(dropped.width)).toBe(400);

  await expect
    .poll(() => storedFiles(page), { timeout: 15_000 })
    .toMatch(/!\[sunset]\(Untitled\/Set-page-assets\/[a-z0-9]+\.svg\)/);
  expect(await storedFiles(page)).not.toContain("blob:");
});

test("dragging a grip resizes the image and records the width", async ({ page }) => {
  await firstPage(page);
  const editor = page.locator(".ProseMirror");
  await editor.click();
  await pasteImage(page);

  const img = page.locator(".image-block img");
  await expect(img).toBeVisible();

  const grip = page.locator(".image-grip");
  const box = (await grip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 150, box.y + box.height / 2, {
    steps: 10,
  });
  await page.mouse.up();

  const resized = (await img.boundingBox())!;
  expect(Math.round(resized.width)).toBeCloseTo(250, -1);

  await expect
    .poll(() => storedFiles(page), { timeout: 15_000 })
    .toMatch(
      /<img src="Untitled\/Set-page-assets\/[a-z0-9]+\.svg" alt="sunset" width="2\d\d">/,
    );
});

test("a resized image survives a reload", async ({ page }) => {
  await firstPage(page);
  const editor = page.locator(".ProseMirror");
  await editor.click();
  await pasteImage(page);
  await expect(page.locator(".image-block img")).toBeVisible();

  const grip = page.locator(".image-grip");
  const box = (await grip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2, {
    steps: 6,
  });
  await page.mouse.up();
  await expect.poll(() => storedFiles(page), { timeout: 15_000 }).toContain("<img src=");

  await page.reload();
  const img = page.locator(".image-block img");
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("src", /^blob:/);

  expect(await img.evaluate((el: HTMLImageElement) => el.style.width)).toMatch(
    /^2\d\dpx$/,
  );
});
