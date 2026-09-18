import { test, expect, type Page } from "@playwright/test";
import { openEditor } from "./app";
import { storedBody } from "./db";

async function paste(page: Page, text: string, type = "text/plain") {
  await page.evaluate(
    ([text, type]) => {
      const data = new DataTransfer();
      data.setData(type, text);
      document.querySelector(".ProseMirror")!.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    [text, type],
  );
}

async function insertTable(page: Page) {
  await page.keyboard.type("/table");
  await page.keyboard.press("Enter");
  await expect(page.locator(".ProseMirror table")).toHaveCount(1);
}

/** The table as text, row by row — what a reader of the page sees. */
function grid(page: Page): Promise<string[][]> {
  return page
    .locator(".ProseMirror table tr")
    .evaluateAll((rows) =>
      rows.map((row) => [...row.children].map((cell) => cell.textContent ?? "")),
    );
}

async function menu(page: Page, cellText: string, item: string) {
  await page.locator(".ProseMirror :is(th, td)", { hasText: cellText }).first().click({
    button: "right",
  });
  await page.locator(".block-menu-item", { hasText: item }).click();
}

test("/table inserts a header row and two rows, written as GFM", async ({ page }) => {
  await openEditor(page);
  await insertTable(page);

  await expect(page.locator(".ProseMirror th")).toHaveCount(3);
  await expect(page.locator(".ProseMirror td")).toHaveCount(6);

  await page.keyboard.type("Fruit");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Qty");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Note");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Apple");

  await expect
    .poll(() => storedBody(page))
    .toBe("| Fruit | Qty | Note |\n| --- | --- | --- |\n| Apple |  |  |\n|  |  |  |");

  await page.reload();
  await expect(page.locator(".ProseMirror table")).toHaveCount(1);
  expect(await grid(page)).toEqual([
    ["Fruit", "Qty", "Note"],
    ["Apple", "", ""],
    ["", "", ""],
  ]);
});

test("Enter moves down a column, and out of the table from the last row", async ({
  page,
}) => {
  await openEditor(page);
  await insertTable(page);

  await page.keyboard.type("head");
  await page.keyboard.press("Enter");
  await page.keyboard.type("one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("two");
  expect((await grid(page)).map((row) => row[0])).toEqual(["head", "one", "two"]);

  await page.keyboard.press("Enter");
  await page.keyboard.type("after the table");
  await expect(page.locator(".ProseMirror table")).toHaveCount(1);
  await expect(page.locator(".ProseMirror table tr")).toHaveCount(3);
  await expect(
    page.locator(".ProseMirror > p", { hasText: "after the table" }),
  ).toHaveCount(1);
});

test("Tab past the last cell adds a row", async ({ page }) => {
  await openEditor(page);
  await insertTable(page);

  for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
  await page.keyboard.type("last");
  await page.keyboard.press("Tab");
  await page.keyboard.type("new row");

  await expect(page.locator(".ProseMirror table tr")).toHaveCount(4);
  expect((await grid(page))[3]).toEqual(["new row", "", ""]);
});

test("Shift-Enter in a cell is a <br>, which stays inside the row", async ({ page }) => {
  await openEditor(page);
  await insertTable(page);

  await page.keyboard.type("one");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("two");

  await expect(
    page.locator(".ProseMirror th br:not(.ProseMirror-trailingBreak)"),
  ).toHaveCount(1);
  await expect
    .poll(() => storedBody(page))
    .toBe("| one<br>two |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |");

  await page.reload();
  await expect(page.locator(".ProseMirror table tr")).toHaveCount(3);
  await expect(
    page.locator(".ProseMirror th br:not(.ProseMirror-trailingBreak)"),
  ).toHaveCount(1);
});

test("a GFM table round-trips: alignment, escaped pipes, inline Markdown", async ({
  page,
}) => {
  const md = [
    "| Left | Center | Right |",
    "| :--- | :---: | ---: |",
    "| a \\| b | **bold** | `x \\| y` |",
    "| - not a list | [link](https://example.com) | 3 |",
  ].join("\n");

  await openEditor(page);
  await paste(page, md);

  await expect(page.locator(".ProseMirror table")).toHaveCount(1);
  expect(await grid(page)).toEqual([
    ["Left", "Center", "Right"],
    ["a | b", "bold", "x | y"],
    ["- not a list", "link", "3"],
  ]);
  await expect(page.locator(".ProseMirror th").nth(1)).toHaveCSS("text-align", "center");
  await expect(page.locator(".ProseMirror td").nth(2)).toHaveCSS("text-align", "right");

  await expect.poll(() => storedBody(page)).toBe(md);

  await page.reload();
  await expect(page.locator(".ProseMirror table tr")).toHaveCount(3);
  expect(await storedBody(page)).toBe(md);
});

test("a table GFM can't write is kept, as HTML", async ({ page }) => {
  await openEditor(page);
  await paste(
    page,
    '<table><tr><td>a</td><td>b</td></tr><tr><td colspan="2">wide</td></tr></table>',
    "text/html",
  );

  await expect(page.locator(".ProseMirror td[colspan='2']")).toHaveCount(1);
  await expect
    .poll(() => storedBody(page))
    .toBe(
      '<table>\n<tr><td>a</td><td>b</td></tr>\n<tr><td colspan="2">wide</td></tr>\n</table>',
    );

  await page.reload();
  await expect(page.locator(".ProseMirror td[colspan='2']")).toHaveText("wide");
});

test("the right-click menu adds and removes rows and columns", async ({ page }) => {
  await openEditor(page);
  await paste(page, "| a | b |\n| --- | --- |\n| 1 | 2 |");
  await expect(page.locator(".ProseMirror table")).toHaveCount(1);

  await menu(page, "a", "Insert column right");
  expect(await grid(page)).toEqual([
    ["a", "", "b"],
    ["1", "", "2"],
  ]);
  await expect(page.locator(".ProseMirror th")).toHaveCount(3);

  await menu(page, "1", "Insert row above");
  await menu(page, "1", "Insert row below");
  await expect(page.locator(".ProseMirror table tr")).toHaveCount(4);

  await menu(page, "b", "Delete column");
  expect(await grid(page)).toEqual([
    ["a", ""],
    ["", ""],
    ["1", ""],
    ["", ""],
  ]);

  // The header row offers nothing above it; the one below takes its place
  // when it goes, so the table stays one GFM can write.
  await page.locator(".ProseMirror th", { hasText: "a" }).click({ button: "right" });
  await expect(
    page.locator(".block-menu-item", { hasText: "Insert row above" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await menu(page, "a", "Delete row");
  await expect(page.locator(".ProseMirror th")).toHaveCount(2);
  await expect
    .poll(() => storedBody(page))
    .toBe("|  |  |\n| --- | --- |\n| 1 |  |\n|  |  |");

  await menu(page, "1", "Delete table");
  await expect(page.locator(".ProseMirror table")).toHaveCount(0);
});

test("an open slash menu still gets Enter inside a cell", async ({ page }) => {
  await openEditor(page);
  await insertTable(page);

  await page.keyboard.type("/date");
  await page.keyboard.press("Enter");
  await expect(page.locator(".ProseMirror th .date-mention")).toHaveCount(1);
  await expect(page.locator(".ProseMirror table tr")).toHaveCount(3);
});

test("block syntax typed in a cell stays text in the cell", async ({ page }) => {
  await openEditor(page);
  await insertTable(page);

  await page.keyboard.type("> not a toggle");
  await page.keyboard.press("Tab");
  await page.keyboard.type("- not a list");
  await page.keyboard.press("Tab");
  await page.keyboard.type("# not a heading");
  await page.keyboard.press("Tab");
  await page.keyboard.type("---");

  await expect(page.locator(".ProseMirror table")).toHaveCount(1);
  await expect(page.locator(".ProseMirror hr")).toHaveCount(0);
  expect((await grid(page)).slice(0, 2)).toEqual([
    ["> not a toggle", "- not a list", "# not a heading"],
    ["---", "", ""],
  ]);
});

test("in a cell, the slash menu offers only what fits in one", async ({ page }) => {
  await openEditor(page);
  await insertTable(page);

  await page.keyboard.type("/");
  const offered = page.locator(".slash-menu .item .title");
  await expect(offered.first()).toBeVisible();
  const titles = await offered.allInnerTexts();
  expect(titles).toContain("Link");
  expect(titles).toContain("Date");
  for (const block of ["Page", "Toggle", "Image", "Divider", "Table", "Heading 1"]) {
    expect(titles).not.toContain(block);
  }
});

test("an image pasted into a cell lands below the table", async ({ page }) => {
  await openEditor(page);
  await insertTable(page);

  await page.evaluate(() => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30">' +
      '<rect width="40" height="30" fill="tomato"/></svg>';
    const data = new DataTransfer();
    data.items.add(new File([svg], "cell.svg", { type: "image/svg+xml" }));
    document.querySelector(".ProseMirror")!.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });

  await expect(page.locator(".ProseMirror img")).toHaveCount(1);
  await expect(page.locator(".ProseMirror table")).toHaveCount(1);
  await expect(page.locator(".ProseMirror table tr")).toHaveCount(3);
  await expect(page.locator(".ProseMirror table img")).toHaveCount(0);
  const below = await page
    .locator(".ProseMirror table")
    .evaluate(
      (table) =>
        !!(
          table.compareDocumentPosition(document.querySelector(".ProseMirror img")!) &
          Node.DOCUMENT_POSITION_FOLLOWING
        ),
    );
  expect(below).toBe(true);
});

test("pasting paragraphs into a cell keeps them in the cell", async ({ page }) => {
  await openEditor(page);
  await insertTable(page);

  await paste(page, "one\n\ntwo");

  await expect(page.locator(".ProseMirror table")).toHaveCount(1);
  await expect(page.locator(".ProseMirror table tr")).toHaveCount(3);
  const text = (await grid(page)).flat().join(" ");
  expect(text).toContain("one");
  expect(text).toContain("two");
});

test("the bars along a table add a row below and a column to the right", async ({
  page,
}) => {
  await openEditor(page);
  await insertTable(page);
  await page.keyboard.type("Fruit");

  // Only when the pointer is over the table.
  const addRow = page.locator(".table-add-row");
  const addColumn = page.locator(".table-add-col");
  await expect(addRow).toBeHidden();

  await page.locator(".ProseMirror table").hover();
  await expect(addRow).toBeVisible();
  await expect(addColumn).toBeVisible();

  await addRow.click();
  expect(await grid(page)).toEqual([
    ["Fruit", "", ""],
    ["", "", ""],
    ["", "", ""],
    ["", "", ""],
  ]);

  await addColumn.click();
  expect(await grid(page)).toEqual([
    ["Fruit", "", "", ""],
    ["", "", "", ""],
    ["", "", "", ""],
    ["", "", "", ""],
  ]);

  // And the file is still a GFM table, with the header it started with.
  await expect
    .poll(() => storedBody(page))
    .toBe(
      "| Fruit |  |  |  |\n| --- | --- | --- | --- |\n" +
        "|  |  |  |  |\n|  |  |  |  |\n|  |  |  |  |",
    );
});

test("a bar stays while the pointer crosses the gap from the table to it", async ({
  page,
}) => {
  await openEditor(page);
  await insertTable(page);

  const table = page.locator(".ProseMirror table");
  const addRow = page.locator(".table-add-row");
  await table.hover();
  const box = (await table.boundingBox())!;
  const bar = (await addRow.boundingBox())!;
  const x = box.x + box.width / 2;

  // The bar stands a few pixels off the table; a click() would jump straight onto it.
  await page.mouse.move(x, box.y + box.height + 2);
  await expect(addRow).toBeVisible();
  await page.mouse.move(x, bar.y + bar.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.locator(".ProseMirror tr")).toHaveCount(4);
});

test("a locked page offers no bars to grow its tables with", async ({ page }) => {
  await openEditor(page);
  await insertTable(page);
  await page.keyboard.type("Fruit");

  await page.getByTestId("page-menu").click();
  await page.getByTestId("page-menu-lock").click();
  await expect(page.getByTestId("breadcrumb-unlock")).toBeVisible();

  await page.locator(".ProseMirror table").hover();
  await expect(page.locator(".table-add-row")).toBeHidden();
  await expect(page.locator(".table-add-col")).toBeHidden();
});
