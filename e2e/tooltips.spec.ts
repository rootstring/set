import { test, expect, type Page } from "@playwright/test";
import { firstPage } from "./app";

/**
 * Two things can quietly break: the native tooltip coming back, and the borrowed `title` not being
 * handed back.
 */

const tip = (page: Page) => page.locator(".tip.shown");

test.beforeEach(async ({ page }) => {
  await firstPage(page);
});

test("a hint appears on hover", async ({ page }) => {
  const search = page.getByRole("button", { name: "Search" });
  await search.hover();

  // Timing is SHOW_DELAY's job; a stopwatch here would only measure the machine.
  await expect(tip(page)).toHaveText(/Search/);
});

test("the native tooltip is suppressed while ours stands in, and restored after", async ({
  page,
}) => {
  const search = page.getByRole("button", { name: "Search" });
  const before = await search.getAttribute("title");
  expect(before).toContain("Search");

  await search.hover();
  await expect(tip(page)).toBeVisible();
  // Both at once would be the bug: the browser draws its own from `title`.
  await expect(search).not.toHaveAttribute("title", /./);

  await page.mouse.move(0, 0);
  await expect(tip(page)).toBeHidden();
  await expect(search).toHaveAttribute("title", before!);
});

test("pressing a key takes the hint away", async ({ page }) => {
  await page.getByRole("button", { name: "Search" }).hover();
  await expect(tip(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(tip(page)).toBeHidden();
});

test("the footer's Trash and Settings hints name their keys", async ({ page }) => {
  await expect(page.getByRole("button", { name: "Trash", exact: true })).toHaveAttribute(
    "title",
    /^Trash \((⌘⇧|Ctrl\+Shift\+)Y\)$/,
  );
  // The browser keeps ⌘, for itself, so the web build's key has Shift too.
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toHaveAttribute("title", /^Settings \((⌘⇧|Ctrl\+Shift\+),\)$/);
});
