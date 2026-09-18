import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { booted } from "./app";
import { livePages, putPages } from "./db";

const PAGES = [
  { id: "e-parent", title: "Parent", parentId: null as string | null },
  { id: "e-child", title: "Child", parentId: "e-parent" as string | null },
];

async function seedPages(page: Page): Promise<void> {
  await page.goto("/");
  await booted(page);
  await putPages(
    page,
    PAGES.map((p) => ({ ...p, body: `Body for ${p.title}.` })),
  );
  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible();
}

async function openSettings(page: Page): Promise<void> {
  await page.keyboard.press("Meta+Shift+Comma");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await seedPages(page);
});

test("exports every page as one JSON bundle", async ({ page }) => {
  await openSettings(page);
  await page.getByTestId("settings-tab-storage").click();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export", exact: true }).click(),
  ]);

  const path = await download.path();
  expect(path).not.toBeNull();
  const bundle = JSON.parse(readFileSync(path!, "utf-8"));

  expect(bundle.version).toBe(2);
  expect(bundle.pages).toHaveLength(PAGES.length);
  for (const p of PAGES) {
    expect(
      bundle.pages.some((exported: { file: string }) =>
        exported.file.includes(`title: ${JSON.stringify(p.title)}`),
      ),
    ).toBe(true);
  }

  for (const exported of bundle.pages as { file: string; context: string }[]) {
    expect(exported.context).toBe("Set");
    expect(exported.file).not.toContain("context:");
  }

  await expect(page.getByRole("dialog", { name: "Settings" })).toContainText(
    `Exported ${PAGES.length} pages`,
  );
});

test("an export from one browser imports into another, sub-pages linked and in order", async ({
  page,
}) => {
  await putPages(page, [
    {
      id: "m-parent",
      title: "Trip",
      body: "Plans.\n\n[Packing](page:m-packing)\n\n[Route](page:m-route)",
    },
    { id: "m-route", title: "Route", parentId: "m-parent", order: 1, body: "North." },
    { id: "m-packing", title: "Packing", parentId: "m-parent", order: 0, body: "Boots." },
  ]);
  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible();

  await openSettings(page);
  await page.getByTestId("settings-tab-storage").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export", exact: true }).click(),
  ]);
  const file = await download.path();

  // The other browser: nothing in it yet.
  await putPages(page, []);
  await page.evaluate(() => localStorage.removeItem("set:view-state"));
  await page.goto("/");
  await expect(page.getByTestId("empty-new-page")).toBeVisible();

  await openSettings(page);
  await page.getByTestId("settings-tab-storage").click();
  await page.getByTestId("import-notes-input").setInputFiles(file!);
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toContainText("Imported 3 pages");
  await page.keyboard.press("Escape");

  const rows = page.locator(".page-row .page-title");
  await expect(rows.first()).toHaveText("Trip");
  await rows.first().click();
  await expect(page.locator(".title")).toHaveValue("Trip");
  await expect(page.locator(".ProseMirror .page-link-title")).toHaveText([
    "Packing",
    "Route",
  ]);
  const stored = await livePages(page);
  const trip = stored.find((r) => r.title === "Trip")!;
  expect(stored.filter((r) => r.parentId === trip.id).map((r) => r.title)).toEqual([
    "Packing",
    "Route",
  ]);

  // The links point at the pages as they are now, not as they were.
  await page.locator(".ProseMirror .page-link").filter({ hasText: "Route" }).click();
  await expect(page.locator(".title")).toHaveValue("Route");
  await expect(page.locator(".ProseMirror")).toContainText("North.");
});

test("a file that isn't a notes export is turned away", async ({ page }) => {
  await openSettings(page);
  await page.getByTestId("settings-tab-storage").click();
  await page.getByTestId("import-notes-input").setInputFiles({
    name: "notes.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"hello":"world"}'),
  });
  await expect(page.getByRole("dialog", { name: "Settings" })).toContainText(
    "doesn't look like a notes export",
  );
});
