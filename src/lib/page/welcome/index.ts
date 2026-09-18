import type { Page, PageId } from "$lib/types";
import type { PageStore } from "$lib/storage/store";
import type { BindingId, Shortcut } from "$lib/state/settings.svelte";
import { formatDateLabel, toISO, withTime } from "$lib/editor/date-format";
import welcomeTemplate from "./welcome.md?raw";
import showcaseTemplate from "./showcase.md?raw";
import guideTemplate from "./storage-sync-contexts.md?raw";

/**
 * Prose lives in the `.md` files beside this; `{{name}}` is filled in with the machine's shortcuts
 * and today's date.
 */

export const WELCOME_TITLE = "Welcome to Set (beta)";

export interface WelcomeOptions {
  /** The context the pages are made in. */
  context: string;
  /** What a binding is set to, `""` when it has been cleared. */
  binding: (id: BindingId) => Shortcut;
  /** A shortcut as this platform writes it: `⌘K` on a Mac, `Ctrl+K` elsewhere. */
  formatShortcut: (shortcut: Shortcut) => string;
  /** The feedback form, with this build's version and platform filled in. */
  feedbackUrl: string;
  now?: Date;
}

export interface WelcomeDraft {
  title: string;
  body: string;
}

const CHILDREN: { title: string; body: (opts: WelcomeOptions) => string }[] = [
  { title: "Markdown showcase", body: showcase },
  { title: "Storage, Sync and Contexts", body: guide },
];

/** The sub-pages, in the order the sidebar lists them. */
export function welcomeChildren(opts: WelcomeOptions): WelcomeDraft[] {
  return CHILDREN.map(({ title, body }) => ({ title, body: body(opts) }));
}

/** The parent page, which links each sub-page by the id it was made under. */
export function welcomeRoot(
  opts: WelcomeOptions,
  children: { id: PageId; title: string }[],
): WelcomeDraft {
  return {
    title: WELCOME_TITLE,
    body: fill(welcomeTemplate, {
      pages: children.map((c) => `[${c.title}](page:${c.id})`).join("\n\n"),
      quickSwitcher: key(opts, opts.binding("quickSwitcher")),
      feedback: opts.feedbackUrl,
    }),
  };
}

/**
 * Sub-pages first so the parent can link them, and ordered before any body is written, or they tie
 * on creation time.
 */
export async function seedWelcome(
  store: PageStore,
  opts: WelcomeOptions,
): Promise<PageId> {
  const root = await store.create({ title: WELCOME_TITLE, context: opts.context });

  const drafts = welcomeChildren(opts);
  const children: Page[] = [];
  for (const { title } of drafts) {
    children.push(await store.create({ title, parentId: root.id }));
  }
  const ids = children.map((c) => c.id);
  await store.move(ids[0], root.id, ids);

  for (const [i, page] of children.entries()) await store.save(page, drafts[i].body);
  await store.save(root, welcomeRoot(opts, children).body);
  return root.id;
}

function showcase(opts: WelcomeOptions): string {
  const now = opts.now ?? new Date();
  const today = toISO(now);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const morning = withTime(toISO(tomorrow), "09:00");
  return fill(showcaseTemplate, {
    quickSwitcher: key(opts, opts.binding("quickSwitcher")),
    today: dateMention(today, now),
    tomorrowMorning: dateMention(morning, now),
  });
}

function guide(opts: WelcomeOptions): string {
  return fill(guideTemplate, {
    context: opts.context,
    desktopContextKeys: `${key(opts, "Mod+Digit1")} to ${key(opts, "Mod+Digit9")}`,
    webContextKeys: `${key(opts, "Mod+Alt+Digit1")} to ${key(opts, "Mod+Alt+Digit9")}`,
    quickSwitcher: key(opts, opts.binding("quickSwitcher")),
  });
}

/** A shortcut as inline code, fenced wider when it is itself the backtick key. */
function key(opts: WelcomeOptions, shortcut: Shortcut): string {
  const label = opts.formatShortcut(shortcut);
  return label.includes("`") ? `\`\` ${label} \`\`` : `\`${label}\``;
}

function dateMention(iso: string, now: Date): string {
  return `[${formatDateLabel(iso, now)}](date:${iso})`;
}

function fill(template: string, values: Record<string, string>): string {
  return template.trimEnd().replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`welcome page has no value for {{${name}}}`);
    return value;
  });
}
