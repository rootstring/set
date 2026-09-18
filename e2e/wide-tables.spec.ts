import { test, expect, type Page } from "@playwright/test";
import { booted } from "./app";
import { putPages } from "./db";

// Playwright's Chromium hides scrollbars; this forces its own worker, hence a file apart from
// tables.spec.ts.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

const COLUMNS = 30;

/** A GFM table far wider than the reading column. */
function wideTable(): string {
  const row = (cell: (c: number) => string) =>
    `| ${Array.from({ length: COLUMNS }, (_, c) => cell(c)).join(" | ")} |`;
  return [row((c) => `Col ${c + 1}`), row(() => "---"), row((c) => `v${c + 1}`)].join(
    "\n",
  );
}

async function openWideTable(page: Page) {
  await page.goto("/");
  await booted(page);
  await putPages(page, [
    { id: "wide", title: "Wide", body: `${wideTable()}\n\nAfter the table.` },
  ]);
  await page.evaluate(() => localStorage.removeItem("set:view-state"));
  await page.goto("/");
  await expect(page.locator(".ProseMirror table")).toHaveCount(1);
  return page.locator(".ProseMirror .tableWrapper");
}

test("a table wider than the page scrolls sideways on its own, with a scrollbar", async ({
  page,
}) => {
  const wrapper = await openWideTable(page);

  const sizes = await wrapper.evaluate((el) => ({
    overflows: el.scrollWidth > el.clientWidth,
    scrollbar: el.offsetHeight - el.clientHeight,
    // The editor around it stays the width of the reading column.
    pageOverflows:
      document.querySelector(".ProseMirror")!.scrollWidth >
      document.querySelector(".ProseMirror")!.clientWidth,
  }));
  expect(sizes.overflows).toBe(true);
  expect(sizes.scrollbar).toBeGreaterThan(0);
  expect(sizes.pageOverflows).toBe(false);

  await wrapper.hover({ position: { x: 40, y: 20 } });
  await page.mouse.wheel(400, 0);
  await expect.poll(() => wrapper.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
});

test("a wide table's bars stay clear of its scrollbar, and reachable past its edge", async ({
  page,
}) => {
  const wrapper = await openWideTable(page);
  const addRow = page.locator(".table-add-row");
  const addColumn = page.locator(".table-add-col");

  await wrapper.hover({ position: { x: 40, y: 20 } });
  await expect(addRow).toBeVisible();
  const edge = (await wrapper.boundingBox())!;
  // The scrollbar is the bottom strip of the wrapper; the bar starts below it.
  expect((await addRow.boundingBox())!.y).toBeGreaterThanOrEqual(edge.y + edge.height);

  // The table runs to the edge of the reading column, so between it and the
  // column bar the pointer is over neither.
  const bar = (await addColumn.boundingBox())!;
  const y = edge.y + 20;
  await page.mouse.move(edge.x + edge.width - 2, y);
  await page.mouse.move(edge.x + edge.width + 2, y);
  await expect(addColumn).toBeVisible();
  await page.mouse.move(bar.x + bar.width / 2, y);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.locator(".ProseMirror tr").first().locator("th")).toHaveCount(
    COLUMNS + 1,
  );
});
