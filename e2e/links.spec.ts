import { test, expect, type Page } from "@playwright/test";
import { firstPage } from "./app";
import { storedFiles } from "./db";

/**
 * The Markdown round trip, and the places a link deliberately does not appear: inside code, and
 * after the closing bracket.
 */

async function captureOpens(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { opened: string[] }).opened = [];
    window.open = (url?: string | URL) => {
      (window as unknown as { opened: string[] }).opened.push(String(url));
      return null;
    };
  });
}

const opened = (page: Page) =>
  page.evaluate(() => (window as unknown as { opened: string[] }).opened);

async function paste(page: Page, text: string): Promise<void> {
  await page.evaluate((clip) => {
    const data = new DataTransfer();
    data.setData("text/plain", clip);
    document.querySelector(".ProseMirror")!.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, text);
}

const link = (page: Page) => page.locator(".ProseMirror a");

test("typing the Markdown form makes a link, and stops where it says", async ({
  page,
}) => {
  await firstPage(page);
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("Get it here: [Download](https://example.com/download)");

  await expect(link(page)).toHaveText("Download");
  await expect(link(page)).toHaveAttribute("href", "https://example.com/download");

  // What follows the closing bracket is ordinary writing.
  await page.keyboard.type(" and nothing more");
  await expect(link(page)).toHaveText("Download");
  await expect(page.locator(".ProseMirror p")).toContainText("and nothing more");

  // The file holds the Markdown it was typed as, and reading it back gives
  // the link again.
  await expect
    .poll(() => storedFiles(page))
    .toContain("[Download](https://example.com/download)");
  await page.reload();
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await expect(link(page)).toHaveAttribute("href", "https://example.com/download");
});

test("a bare host gets the scheme, and an unsafe one is left as text", async ({
  page,
}) => {
  await firstPage(page);
  await page.locator(".ProseMirror").click();

  await page.keyboard.type("[home](example.com)");
  await expect(link(page)).toHaveAttribute("href", "https://example.com");

  await page.keyboard.press("Enter");
  await page.keyboard.type("[bad](javascript:alert(1))");
  await expect(link(page)).toHaveCount(1);
  await expect(page.locator(".ProseMirror")).toContainText("[bad](javascript:alert(1))");
});

test("code keeps its brackets", async ({ page }) => {
  await firstPage(page);
  await page.locator(".ProseMirror").click();

  await page.keyboard.type("`[a](https://example.com)`");
  await expect(page.locator(".ProseMirror code")).toHaveText("[a](https://example.com)");

  await page.keyboard.press("Enter");
  await page.keyboard.type("```\n[a](https://example.com)");
  await expect(page.locator(".ProseMirror pre code")).toContainText(
    "[a](https://example.com)",
  );
  await expect(link(page)).toHaveCount(0);
});

test("/link asks for the address and writes the link", async ({ page }) => {
  await firstPage(page);
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("/link");

  // Named outright, so it leads — "Page" merely lists "link" as a keyword.
  await expect(page.locator(".slash-menu .item .title").first()).toHaveText("Link");
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("link-dialog")).toBeVisible();
  await page.getByTestId("link-href").fill("example.com/download");
  await page.getByTestId("link-text").fill("Download");
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("link-dialog")).toBeHidden();
  await expect(link(page)).toHaveText("Download");
  await expect(link(page)).toHaveAttribute("href", "https://example.com/download");

  // The caret comes back after the link, outside it.
  await page.keyboard.type(" is the button");
  await expect(link(page)).toHaveText("Download");
  await expect
    .poll(() => storedFiles(page))
    .toContain("[Download](https://example.com/download) is the button");
});

test("a URL pasted over words links the words", async ({ page }) => {
  await firstPage(page);
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("read the docs");
  // Selected with the mouse: a caret moved by arrows only reaches the editor on a later
  // `selectionchange`, and the paste is synthetic.
  await page.locator(".ProseMirror p").click({ clickCount: 3 });

  await paste(page, "https://example.com/docs");

  await expect(link(page)).toHaveText("read the docs");
  await expect(link(page)).toHaveAttribute("href", "https://example.com/docs");
  await expect
    .poll(() => storedFiles(page))
    .toContain("[read the docs](https://example.com/docs)");
});

test("clicking a link opens it, rather than the app going there", async ({ page }) => {
  await firstPage(page);
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("[Download](https://example.com/download)");
  await captureOpens(page);

  // Read after the editor has had the event.
  await page.evaluate(() => {
    const seen = ((window as unknown as { prevented: boolean[] }).prevented = []);
    document.addEventListener("click", (e) => seen.push(e.defaultPrevented));
  });

  await link(page).click();

  await expect.poll(() => opened(page)).toEqual(["https://example.com/download"]);
  // The page it was clicked from is still the page you're on.
  await expect(page).toHaveURL(/\/pages\//);
  // Instead of following the href, never as well: one click, two windows.
  expect(
    await page.evaluate(() => (window as unknown as { prevented: boolean[] }).prevented),
  ).toEqual([true]);
});

test("hovering a link shows where it goes", async ({ page }) => {
  await firstPage(page);
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("[Download](https://example.com/download)");

  await link(page).hover();
  await expect(page.locator(".tip.shown")).toHaveText("https://example.com/download");

  // The hint is the bubble's, not a `title` that copy and paste would carry into the Markdown.
  await expect(link(page)).not.toHaveAttribute("title", /./);
  await page.mouse.move(0, 0);
  await expect(page.locator(".tip.shown")).toBeHidden();
  await expect(link(page)).not.toHaveAttribute("title", /./);
});

test("the menu on a link edits it and takes it off", async ({ page }) => {
  await firstPage(page);
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("[Download](https://example.com/download)");

  await link(page).click({ button: "right" });
  await expect(page.locator(".block-menu")).toBeVisible();
  await page.locator(".block-menu-item", { hasText: "Edit link" }).click();

  await expect(page.getByTestId("link-href")).toHaveValue("https://example.com/download");
  await expect(page.getByTestId("link-text")).toHaveValue("Download");
  await page.getByTestId("link-href").fill("https://example.com/releases");
  await page.getByTestId("link-text").fill("Releases");
  await page.keyboard.press("Enter");

  await expect(link(page)).toHaveText("Releases");
  await expect(link(page)).toHaveAttribute("href", "https://example.com/releases");

  await link(page).click({ button: "right" });
  await page.locator(".block-menu-item", { hasText: "Remove link" }).click();

  await expect(link(page)).toHaveCount(0);
  await expect(page.locator(".ProseMirror")).toContainText("Releases");
  await expect.poll(() => storedFiles(page)).not.toContain("example.com/releases");
});
