import { test, expect, type Locator, type Page } from "@playwright/test";
import { booted } from "./app";
import { livePages, putPages } from "./db";

/** A handle per line of a list; an item carries whatever is indented under it. */

const PAGE = "l-list";

async function seed(page: Page, body: string): Promise<void> {
  await putPages(page, [{ id: PAGE, title: "List", body }]);
  await page.goto("/");
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await expect
    .poll(async () => (await page.locator(".ProseMirror").innerText()).trim().length)
    .toBeGreaterThan(0);
}

/** A todo with todos under it carries a tally on that line. */
function itemOf(page: Page, text: string): Locator {
  return page
    .locator(".ProseMirror li p", { hasText: new RegExp(`^${text}(\\d+/\\d+)?$`) })
    .first()
    .locator("xpath=ancestor::li[1]");
}

/** What the page holds on disk, which is the claim most of these are making. */
async function body(page: Page): Promise<string> {
  const file = (await livePages(page)).find((p) => p.id === PAGE)?.file ?? "";
  return file.replace(/^---\n[\s\S]*?\n---\n*/, "").trimEnd();
}

/** Hovered first and read after a frame to settle. */
async function handleFor(page: Page, text: string): Promise<Locator> {
  // At the column the handle stands beside: the item's text may be indented well away.
  const item = (await itemOf(page, text).boundingBox())!;
  const column = (await page.locator(".ProseMirror > *").first().boundingBox())!.x;
  await page.mouse.move(column + 4, item.y + 6);
  const handle = page.locator(".drag-handle");
  await expect(handle).toBeVisible();
  await page.waitForTimeout(120);
  return handle;
}

type Where = "onto" | "above" | "below";

/** Drag the item reading `text` by its handle and drop it on `target`. */
async function drag(
  page: Page,
  text: string,
  target: string,
  where: Where = "onto",
): Promise<void> {
  const handle = await handleFor(page, text);
  const grip = (await handle.boundingBox())!;
  const box = (await itemOf(page, target).boundingBox())!;

  // Which side it lands on is decided by where in the target's text the pointer is.
  const y =
    where === "above"
      ? box.y + 2
      : where === "below"
        ? box.y + box.height - 2
        : box.y + box.height / 2;
  const x =
    where === "above"
      ? box.x + 2
      : where === "below"
        ? box.x + box.width - 2
        : box.x + box.width / 2;

  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 16 });
  await page.mouse.move(x, y);
  await page.mouse.up();
}

async function blockMenu(page: Page, text: string): Promise<void> {
  const handle = await handleFor(page, text);
  await handle.click();
  await expect(page.locator(".block-menu")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await booted(page);
});

test("each bullet has a handle of its own, not just the first", async ({ page }) => {
  await seed(page, "- one\n- two\n- three");

  for (const text of ["one", "two", "three"]) {
    const handle = await handleFor(page, text);
    const grip = (await handle.boundingBox())!;
    const item = (await itemOf(page, text).boundingBox())!;
    expect(Math.abs(grip.y + grip.height / 2 - (item.y + item.height / 2))).toBeLessThan(
      4,
    );
  }
});

/** Straight where the handle will be, with no pass over the text first. */
test("the handle comes up for an item approached from the side", async ({ page }) => {
  await seed(page, "intro\n\n- one\n- two\n- three\n\n- [ ] alpha\n- [ ] beta\n\nafter");

  const editor = (await page.locator(".ProseMirror").boundingBox())!;
  const handle = page.locator(".drag-handle");

  for (const text of ["two", "three", "alpha", "beta"]) {
    for (const x of [editor.x - 30, editor.x + 8]) {
      // Away first, so a handle already beside the item cannot pass for one that came up.
      await page.mouse.move(editor.x + 300, editor.y + editor.height + 40);
      await page.waitForTimeout(80);

      const item = (await itemOf(page, text).boundingBox())!;
      const middle = item.y + item.height / 2;
      await page.mouse.move(x, middle);
      await expect(handle).toBeVisible();
      await expect
        .poll(async () => {
          const grip = (await handle.boundingBox())!;
          return Math.abs(grip.y + grip.height / 2 - middle);
        })
        .toBeLessThan(4);
    }
  }
});

test("a nested item's handle stands in the same column as the outer one's", async ({
  page,
}) => {
  await seed(page, "- one\n  - two\n    - three\n- four");

  const column = (await (await handleFor(page, "one")).boundingBox())!.x;
  for (const text of ["two", "three", "four"]) {
    const grip = (await (await handleFor(page, text)).boundingBox())!;
    expect(Math.abs(grip.x - column)).toBeLessThan(1);
    const item = (await itemOf(page, text).boundingBox())!;
    expect(Math.abs(grip.y + grip.height / 2 - (item.y + 12))).toBeLessThan(6);
  }
});

test("each todo has a handle of its own", async ({ page }) => {
  await seed(page, "- [ ] alpha\n\n- [x] beta");

  for (const text of ["alpha", "beta"]) {
    const handle = await handleFor(page, text);
    const grip = (await handle.boundingBox())!;
    const item = (await itemOf(page, text).boundingBox())!;
    expect(Math.abs(grip.y + grip.height / 2 - (item.y + item.height / 2))).toBeLessThan(
      4,
    );
  }
});

test("the handle stands clear of the bullet, in the margin", async ({ page }) => {
  await seed(page, "- one\n  - nested");

  for (const text of ["one", "nested"]) {
    const handle = await handleFor(page, text);
    const grip = (await handle.boundingBox())!;
    const gutter = await itemOf(page, text).evaluate((li) => {
      const list = li.parentElement!;
      return {
        left: li.getBoundingClientRect().left,
        pad: parseFloat(getComputedStyle(list).paddingLeft),
      };
    });
    expect(grip.x + grip.width).toBeLessThanOrEqual(gutter.left - gutter.pad);
  }
});

test("an item dragged above another changes places with it", async ({ page }) => {
  await seed(page, "- one\n- two\n- three");

  await drag(page, "three", "one", "above");

  await expect.poll(() => body(page)).toBe("- three\n- one\n- two");
});

test("a parent takes everything indented under it", async ({ page }) => {
  await seed(page, "- parent\n  - child one\n  - child two\n- sibling");

  await drag(page, "parent", "sibling", "below");

  await expect
    .poll(() => body(page))
    .toBe("- sibling\n- parent\n  - child one\n  - child two");
});

test("a child dragged out of its parent lands beside it", async ({ page }) => {
  await seed(page, "- parent\n  - child\n- last");

  await drag(page, "child", "last", "below");

  await expect.poll(() => body(page)).toBe("- parent\n- last\n- child");
});

test("dropping a parent inside its own children leaves the list as it was", async ({
  page,
}) => {
  const start = "- parent\n  - child one\n  - child two\n- sibling";
  await seed(page, start);

  await drag(page, "parent", "child two");

  await page.waitForTimeout(200);
  expect(await body(page)).toBe(start);
});

test("a todo keeps its tick when it moves", async ({ page }) => {
  await seed(page, "- [x] done\n\n- [ ] todo");

  await drag(page, "done", "todo", "below");

  await expect.poll(() => body(page)).toBe("- [ ] todo\n\n- [x] done");
});

test("the menu on one todo deletes that todo and what is under it", async ({ page }) => {
  await seed(page, "- [ ] parent\n\n  - [ ] child\n\n- [ ] keep");

  await blockMenu(page, "parent");
  await page.locator(".block-menu-item", { hasText: "Delete" }).click();

  await expect.poll(() => body(page)).toBe("- [ ] keep");
});

test("deleting the last item takes the emptied list with it", async ({ page }) => {
  await seed(page, "before\n\n- only\n\nafter");

  await blockMenu(page, "only");
  await page.locator(".block-menu-item", { hasText: "Delete" }).click();

  await expect.poll(() => body(page)).toBe("before\n\nafter");
  await expect(page.locator(".ProseMirror ul")).toHaveCount(0);
});

test("ticking a checkbox leaves the handle on that todo, not on the list", async ({
  page,
}) => {
  await seed(page, "- [ ] first\n\n- [ ] second\n\n- [ ] third");

  // The handle comes up for `second`, and then the document changes underneath
  // it without the pointer moving off that line.
  await handleFor(page, "second");
  await itemOf(page, "second").locator("input[type=checkbox]").click();
  await expect.poll(() => body(page)).toContain("[x] second");

  await blockMenu(page, "second");
  await page.locator(".block-menu-item", { hasText: "Delete" }).click();

  await expect.poll(() => body(page)).toBe("- [ ] first\n\n- [ ] third");
});

test("dragging the only item off a list takes the emptied list with it", async ({
  page,
}) => {
  await seed(page, "- only\n\nafter");

  const target = (await page
    .locator(".ProseMirror p", { hasText: "after" })
    .boundingBox())!;
  const handle = await handleFor(page, "only");
  const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  const x = target.x + target.width - 2;
  const y = target.y + target.height - 2;
  await page.mouse.move(x, y, { steps: 16 });
  await page.mouse.move(x, y);
  await page.mouse.up();

  await expect.poll(() => body(page)).toBe("after\n\n- only");
  await expect(page.locator(".ProseMirror ul")).toHaveCount(1);
});

test("a todo dropped into a list of bullets stays a todo", async ({ page }) => {
  await seed(page, "- [ ] todo\n\n- one\n- two");

  await drag(page, "todo", "two", "below");

  // Where exactly it lands is ProseMirror's to decide; the todo stays a todo.
  await expect.poll(() => body(page)).toContain("- [ ] todo");
  await expect.poll(() => body(page)).toContain("- one\n- two");
});

/** Only a list goes deeper than the top level. */

test("the handle beside a line in a toggle still stands for the toggle", async ({
  page,
}) => {
  await seed(
    page,
    "<details open>\n<summary>plans</summary>\n\nship it\n\n</details>\n\nafter",
  );

  const line = page.locator(".ProseMirror p", { hasText: "ship it" });
  await line.hover({ position: { x: 4, y: 6 } });
  const handle = page.locator(".drag-handle");
  await expect(handle).toBeVisible();
  await handle.click();
  await page.locator(".block-menu-item", { hasText: "Delete" }).click();

  await expect.poll(() => body(page)).toBe("after");
});

test("the handle beside a table cell still stands for the table", async ({ page }) => {
  await seed(page, "| a | b |\n| --- | --- |\n| 1 | 2 |\n\nafter");

  const cell = page.locator(".ProseMirror td", { hasText: "1" }).first();
  await cell.hover({ position: { x: 4, y: 6 } });
  const handle = page.locator(".drag-handle");
  await expect(handle).toBeVisible();
  await handle.click();
  await page.locator(".block-menu-item", { hasText: "Delete" }).click();

  await expect.poll(() => body(page)).toBe("after");
  await expect(page.locator(".ProseMirror table")).toHaveCount(0);
});

test("undo puts a dragged item back where it was", async ({ page }) => {
  const start = "- parent\n  - child\n- last";
  await seed(page, start);

  await drag(page, "parent", "last", "below");
  await expect.poll(() => body(page)).toBe("- last\n- parent\n  - child");

  await page.locator(".ProseMirror").click();
  await page.keyboard.press("ControlOrMeta+z");

  await expect.poll(() => body(page)).toBe(start);
});
