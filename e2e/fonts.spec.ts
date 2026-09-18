import { test, expect } from "@playwright/test";
import { firstPage } from "./app";

function covers(range: string, code: number): boolean {
  return range.split(",").some((entry) => {
    const match = /^U\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?$/i.exec(entry.trim());
    if (!match) return false;
    const [, first, second] = match;

    const start = parseInt(first.replace(/\?/g, "0"), 16);
    const end = second ? parseInt(second, 16) : parseInt(first.replace(/\?/g, "f"), 16);
    return code >= start && code <= end;
  });
}

test("the serif face never supplies the backtick glyph", async ({ page }) => {
  await firstPage(page);

  const faces = await page.evaluate(() => {
    const found: { family: string; range: string }[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRule[];
      try {
        rules = Array.from(sheet.cssRules);
      } catch {
        continue; // cross-origin sheet; none of ours are
      }
      for (const rule of rules) {
        if (rule instanceof CSSFontFaceRule) {
          found.push({
            family: rule.style.getPropertyValue("font-family"),
            range: rule.style.getPropertyValue("unicode-range"),
          });
        }
      }
    }
    return found;
  });

  const serif = faces.filter((face) => face.family.includes("Roboto Serif"));
  expect(serif.length).toBeGreaterThan(0);
  for (const face of serif) {
    expect(face.range).not.toBe("");
    expect(covers(face.range, 0x60), `${face.range} must not cover U+0060`).toBe(false);
  }

  const latin = serif.find((face) => covers(face.range, 0x61));
  expect(latin, "the latin face should still cover a-z").toBeDefined();
  expect(covers(latin!.range, 0x5f)).toBe(true);
});
