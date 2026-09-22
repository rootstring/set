import { InputRule, Node } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import {
  EDIT_SVG,
  MOVE_SVG,
  TRASH_SVG,
  showBlockMenu,
  type BlockMenuItem,
} from "./block-menu";
import { askForPage } from "./wiki-link-tools";
import { WIKI_LINK_ICON as ICON_SVG } from "@rootstring/set-markdown";

export interface WikiLinkOptions {
  onOpenPage?: (id: string) => void;
  /** The page a title names, if there is one. */
  resolvePageByTitle?: (title: string) => string | undefined;
  /** And the other way, for the menu row that re-points a link. */
  resolveTitleById?: (id: string) => string | undefined;
}

interface State {
  text(text: string, escape?: boolean): void;
}

/** `Page#Heading` links to the page; the section part is kept but not followed. */
const pageTitle = (target: string) => target.split("#")[0].trim();

const labelOf = (node: PMNode) => String(node.attrs.alias ?? node.attrs.target);

/** Three strokes: at 16px anything richer turns to a blob. */
const OPEN_SVG =
  '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" ' +
  'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M9.5 2.5h4v4"/><path d="M13.5 2.5 7.75 8.25"/>' +
  '<path d="M12 9.5v2.75c0 .69-.56 1.25-1.25 1.25h-7c-.69 0-1.25-.56-1.25-1.25v-7c0-.69.56-1.25 1.25-1.25H6.5"/></svg>';

/**
 * `[[Page]]` and `[[Page|shown as]]`. Resolved when drawn and again when clicked, so a page made
 * since works.
 */
export const WikiLink = Node.create<WikiLinkOptions>({
  name: "wikiLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return {
      onOpenPage: undefined,
      resolvePageByTitle: undefined,
      resolveTitleById: undefined,
    };
  },

  addAttributes() {
    return {
      target: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-wikilink") ?? "",
        renderHTML: (attrs) => ({ "data-wikilink": attrs.target }),
      },
      alias: {
        default: null,
        parseHTML: (el) =>
          el.hasAttribute("data-alias") ? el.getAttribute("data-alias") : null,
        renderHTML: (attrs) =>
          attrs.alias === null ? {} : { "data-alias": attrs.alias },
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-wikilink]", priority: 60 }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      { ...HTMLAttributes, class: "wiki-link" },
      ["span", { class: "wiki-link-icon" }],
      ["span", { class: "wiki-link-title" }, labelOf(node)],
    ];
  },

  renderText: ({ node }) => labelOf(node),

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = document.createElement("span");
      dom.className = "wiki-link";
      dom.contentEditable = "false";

      const icon = document.createElement("span");
      icon.className = "wiki-link-icon";
      icon.innerHTML = ICON_SVG;

      const label = document.createElement("span");
      label.className = "wiki-link-title";
      dom.append(icon, label);

      const resolve = () =>
        this.options.resolvePageByTitle?.(pageTitle(String(current.attrs.target)));
      // No tooltip: the dimming already says a link points nowhere.
      const paint = () => {
        label.textContent = labelOf(current);
        dom.classList.toggle("missing", !resolve());
      };
      paint();

      dom.addEventListener("click", (event) => {
        if (event.button !== 0) return;
        const id = resolve();
        if (!id) return;
        event.preventDefault();
        this.options.onOpenPage?.(id);
      });
      // A page made since this was drawn.
      dom.addEventListener("mouseenter", paint);

      dom.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const id = resolve();
        const items: BlockMenuItem[] = [];

        if (this.options.onOpenPage) {
          items.push({
            label: "Open page",
            icon: OPEN_SVG,
            // Kept, disabled: a missing row answers nothing.
            disabled: !id,
            run: () => id && this.options.onOpenPage?.(id),
          });
        }

        // These write to the document, so a locked page offers none of them.
        items.push({
          label: "Change page…",
          icon: MOVE_SVG,
          disabled: !editor.isEditable,
          run: () => {
            void askForPage((pageId) => this.options.resolveTitleById?.(pageId), {
              title: "Link to page",
              emptyTitle: "No page to link to",
              anchor: dom,
            }).then((title) => {
              if (!title) return;
              const at = getPos();
              if (at === undefined) return;
              // The alias stays: it is what you chose to call the link, and
              // re-pointing it is not a reason to take your words back.
              editor
                .chain()
                .focus()
                .command(({ tr }) => {
                  tr.setNodeMarkup(at, undefined, { ...current.attrs, target: title });
                  return true;
                })
                .run();
            });
          },
        });

        if (current.attrs.alias !== null) {
          items.push({
            label: "Use the page's name",
            icon: EDIT_SVG,
            disabled: !editor.isEditable,
            run: () => {
              const at = getPos();
              if (at === undefined) return;
              editor
                .chain()
                .focus()
                .command(({ tr }) => {
                  tr.setNodeMarkup(at, undefined, { ...current.attrs, alias: null });
                  return true;
                })
                .run();
            },
          });
        }

        items.push({
          label: "Remove link",
          icon: TRASH_SVG,
          danger: true,
          disabled: !editor.isEditable,
          run: () => {
            const at = getPos();
            if (at === undefined) return;
            // The words stay behind, as they do when a web link is removed.
            editor
              .chain()
              .focus()
              .insertContentAt({ from: at, to: at + current.nodeSize }, labelOf(current))
              .run();
          },
        });

        showBlockMenu(event.clientX, event.clientY, items);
      });

      return {
        dom,
        update: (updated) => {
          if (updated.type.name !== "wikiLink") return false;
          current = updated;
          paint();
          return true;
        },
        ignoreMutation: () => true,
      };
    };
  },

  addInputRules() {
    return [
      new InputRule({
        find: /\[\[([^[\]|\n]+)(?:\|([^[\]\n]+))?\]\]$/,
        handler: ({ state, range, match, chain }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.spec.code) return null;
          const code = state.schema.marks.code;
          if (code && code.isInSet($from.marks())) return null;
          chain()
            .insertContentAt(range, {
              type: this.name,
              attrs: { target: match[1], alias: match[2] ?? null },
            })
            .run();
        },
      }),
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: State, node: PMNode) {
          const alias = node.attrs.alias === null ? "" : `|${node.attrs.alias}`;
          state.text(`[[${node.attrs.target}${alias}]]`, false);
        },
        parse: {},
      },
    };
  },
});
