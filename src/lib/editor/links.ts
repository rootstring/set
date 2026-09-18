import { Extension, InputRule, getMarkRange } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { COPY_SVG, EDIT_SVG, TRASH_SVG, showBlockMenu } from "./block-menu";
import { askLink } from "$lib/state/link-dialog.svelte";
import { normalizeUrl } from "./url";
import { openExternal } from "$lib/utils/open-url";

const LINK_MARK = "link";

/** The page scheme a subpage's own link uses — see `PageLink`. */
const PAGE_SCHEME = "page:";

const OPEN_SVG =
  '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" ' +
  'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12.75 9v3.25c0 .69-.56 1.25-1.25 1.25h-7c-.69 0-1.25-.56-1.25-1.25v-7c0-.69.56-1.25 1.25-1.25H7"/>' +
  '<path d="M10 2.5h3.5V6"/><path d="m7.75 8.25 5.5-5.5"/></svg>';

export interface LinkToolsOptions {
  /** A `page:` link is one of ours — it opens the page, not the browser. */
  onOpenPage?: (id: string) => void;
}

function pageIdIn(href: string): string | null {
  if (!href.toLowerCase().startsWith(PAGE_SCHEME)) return null;
  const id = decodeURIComponent(href.slice(PAGE_SCHEME.length));
  return id || null;
}

function open(href: string, options: LinkToolsOptions): void {
  const pageId = pageIdIn(href);
  if (pageId) {
    options.onOpenPage?.(pageId);
    return;
  }
  const target = normalizeUrl(href);
  if (target) void openExternal(target);
}

/** The link under a click, with the span of text it covers. */
function linkAt(
  view: EditorView,
  pos: number,
): { href: string; from: number; to: number } | null {
  const type = view.state.schema.marks[LINK_MARK];
  if (!type) return null;
  const $pos = view.state.doc.resolve(pos);
  const range = getMarkRange($pos, type);
  if (!range) return null;
  const mark = $pos
    .marks()
    .concat(view.state.doc.resolve(range.from + 1).marks())
    .find((m) => m.type === type);
  const href = typeof mark?.attrs.href === "string" ? mark.attrs.href : "";
  return href ? { href, ...range } : null;
}

/** The mark is StarterKit's; a click has to reach the OS, not replace the app window. */
export const LinkTools = Extension.create<LinkToolsOptions>({
  name: "linkTools",

  addOptions() {
    return { onOpenPage: undefined };
  },

  addInputRules() {
    const type = this.editor.schema.marks[LINK_MARK];
    if (!type) return [];

    return [
      new InputRule({
        // The Markdown form, closed by the `)` that just landed.
        find: /\[([^[\]]+)\]\((\S+)\)$/,
        handler: ({ state, range, match, chain }) => {
          const href = normalizeUrl(match[2]);
          const text = match[1];
          if (!href) return null;

          // Not inside a fence or inline code.
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.spec.code) return null;
          const codeMark = state.schema.marks.code;
          if (codeMark && codeMark.isInSet($from.marks())) return null;
          // An odd number of backticks to the left is a half-written code span.
          const before = $from.parent.textBetween(0, $from.parentOffset);
          if ((before.match(/`/g)?.length ?? 0) % 2 === 1) return null;

          chain()
            .insertContentAt(range, [
              { type: "text", text, marks: [{ type: LINK_MARK, attrs: { href } }] },
            ])
            // Whatever is typed after the closing bracket is not part of the
            // link — the syntax said where it ends.
            .unsetMark(LINK_MARK, { extendEmptyMarkRange: false })
            .run();
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    const options = this.options;
    const editor = this.editor;

    return [
      new Plugin({
        key: new PluginKey("linkTools"),
        props: {
          // Claims the click so the caret does not land in the link; the `click` that follows
          // activates the anchor.
          handleClick: (view, pos, event) => {
            if (event.button !== 0) return false;
            return linkAt(view, pos) !== null;
          },
          handleDOMEvents: {
            click: (view, event) => {
              if (event.button !== 0) return false;
              const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
              const hit = at ? linkAt(view, at.pos) : null;
              if (!hit) return false;
              // Otherwise the browser activates the anchor as well: one click, two windows. Only
              // bites on `click`.
              event.preventDefault();
              open(hit.href, options);
              return true;
            },
            contextmenu: (view, event) => {
              const at = view.posAtCoords({
                left: event.clientX,
                top: event.clientY,
              });
              const hit = at ? linkAt(view, at.pos) : null;
              if (!hit) return false;
              event.preventDefault();
              const anchor = (event.target as Element | null)?.closest?.("a") ?? null;
              showLinkMenu(
                editor,
                hit,
                options,
                event.clientX,
                event.clientY,
                anchor as HTMLElement | null,
              );
              return true;
            },
          },
        },
      }),
    ];
  },
});

function showLinkMenu(
  editor: Editor,
  hit: { href: string; from: number; to: number },
  options: LinkToolsOptions,
  x: number,
  y: number,
  anchor: HTMLElement | null,
): void {
  const text = editor.state.doc.textBetween(hit.from, hit.to);

  showBlockMenu(x, y, [
    { label: "Open link", icon: OPEN_SVG, run: () => open(hit.href, options) },
    {
      label: "Copy link",
      icon: COPY_SVG,
      run: () => void navigator.clipboard?.writeText(hit.href),
    },
    {
      label: "Edit link",
      icon: EDIT_SVG,
      disabled: !editor.isEditable,
      run: () => {
        void askLink({
          title: "Edit link",
          confirmLabel: "Save",
          href: hit.href,
          text,
          // The link itself, so the fields open beside the words they change.
          anchor: anchor ?? caretRect(editor),
        }).then((draft) => {
          if (!draft) return;
          applyLink(editor, hit, draft.href, draft.text || hit.href);
        });
      },
    },
    {
      label: "Remove link",
      icon: TRASH_SVG,
      danger: true,
      disabled: !editor.isEditable,
      run: () => {
        editor
          .chain()
          .focus()
          .setTextSelection({ from: hit.from, to: hit.to })
          .unsetMark(LINK_MARK)
          .setTextSelection(hit.to)
          .run();
      },
    },
  ]);
}

/** A link being written does not exist yet, so the caret is the next best anchor. */
export function caretRect(editor: Editor): DOMRect {
  const { from } = editor.state.selection;
  const at = editor.view.coordsAtPos(from);
  return new DOMRect(at.left, at.top, 0, Math.max(1, at.bottom - at.top));
}

/** Replace a link's span with its new text, wearing its new address. */
function applyLink(
  editor: Editor,
  at: { from: number; to: number },
  href: string,
  text: string,
): void {
  editor
    .chain()
    .focus()
    .insertContentAt(at, [
      { type: "text", text, marks: [{ type: LINK_MARK, attrs: { href } }] },
    ])
    .unsetMark(LINK_MARK, { extendEmptyMarkRange: false })
    .run();
}

/** Caret lands after with the mark off, so the next thing typed is ordinary writing. */
export function insertLink(editor: Editor, href: string, text: string): void {
  editor
    .chain()
    .focus()
    .insertContentAt(editor.state.selection, [
      { type: "text", text: text || href, marks: [{ type: LINK_MARK, attrs: { href } }] },
    ])
    .unsetMark(LINK_MARK, { extendEmptyMarkRange: false })
    .run();
}
