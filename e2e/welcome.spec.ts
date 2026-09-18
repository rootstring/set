import { test, expect, type Page } from "@playwright/test";
import { livePages, putPages, removePages, storedPages } from "./db";

/** The first visit, which every other spec starts past (`storageState` in playwright.config.ts). */
test.use({ storageState: { cookies: [], origins: [] } });

const title = (page: Page) => page.locator("textarea.title");

/** The tree as storage holds it, children in the order the sidebar lists them. */
async function tree(page: Page): Promise<string[]> {
  const live = await livePages(page);
  const out: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const r of live.filter((x) => x.parentId === parent)) {
      out.push(`${r.context}/${"  ".repeat(depth)}${r.title}`);
      walk(r.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

test("a first visit opens on the welcome page, in the Set context", async ({ page }) => {
  await page.goto("/");

  await expect(title(page)).toHaveValue("Welcome to Set (beta)");
  await expect(page.getByTestId("context-switcher").locator(".context-name")).toHaveText(
    "Set",
  );
  await expect(page.locator(".ProseMirror .page-link-title")).toHaveText([
    "Markdown showcase",
    "Storage, Sync and Contexts",
  ]);
  // and open in the sidebar, sub-pages showing
  await expect(page.locator(".page-row .page-title")).toHaveText([
    "Welcome to Set (beta)",
    "Markdown showcase",
    "Storage, Sync and Contexts",
  ]);

  expect(await tree(page)).toEqual([
    "Set/Welcome to Set (beta)",
    "Set/  Markdown showcase",
    "Set/  Storage, Sync and Contexts",
  ]);
});

test("a sub-page opens from the welcome page", async ({ page }) => {
  await page.goto("/");
  await expect(title(page)).toHaveValue("Welcome to Set (beta)");

  await page
    .locator(".ProseMirror .page-link")
    .filter({ hasText: "Storage, Sync and Contexts" })
    .click();
  await expect(title(page)).toHaveValue("Storage, Sync and Contexts");
  await expect(page.locator(".ProseMirror h2")).toHaveText([
    "Storage",
    "Sync",
    "Contexts",
  ]);
});

test("a first new context is named in the switcher, without a detour to Settings", async ({
  page,
}) => {
  await page.goto("/");
  await expect(title(page)).toHaveValue("Welcome to Set (beta)");

  const switcher = page.getByTestId("context-switcher");
  await switcher.click();
  await page.getByTestId("context-new").click();
  await page.getByTestId("context-name-input").fill("Work");
  await page.keyboard.press("Enter");

  await expect(switcher.locator(".context-name")).toHaveText("Work");
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
  await expect(page.getByTestId("empty-new-page")).toBeVisible();
});

test("the welcome pages come once: gone, they stay gone", async ({ page }) => {
  await page.goto("/");
  await expect(title(page)).toHaveValue("Welcome to Set (beta)");

  // Deleted outright, trash and all, so nothing but having been welcomed
  // stands between an empty profile and a second welcome.
  await removePages(
    page,
    (await storedPages(page)).map((r) => r.id),
  );
  await page.goto("/");

  await expect(page.getByTestId("empty-new-page")).toBeVisible();
  expect(await storedPages(page)).toHaveLength(0);
});

test("someone who already has notes isn't welcomed", async ({ page }) => {
  // Somewhere on the app's origin that is not the app.
  await page.goto("/favicon.png");
  await putPages(page, [{ id: "w-own", title: "My own notes", body: "Mine." }]);

  await page.goto("/");

  await expect(title(page)).toHaveValue("My own notes");
  expect((await storedPages(page)).map((r) => r.title)).toEqual(["My own notes"]);

  // And not later, either, once those notes are gone.
  await removePages(page, ["w-own"]);
  await page.goto("/");
  await expect(page.getByTestId("empty-new-page")).toBeVisible();
});
