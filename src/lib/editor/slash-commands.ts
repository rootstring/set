import type { Editor, Range } from "@tiptap/core";
import { isInTable } from "@tiptap/pm/tables";
import type { PageSummary } from "$lib/types";
import type { IconName } from "$lib/shell/icons";
import { dictation } from "$lib/state/dictation.svelte";
import { insertDateMention } from "./DateMention";
import { editMath } from "./Math";
import { caretRect, insertLink } from "./links";
import { askLink } from "$lib/state/link-dialog.svelte";
import { askForPage, insertWikiLink } from "./wiki-link-tools";
import { toISO, startOfDay } from "./date-format";

export interface SlashContext {
  createChildPage?: () => Promise<PageSummary>;
  openPage?: (id: string) => void;
  /** A `[[wikilink]]` is written as a title, and the picker answers with an id. */
  resolveTitle?: (id: string) => string | undefined;
}

export interface SlashItem {
  title: string;
  subtitle: string;
  icon: IconName;
  keywords: string[];
  /** Offered inside a table cell too; a block would split the table. */
  inline?: boolean;
  available?: () => boolean;
  run: (editor: Editor, range: Range, ctx: SlashContext) => void;
}

const SLASH_ITEMS: SlashItem[] = [
  {
    title: "Page",
    subtitle: "Create a nested page",
    icon: "page",
    keywords: ["page", "subpage", "child", "nested", "link", "document"],
    run: async (editor, range, ctx) => {
      if (!ctx.createChildPage) {
        editor.chain().focus().deleteRange(range).run();
        return;
      }
      const child = await ctx.createChildPage();
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent({
          type: "pageLink",
          attrs: { pageId: child.id, title: child.title },
        })
        .run();

      ctx.openPage?.(child.id);
    },
  },
  {
    title: "Link to page",
    subtitle: "Point at a page you already have",
    icon: "page-link",
    keywords: ["link", "page", "wikilink", "reference", "mention", "existing", "to"],
    // Inline, unlike "Page": this one goes in the sentence you are writing,
    // where a subpage takes a block of its own.
    inline: true,
    run: (editor, range, ctx) => {
      editor.chain().focus().deleteRange(range).run();
      void askForPage(ctx.resolveTitle, {
        title: "Link to page",
        emptyTitle: "No page to link to",
        anchor: caretRect(editor),
      }).then((title) => {
        if (title) insertWikiLink(editor, title);
      });
    },
  },
  {
    title: "Text",
    subtitle: "Plain paragraph",
    icon: "text",
    keywords: ["paragraph", "body", "plain"],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setParagraph().run(),
  },
  {
    title: "Heading 1",
    subtitle: "Big section heading",
    icon: "h1",
    keywords: ["h1", "title", "large"],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 1 }).run(),
  },
  {
    title: "Heading 2",
    subtitle: "Medium section heading",
    icon: "h2",
    keywords: ["h2", "subtitle", "medium"],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 2 }).run(),
  },
  {
    title: "Heading 3",
    subtitle: "Small section heading",
    icon: "h3",
    keywords: ["h3", "small"],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 3 }).run(),
  },
  {
    title: "To-do list",
    subtitle: "Track tasks with checkboxes",
    icon: "todo",
    keywords: ["todo", "task", "checkbox", "check"],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    title: "Bullet list",
    subtitle: "Simple unordered list",
    icon: "bullet",
    keywords: ["unordered", "ul", "list", "bullet"],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    title: "Numbered list",
    subtitle: "Ordered list with numbers",
    icon: "ordered",
    keywords: ["ordered", "ol", "list", "number"],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    title: "Toggle",
    subtitle: "Collapsible section",
    icon: "toggle",
    keywords: ["toggle", "details", "collapse", "collapsible", "expand", "accordion"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).setDetails().run(),
  },
  {
    title: "Image",
    subtitle: "Add an image from your computer",
    icon: "image",
    keywords: ["image", "picture", "photo", "img", "upload", "media", "screenshot"],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).pickImageFiles().run(),
  },
  {
    title: "Link",
    subtitle: "Link out to the web",
    icon: "link",
    keywords: ["link", "url", "web", "address", "http", "href", "hyperlink"],
    inline: true,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      void askLink({ anchor: caretRect(editor) }).then((draft) => {
        if (draft) insertLink(editor, draft.href, draft.text);
      });
    },
  },
  {
    title: "Quote",
    subtitle: "Capture a quotation",
    icon: "quote",
    keywords: ["blockquote", "cite"],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    title: "Code",
    subtitle: "Code block with monospace",
    icon: "code",
    keywords: ["snippet", "pre", "monospace"],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    title: "Equation",
    subtitle: "A block of LaTeX math",
    icon: "math",
    keywords: ["math", "latex", "katex", "tex", "formula", "equation", "display"],
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertMathBlock().run();
      editMath(editor, editor.state.selection.from);
    },
  },
  {
    title: "Inline equation",
    subtitle: "LaTeX math inside a sentence",
    icon: "math",
    keywords: ["math", "latex", "katex", "tex", "formula", "equation", "inline"],
    inline: true,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertMathInline().run();
      editMath(editor, editor.state.selection.from);
    },
  },
  {
    title: "Callout",
    subtitle: "A note, tip or warning",
    icon: "callout",
    keywords: [
      "callout",
      "alert",
      "admonition",
      "note",
      "tip",
      "warning",
      "caution",
      "important",
    ],
    run: (editor, range) => editor.chain().focus().deleteRange(range).setCallout().run(),
  },
  {
    title: "Table",
    subtitle: "Rows and columns",
    icon: "table",
    keywords: ["grid", "rows", "columns", "spreadsheet", "tabular"],
    run: (editor, range) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
  },
  {
    title: "Dictation",
    subtitle: "Speak, and have it typed here",
    icon: "mic",
    keywords: [
      "diction",
      "dictate",
      "speak",
      "voice",
      "mic",
      "microphone",
      "speech",
      "transcribe",
      "whisper",
      "audio",
    ],
    inline: true,
    available: () => dictation.offered,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      void dictation.begin();
    },
  },
  {
    title: "Date",
    subtitle: "Insert a date mention",
    icon: "date",
    keywords: [
      "date",
      "day",
      "calendar",
      "due",
      "deadline",
      "schedule",
      "remind",
      "when",
    ],
    inline: true,
    run: (editor, range) =>
      insertDateMention(editor, range, toISO(startOfDay(new Date())), true),
  },
  {
    title: "Divider",
    subtitle: "Visual separator",
    icon: "divider",
    keywords: ["hr", "rule", "separator", "line"],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
];

function offeredItems(editor: Editor): SlashItem[] {
  const inCell = isInTable(editor.state);
  return SLASH_ITEMS.filter(
    (item) => (item.available?.() ?? true) && (!inCell || item.inline),
  );
}

/**
 * A query naming an item outright puts it first; between two, the shorter title wins (as in
 * `search/titles.ts`).
 */
export function filterSlashItems(query: string, editor: Editor): SlashItem[] {
  const items = offeredItems(editor);
  const q = query.trim().toLowerCase();
  if (!q) return items;

  const named: SlashItem[] = [];
  const rest: SlashItem[] = [];
  for (const item of items) {
    const title = item.title.toLowerCase();
    if (title.startsWith(q)) named.push(item);
    else if ([title, ...item.keywords].join(" ").includes(q)) rest.push(item);
  }
  named.sort((a, b) => a.title.length - b.title.length);
  return [...named, ...rest];
}
