import { test, expect, type Page } from "@playwright/test";
import { putPages } from "./db";

const SEED_COUNT = 5000;

const MAX_RENDERED_ROWS = 200;

async function seedPages(page: Page, count: number): Promise<void> {
  await putPages(
    page,
    Array.from({ length: count }, (_, i) => ({
      id: `seed-${i}`,
      title: `Page ${i}`,
      body: `Body of page ${i}`,
    })),
    { clear: false },
  );
}

test("sidebar stays virtualized on a large notes folder", async ({ page }) => {
  const timings: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("⏱")) timings.push(text);
  });

  await page.addInitScript(() => {
    try {
      localStorage.setItem("set:perf", "1");
    } catch {}
  });

  await page.goto("/");
  await page.waitForSelector(".sidebar");
  await seedPages(page, SEED_COUNT);
  await page.reload();

  await page.waitForFunction(() => document.querySelectorAll(".page-row").length > 0);

  const initialRows = await page.locator(".page-row").count();
  expect(
    initialRows,
    `virtualization should bound rendered rows; got ${initialRows} of ${SEED_COUNT}`,
  ).toBeLessThan(MAX_RENDERED_ROWS);

  await page.locator(".pages").evaluate((el) => {
    el.scrollTop = 50_000;
  });
  await page.waitForTimeout(150);
  const scrolledRows = await page.locator(".page-row").count();
  expect(
    scrolledRows,
    `virtualization should hold while scrolled; got ${scrolledRows}`,
  ).toBeLessThan(MAX_RENDERED_ROWS);

  await page.locator(".pages").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(50);
  await page.locator(".page-row .page-item").nth(3).click();
  await page.waitForTimeout(50);
  await page.locator(".ProseMirror").click();

  await page.keyboard.type("performance smoke test", { delay: 30 });
  await page.waitForTimeout(200);

  const keystroke = await page.evaluate(() => {
    const perf = (window as unknown as { __setPerf?: { stats(label: string): unknown } })
      .__setPerf;
    if (!perf) return null;
    return {
      total: perf.stats("keystroke"),
      input: perf.stats("keystroke-input"),
      processing: perf.stats("keystroke-processing"),
      presentation: perf.stats("keystroke-presentation"),
    };
  });

  console.log(`\n=== Perf timings (recorded, non-gating): ${timings.length} samples ===`);
  for (const line of timings) console.log(line);

  console.log("\n=== Keystroke → paint (ms) ===");
  if (keystroke) console.table(keystroke);
  else console.log("no samples (perf instrumentation not exposed)");
});
