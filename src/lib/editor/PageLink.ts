import { Extension, Node, mergeAttributes } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { PAGE_LINK_NODE } from "./page-links";
import {
  TRASH_SVG,
  DUPLICATE_SVG,
  showBlockMenu,
  type BlockMenuItem,
} from "./block-menu";
import type { MoveBlockRequest } from "./block-move";
import { pageLinkDrop } from "./page-link-drop";

export interface PageLinkOptions {
  onOpenPage?: (id: string) => void;
  resolveTitle?: (id: string) => string | undefined;
  onDeletePage?: (id: string, anchor: HTMLElement | null) => void;
  onDuplicatePage?: (id: string) => void;
  onMoveBlock?: MoveBlockRequest;
}

const SCHEME = "page:";

const ICON_SVG =
  '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" ' +
  'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M9 1.83H4.75c-.69 0-1.25.56-1.25 1.25v9.84c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25V5.5Z"/>' +
  '<path d="M9 1.83V5.5h3.5"/><path d="M5.75 8.75h4.5M5.75 11.25h3"/></svg>';

function displayTitle(title: string): string {
  return title.trim() || "Untitled";
}

export const PageLink = Node.create<PageLinkOptions>({
  name: PAGE_LINK_NODE,
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addOptions() {
    return {
      onOpenPage: undefined,
      resolveTitle: undefined,
      onDeletePage: undefined,
      onDuplicatePage: undefined,
      onMoveBlock: undefined,
    };
  },
  addAttributes() {
    return {
      pageId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-page-id"),
        renderHTML: (attrs) => (attrs.pageId ? { "data-page-id": attrs.pageId } : {}),
      },
      title: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-title") ?? el.textContent ?? "",
        renderHTML: (attrs) => ({ "data-title": attrs.title }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-page-link]" }];
  },
  renderHTML({ HTMLAttributes, node }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-page-link": "", class: "page-link" }),
      displayTitle(String(node.attrs.title ?? "")),
    ];
  },
  addProseMirrorPlugins() {
    return [pageLinkDrop(this.editor, () => this.options.onMoveBlock)];
  },
  addNodeView() {
    return ({ node, editor }) => {
      let current = node;
      const dom = document.createElement("div");
      dom.className = "page-link";
      dom.setAttribute("data-page-link", "");
      dom.contentEditable = "false";

      const icon = document.createElement("span");
      icon.className = "page-link-icon";
      icon.innerHTML = ICON_SVG;

      const label = document.createElement("span");
      label.className = "page-link-title";

      const paint = (attrs: { pageId: string | null; title: string }) => {
        if (attrs.pageId) dom.setAttribute("data-page-id", attrs.pageId);
        const live = attrs.pageId ? this.options.resolveTitle?.(attrs.pageId) : undefined;
        label.textContent = displayTitle(live ?? String(attrs.title ?? ""));
      };
      paint(node.attrs as { pageId: string | null; title: string });

      dom.append(icon, label);
      dom.addEventListener("click", () => {
        const id = current.attrs.pageId;
        if (id) this.options.onOpenPage?.(id);
      });

      dom.addEventListener("contextmenu", (event) => {
        const id = current.attrs.pageId;
        const onDelete = this.options.onDeletePage;
        if (!id || !onDelete) return; // no handler (e.g. headless) → native menu
        // Every item writes to the page, so a locked page has none.
        if (!editor.isEditable) return;
        event.preventDefault();
        const items: BlockMenuItem[] = [];
        const onDuplicate = this.options.onDuplicatePage;
        if (onDuplicate) {
          items.push({
            label: "Duplicate",
            icon: DUPLICATE_SVG,
            run: () => onDuplicate(id),
          });
        }
        items.push({
          label: "Delete",
          icon: TRASH_SVG,
          danger: true,
          run: () => onDelete(id, dom),
        });
        showBlockMenu(event.clientX, event.clientY, items);
      });

      return {
        dom,
        update: (updated) => {
          if (updated.type.name !== this.name) return false;
          current = updated;
          paint(updated.attrs as { pageId: string | null; title: string });
          return true;
        },
        ignoreMutation: () => true,
      };
    };
  },
  addStorage() {
    return {
      markdown: {
        serialize(
          state: { write(s: string): void; closeBlock(n: unknown): void },
          node: { attrs: { pageId: string | null; title: string } },
        ) {
          const title = displayTitle(String(node.attrs.title ?? "")).replace(
            /[[\]]/g,
            "",
          );
          state.write(`[${title}](${SCHEME}${node.attrs.pageId ?? ""})`);
          state.closeBlock(node);
        },
        parse: {
          updateDOM(element: HTMLElement) {
            element.querySelectorAll(`a[href^="${SCHEME}"]`).forEach((a) => {
              const href = a.getAttribute("href") ?? "";
              const id = decodeURIComponent(href.slice(SCHEME.length));
              const text = a.textContent ?? "";
              const div = element.ownerDocument.createElement("div");
              div.setAttribute("data-page-link", "");
              div.setAttribute("data-page-id", id);
              div.setAttribute("data-title", text);
              const p = a.closest("p");
              if (p && (p.textContent ?? "").trim() === text.trim()) {
                p.replaceWith(div);
              } else {
                a.replaceWith(div);
              }
            });
          },
        },
      },
    };
  },
});

export const PageLinkGuard = Extension.create({
  name: "pageLinkGuard",
  priority: 1100,
  addKeyboardShortcuts() {
    const name = PAGE_LINK_NODE;
    const editor = this.editor;

    const selectionSpansLink = (): boolean => {
      const { selection, doc } = editor.state;
      if (selection.empty) return false;
      if (selection instanceof NodeSelection && selection.node.type.name === name) {
        return true;
      }
      let hit = false;
      doc.nodesBetween(selection.from, selection.to, (node) => {
        if (node.type.name === name) hit = true;
      });
      return hit;
    };

    return {
      Backspace: (): boolean => {
        if (selectionSpansLink()) return true;
        const { selection, doc } = editor.state;
        const { empty, $from } = selection;
        if (empty && $from.depth > 0 && $from.parentOffset === 0) {
          const before = doc.resolve($from.before()).nodeBefore;
          if (before?.type.name === name) return true;
        }
        return false;
      },
      Delete: (): boolean => {
        if (selectionSpansLink()) return true;
        const { selection, doc } = editor.state;
        const { empty, $from } = selection;
        if (
          empty &&
          $from.depth > 0 &&
          $from.parentOffset === $from.parent.content.size
        ) {
          const after = doc.resolve($from.after()).nodeAfter;
          if (after?.type.name === name) return true;
        }
        return false;
      },
    };
  },
});
