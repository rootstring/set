import { test, expect, type Page } from "@playwright/test";
import { bodyOf, putPages, storedPages } from "./db";

async function seed(page: Page, pages: { id: string; title: string; body: string }[]) {
  await page.goto("/");
  await page.waitForSelector(".sidebar");
  await putPages(page, pages, { clear: false });
  await page.reload();
  await page.waitForSelector(".sidebar");
}

async function open(page: Page, title: string) {
  await page.getByRole("button", { name: title, exact: true }).click();
  await page.locator(".ProseMirror").waitFor();
}

async function stored(page: Page, id: string): Promise<string> {
  const rows = await storedPages(page);
  return bodyOf(rows.find((r) => r.id === id)?.file ?? "");
}

const NOTE = [
  "Intro line",
  "wrapped onto a second line.",
  "",
  "> [!WARNING]",
  "> Mind the gap.",
  "",
  "A claim[^1], some $E = mc^2$, a link to [[Other]] and one to [[Nowhere|a ghost]].",
  "",
  "<!-- kept -->",
  "",
  "#### Small heading",
  "",
  "* star",
  "* list",
  "",
  "[^1]: The source.",
].join("\n");

test("a note from elsewhere shows its blocks and survives an edit", async ({ page }) => {
  await seed(page, [
    { id: "note", title: "Imported", body: NOTE },
    { id: "other", title: "Other", body: "The other page." },
  ]);
  await open(page, "Imported");
  const editor = page.locator(".ProseMirror");

  await expect(editor.locator(".callout[data-kind='warning'] .callout-label")).toHaveText(
    "Warning",
  );
  await expect(editor.locator(".footnote-ref")).toHaveText("1");
  await expect(editor.locator(".footnote-definition .footnote-body")).toHaveText(
    "The source.",
  );
  await expect(editor.locator(".wiki-link").first()).toHaveText("Other");
  await expect(editor.locator(".wiki-link").first()).not.toHaveClass(/missing/);
  await expect(editor.locator(".wiki-link.missing")).toHaveText("a ghost");
  await expect(editor.locator(".raw-block")).toHaveText("<!-- kept -->");
  await expect(editor.locator("h4")).toHaveText("Small heading");

  await editor.focus();
  await page.keyboard.type("Z");
  await expect.poll(() => stored(page, "note")).toBe(`Z${NOTE}`);
});

test("a wikilink opens the page it names", async ({ page }) => {
  await seed(page, [
    { id: "note", title: "From", body: "Go to [[Destination]]." },
    { id: "dest", title: "Destination", body: "Arrived." },
  ]);
  await open(page, "From");
  await page.locator(".ProseMirror .wiki-link").click();
  await expect(page.locator(".ProseMirror")).toContainText("Arrived.");
});

test("a link in the text carries no tooltip", async ({ page }) => {
  await seed(page, [
    { id: "note", title: "From", body: "Go to [[Destination]], not [[Nowhere]]." },
    { id: "dest", title: "Destination", body: "Arrived." },
  ]);
  await open(page, "From");

  const links = page.locator(".ProseMirror .wiki-link");
  await expect(links).toHaveCount(2);
  await expect(links.first()).not.toHaveAttribute("title", /./);
  await expect(links.last()).not.toHaveAttribute("title", /./);

  await expect(page.locator(".ProseMirror .wiki-link.missing")).toHaveText("Nowhere");
});

test("a wikilink carries a page icon, and a child-page link a different one", async ({
  page,
}) => {
  await seed(page, [
    {
      id: "note",
      title: "From",
      body: "Go to [[Destination]].\n\n[Held here](page:dest)",
    },
    { id: "dest", title: "Destination", body: "Arrived." },
  ]);
  await open(page, "From");

  const wiki = page.locator(".ProseMirror .wiki-link");
  await expect(wiki.locator(".wiki-link-icon svg")).toBeVisible();
  await expect(wiki.locator(".wiki-link-title")).toHaveText("Destination");

  const child = page.locator(".ProseMirror .page-link").first();
  await expect(child).toBeVisible();
  expect(await wiki.locator(".wiki-link-icon svg").innerHTML()).not.toBe(
    await child.locator(".page-link-icon svg").innerHTML(),
  );

  await expect(wiki.locator("xpath=..")).toContainText("Go to Destination.");
});

test("a page lists what links to it, and the list follows a rename", async ({ page }) => {
  await seed(page, [
    { id: "one", title: "First", body: "Go to [[Destination]]." },
    { id: "two", title: "Second", body: "Also [[destination|see this]]." },
    { id: "three", title: "Third", body: "Links nowhere." },
    { id: "dest", title: "Destination", body: "Arrived." },
  ]);
  await open(page, "Destination");

  const backlinks = page.locator("nav.backlinks");
  await expect(backlinks.locator(".chip-title")).toHaveText(["First", "Second"]);

  const row = await backlinks.boundingBox();
  const body = await page.locator(".ProseMirror").boundingBox();
  expect(row!.y).toBeLessThan(body!.y);

  await backlinks.getByText("Second").click();
  await expect(page.locator(".ProseMirror")).toContainText("Also");

  await open(page, "Destination");
  await page.locator(".title").fill("Renamed");
  await expect(page.locator("nav.backlinks")).toHaveCount(0);

  await open(page, "Third");
  await expect(page.locator("nav.backlinks")).toHaveCount(0);
});

test("past three, the rest go behind a count that opens a list", async ({ page }) => {
  await seed(page, [
    ...["A", "B", "C", "D", "E"].map((name) => ({
      id: `p-${name}`,
      title: `Page ${name}`,
      body: "Go to [[Destination]].",
    })),
    { id: "dest", title: "Destination", body: "Arrived." },
  ]);
  await open(page, "Destination");

  const backlinks = page.locator("nav.backlinks");
  await expect(backlinks.locator(".chip-title")).toHaveCount(3);
  const row = await backlinks.boundingBox();
  expect(row!.height).toBeLessThan(32);

  const more = backlinks.locator(".more");
  await expect(more).toHaveText("+2");

  await more.click();
  const popover = page.getByRole("dialog", { name: "Pages that link here" });
  await expect(popover.locator(".row-title")).toHaveText([
    "Page A",
    "Page B",
    "Page C",
    "Page D",
    "Page E",
  ]);
  const list = await popover.locator(".list").boundingBox();
  expect(list!.height).toBeLessThanOrEqual(13.5 * 16 + 1);

  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await more.click();
  await popover.getByText("Page D").click();
  await expect(page.locator(".ProseMirror")).toContainText("Go to Destination.");
  await expect(page.locator("textarea.title")).toHaveValue("Page D");
});

test("a wikilink written inside code is not a backlink", async ({ page }) => {
  await seed(page, [
    { id: "one", title: "Sample", body: "```\n[[Destination]]\n```" },
    { id: "dest", title: "Destination", body: "Arrived." },
  ]);
  await open(page, "Destination");
  await expect(page.locator(".ProseMirror")).toContainText("Arrived.");
  await expect(page.locator("nav.backlinks")).toHaveCount(0);
});

test("typing a wikilink makes one", async ({ page }) => {
  await seed(page, [{ id: "note", title: "Typed", body: "Start" }]);
  await open(page, "Typed");
  await page.locator(".ProseMirror").focus();
  await page.keyboard.type("[[Somewhere]] ");
  await expect(page.locator(".ProseMirror .wiki-link")).toHaveText("Somewhere");
  await expect.poll(() => stored(page, "note")).toBe("[[Somewhere]] Start");
});

test("a footnote reference jumps to its definition", async ({ page }) => {
  await seed(page, [
    { id: "note", title: "Cited", body: "Claim[^a]\n\n[^a]: Where it came from." },
  ]);
  await open(page, "Cited");
  await page.locator(".ProseMirror .footnote-ref").click();
  const inDefinition = await page.evaluate(
    () =>
      !!window.getSelection()?.anchorNode?.parentElement?.closest(".footnote-definition"),
  );
  expect(inDefinition).toBe(true);
});

test("an alert's header changes its kind", async ({ page }) => {
  await seed(page, [{ id: "note", title: "Alerted", body: "> [!NOTE]\n> Heads up." }]);
  await open(page, "Alerted");
  await page.locator(".ProseMirror .callout-header").click();
  await page.locator(".block-menu-item", { hasText: "Caution" }).click();
  await expect(page.locator(".ProseMirror .callout[data-kind='caution']")).toHaveCount(1);
  await expect.poll(() => stored(page, "note")).toBe("> [!CAUTION]\n> Heads up.");
});

test("a column's alignment is set from the table menu", async ({ page }) => {
  await seed(page, [
    { id: "note", title: "Tabled", body: "| a | b |\n| --- | --- |\n| 1 | 2 |" },
  ]);
  await open(page, "Tabled");
  await page.locator(".ProseMirror th", { hasText: "b" }).click({ button: "right" });
  await page.locator(".block-menu-item", { hasText: "Align column right" }).click();
  await expect
    .poll(() => stored(page, "note"))
    .toBe("| a | b |\n| --- | ---: |\n| 1 | 2 |");
});

test("==text== becomes a highlight, and is written back that way", async ({ page }) => {
  await seed(page, [{ id: "note", title: "Marked", body: "Start" }]);
  await open(page, "Marked");
  await page.locator(".ProseMirror").focus();
  await page.keyboard.type("==hot== ");
  await expect(page.locator(".ProseMirror mark")).toHaveText("hot");
  await expect.poll(() => stored(page, "note")).toBe("==hot== Start");
});
