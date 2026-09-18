import type { Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extension-placeholder";
import { HorizontalRule } from "@tiptap/extension-horizontal-rule";
import { Highlight } from "@tiptap/extension-highlight";
import { Subscript } from "@tiptap/extension-subscript";
import { Superscript } from "@tiptap/extension-superscript";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { DragHandle } from "@tiptap/extension-drag-handle";
import { Markdown } from "tiptap-markdown";
import { SlashCommand } from "./slash.svelte";
import { DateMentionCommand } from "./mention.svelte";
import { PageLink, PageLinkGuard } from "./PageLink";
import { LinkTools } from "./links";
import { DateMention } from "./DateMention";
import { Image } from "./Image";
import { detailsExtensions } from "./Details";
import { outsideCells, tableExtensions, TableTools } from "./Table";
import { rawMarkdownExtensions } from "./RawMarkdown";
import { footnoteExtensions } from "./Footnote";
import { WikiLink } from "./WikiLink";
import { Callout } from "./Callout";
import { InlineImage } from "./InlineImage";
import { MarkdownFidelity } from "./markdown";
import { ListBackspace } from "./list-keymap";
import { ListMixing } from "./list-mixing";
import { CodeBlockHighlight, CodeBlockMarkdown } from "./code-block";
import { EditorTab, LeadingBackspace } from "./keymaps";
import { DragHitArea } from "./drag-hit-area";
import { TodoRollup } from "./todo-rollup";
import { lowlight } from "./lowlight";
import { createDragHandle, NESTED, type DragHandleController } from "./drag-handle";
import type { MoveBlockRequest } from "./block-move";
import { settings } from "$lib/state/settings.svelte";
import type { PageSummary } from "$lib/types";

export interface EditorSchemaOptions {
  placeholder?: string;
  interactive?: boolean;
  onOpenPage?: (id: string) => void;
  resolveTitle?: (id: string) => string | undefined;
  /** The page a `[[wikilink]]`'s title names, if there is one. */
  resolvePageByTitle?: (title: string) => string | undefined;
  onCreateChildPage?: () => Promise<PageSummary>;
  onDeletePage?: (id: string, anchor: HTMLElement | null) => void;
  onDuplicatePage?: (id: string) => void;
  onMoveBlock?: MoveBlockRequest;
  resolveAssetUrl?: (ref: string) => Promise<string | null>;
  onInsertAsset?: (file: File) => Promise<string | null>;
  onDragHandleReady?: (controller: DragHandleController) => void;
}

export function createExtensions(options: EditorSchemaOptions = {}): Extensions {
  const { interactive = true } = options;

  const extensions: Extensions = [
    StarterKit.configure({
      // The slash menu offers three; a file may hold six.
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      codeBlock: false as const,
      // StarterKit's handler opens links inside the app via `window.open`; `LinkTools` hands them
      // to the OS.
      link: { openOnClick: false, defaultProtocol: "https" },
      // Own rule below, so `---` in a table cell stays text.
      horizontalRule: false,
    }),
    HorizontalRule.extend({
      addInputRules() {
        return outsideCells(this.parent?.() ?? []);
      },
    }),
    interactive
      ? CodeBlockHighlight.configure({
          lowlight,
          defaultLanguage: "plaintext",
          HTMLAttributes: { spellcheck: "false" },
        })
      : CodeBlockMarkdown,
    TaskList,
    TaskItem.configure({ nested: true }),
    ...detailsExtensions,
    ...tableExtensions,
    ...rawMarkdownExtensions,
    ...footnoteExtensions,
    WikiLink.configure({
      onOpenPage: options.onOpenPage,
      resolvePageByTitle: options.resolvePageByTitle,
      resolveTitleById: options.resolveTitle,
    }),
    Callout,
    InlineImage.configure({ resolveAssetUrl: options.resolveAssetUrl }),
    Highlight,
    // ⌘, is Settings.
    Subscript.extend({
      addKeyboardShortcuts() {
        return { "Mod-Alt-,": () => this.editor.commands.toggleSubscript() };
      },
    }),
    Superscript,
    ListBackspace,
    LeadingBackspace,
    ListMixing,
    EditorTab,
    PageLink.configure({
      onOpenPage: options.onOpenPage,
      resolveTitle: options.resolveTitle,
      onDeletePage: options.onDeletePage,
      onDuplicatePage: options.onDuplicatePage,
      onMoveBlock: options.onMoveBlock,
    }),
    PageLinkGuard,
    LinkTools.configure({ onOpenPage: options.onOpenPage }),
    DateMention,
    Image.configure({
      resolveAssetUrl: options.resolveAssetUrl,
      onInsertAsset: options.onInsertAsset,
    }),
    Markdown.configure({
      html: true,
      tightLists: true,
      transformPastedText: true,
      transformCopiedText: false,
    }),
    MarkdownFidelity,
  ];

  if (interactive) {
    const dragHandle = createDragHandle({
      onDeletePage: options.onDeletePage,
      onDuplicatePage: options.onDuplicatePage,
    });
    options.onDragHandleReady?.(dragHandle);
    extensions.push(
      Placeholder.configure({
        placeholder: ({ editor, node, pos }) => {
          if (node.type.name === "heading") return `Heading ${node.attrs.level}`;

          if (node.type.spec.code) return "";
          // Only on the first line of an empty page; `isEmpty` alone is true for a page of blank
          // lines.
          if (pos !== 0 || !editor.isEmpty) return "";
          const base = options.placeholder ?? "Write something";
          return settings.slashMenu ? `${base}, or press '/' for commands…` : `${base}…`;
        },
        includeChildren: false,
      }),
      // At equal priority the last listed handles a key first: an open menu takes Enter before a
      // cell.
      TableTools,
      SlashCommand.configure({
        createChildPage: options.onCreateChildPage,
        openPage: options.onOpenPage,
        resolveTitle: options.resolveTitle,
      }),
      DateMentionCommand,
      DragHandle.configure({ ...dragHandle, nested: NESTED }),
      DragHitArea,
      TodoRollup,
    );
  }

  return extensions;
}
