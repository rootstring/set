import { test, expect, type Locator } from "@playwright/test";
import { firstPage } from "./app";

async function openSettings(page: import("@playwright/test").Page): Promise<void> {
  await page.keyboard.press("Meta+Shift+Comma");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await firstPage(page);
});

test("the browser build offers the desktop download where updates would be", async ({
  page,
  context,
}) => {
  await context.route("https://writewithset.com/**", (route) =>
    route.fulfill({ status: 200, body: "" }),
  );
  await openSettings(page);

  const footer = page.getByRole("dialog", { name: "Settings" }).locator("footer");
  await expect(footer.getByTestId("settings-update")).toHaveCount(0);

  const popup = page.waitForEvent("popup");
  await footer.getByTestId("settings-download").click();
  expect((await popup).url()).toBe("https://writewithset.com/?download=true");
});

test("a theme choice reaches the document", async ({ page }) => {
  await openSettings(page);

  await page
    .getByRole("group", { name: "Theme" })
    .getByRole("button", { name: "Dark" })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page
    .getByRole("group", { name: "Theme" })
    .getByRole("button", { name: "Light" })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

/** The custom colour circle in a swatch group, and the picker inside it. */
function customCircle(group: Locator) {
  const circle = group.locator("label.custom");
  return { circle, input: circle.locator('input[type="color"]') };
}

/** A script's click never opens a native picker, so this can check which way the circle decided. */
function clickOpensPicker(input: Locator): Promise<boolean> {
  return input.evaluate((el) => {
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    el.dispatchEvent(click);
    return !click.defaultPrevented;
  });
}

test("one circle holds the custom color: pick, reuse, then change it", async ({
  page,
}) => {
  await openSettings(page);
  const accents = page.getByRole("group", { name: "Accent color" });
  const { circle, input } = customCircle(accents);
  const accentVar = () =>
    page.evaluate(() => document.documentElement.style.getPropertyValue("--accent"));

  // Nothing saved: the circle is the picker.
  await expect(circle).toHaveCount(1);
  await expect(circle).toHaveAttribute("data-state", "empty");
  expect(await clickOpensPicker(input)).toBe(true);

  await input.fill("#ff8800");
  await expect(circle).toHaveAttribute("data-state", "active");
  const custom = await accentVar();

  // A preset takes over; the circle keeps the colour, and a click only uses it.
  await accents.getByRole("button", { name: "Green" }).click();
  await expect(circle).toHaveAttribute("data-state", "saved");
  expect(await accentVar()).not.toBe(custom);

  expect(await clickOpensPicker(input)).toBe(false);
  await expect(circle).toHaveAttribute("data-state", "active");
  expect(await accentVar()).toBe(custom);

  // In use, a click opens the picker, and the new colour replaces the old.
  expect(await clickOpensPicker(input)).toBe(true);
  await input.fill("#0088ff");
  await expect(circle).toHaveCount(1);
  await expect(circle).toHaveAttribute("title", /#0088ff/);

  await accents.getByRole("button", { name: "Green" }).click();
  await page.reload();
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await openSettings(page);
  await expect(circle).toHaveAttribute("title", /#0088ff/);
  await expect(circle).toHaveAttribute("data-state", "saved");
});

test("tint and text color remember theirs too", async ({ page }) => {
  await openSettings(page);
  const tints = page.getByRole("group", { name: "Tint" });
  const tint = customCircle(tints);
  await tint.input.fill("#33aa66");
  await tints.getByRole("button", { name: "No tint" }).click();
  await expect(tint.circle).toHaveAttribute("data-state", "saved");
  await tint.circle.click();
  await expect(tint.circle).toHaveAttribute("data-state", "active");

  const inks = page.getByRole("group", { name: "Font color" });
  const ink = customCircle(inks);
  await ink.input.fill("#224488");
  await inks.getByRole("button", { name: "Default color" }).click();
  await expect(ink.circle).toHaveAttribute("data-state", "saved");
  await ink.circle.click();
  await expect(ink.circle).toHaveAttribute("data-state", "active");
});

test("resetting the look keeps the saved custom colors", async ({ page }) => {
  await openSettings(page);
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const accents = page.getByRole("group", { name: "Accent color" });
  const { circle, input } = customCircle(accents);
  await input.fill("#ff8800");

  await dialog.getByRole("button", { name: "Reset", exact: true }).first().click();
  await page
    .getByTestId("confirm-popover")
    .getByRole("button", { name: "Reset" })
    .click();

  await expect(accents.getByRole("button", { name: "Blue" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(circle).toHaveAttribute("data-state", "saved");
  await expect(circle).toHaveAttribute("title", /#ff8800/);
});
