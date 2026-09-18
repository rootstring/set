import { test, expect, type Page } from "@playwright/test";
import { firstPage, openEditor } from "./app";
import { storedBody } from "./db";

/** Today as the page's own clock has it, in its locale. */
function clockIn(page: Page, hours: number, minutes: number) {
  return page.evaluate(
    ([h, m]) => {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      return {
        month: `${now.getFullYear()}-${pad(now.getMonth() + 1)}`,
        today: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
        time: new Date(2026, 0, 1, h, m)
          .toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
          .replace(/ /g, " "),
      };
    },
    [hours, minutes],
  );
}

test("a time typed after @ is today at that time", async ({ page }) => {
  await openEditor(page);
  await page.keyboard.type("call @3pm");
  const { today, time } = await clockIn(page, 15, 0);
  await expect(page.locator(".mention-menu .item .title")).toHaveText([
    `Today ${time}`,
    `Tomorrow ${time}`,
    "Pick a date",
  ]);
  await page.keyboard.press("Enter");

  await expect(page.locator(".ProseMirror .date-mention")).toHaveText(`Today ${time}`);
  await expect
    .poll(() => storedBody(page))
    .toContain(`call [Today ${time}](date:${today}T15:00)`);
});

test("Pick a date offers the time under the calendar", async ({ page }) => {
  const editor = await openEditor(page);
  await page.keyboard.type("due @");
  // One entry for the picker, and no second one for a time.
  await expect(page.locator(".mention-menu .item", { hasText: /time/i })).toHaveCount(0);
  await page.locator(".mention-menu .item", { hasText: "Pick a date" }).click();

  const picker = page.locator(".date-picker");
  await expect(picker.getByLabel("Time")).toHaveCount(0);
  await picker.getByRole("button", { name: "Add time" }).click();

  const field = picker.getByLabel("Time");
  await expect(field).toBeFocused();
  await field.fill("09:30");

  const { today, time } = await clockIn(page, 9, 30);
  await expect(editor.locator(".date-mention")).toHaveText(`Today ${time}`);
  await expect.poll(() => storedBody(page)).toContain(`(date:${today}T09:30)`);

  // Enter is done with the time, and the note is where typing carries on.
  await field.press("Enter");
  await expect(picker).toHaveCount(0);
  await page.keyboard.type("sharp");
  await expect(editor.locator("p").first()).toContainText("sharp");
});

test("a picked day keeps its time, and the time comes off on its own", async ({
  page,
}) => {
  const editor = await openEditor(page);
  await page.keyboard.type("due @5pm");
  await page.keyboard.press("Enter");
  const mention = editor.locator(".date-mention");
  const { month, time } = await clockIn(page, 17, 0);

  await mention.click();
  const picker = page.locator(".date-picker");
  await expect(picker.getByLabel("Time")).toHaveValue("17:00");
  await picker.locator(".date-picker-day", { hasText: /^20$/ }).click();
  await expect(picker).toHaveCount(0);
  await expect(mention).toContainText(time);
  await expect.poll(() => storedBody(page)).toContain(`(date:${month}-20T17:00)`);

  await mention.click();
  await picker.getByRole("button", { name: "Remove time" }).click();
  await expect(picker.getByRole("button", { name: "Add time" })).toBeVisible();
  await expect(mention).not.toContainText(time);
  await expect.poll(() => storedBody(page)).toContain(`(date:${month}-20)`);
});

test("a time picked in the title is written into it", async ({ page }) => {
  await firstPage(page);
  const title = page.locator(".title");
  await title.click();
  await page.keyboard.type("Standup @");
  await page.locator(".mention-menu .item", { hasText: "Pick a date" }).click();

  const picker = page.locator(".date-picker");
  await picker.getByRole("button", { name: "Add time" }).click();
  const field = picker.getByLabel("Time");
  await field.fill("08:15");
  // The title took the edit, and the field kept the keyboard.
  await expect(field).toBeFocused();

  const { time } = await clockIn(page, 8, 15);
  await expect(title).toHaveValue(new RegExp(`^Standup \\w{3} \\d{1,2}, ${time}$`));
  await field.fill("10:45");
  const later = (await clockIn(page, 10, 45)).time;
  await expect(title).toHaveValue(new RegExp(`^Standup \\w{3} \\d{1,2}, ${later}$`));
});
