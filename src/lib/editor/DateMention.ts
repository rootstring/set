import { Node, mergeAttributes } from "@tiptap/core";
import type { Editor, Range } from "@tiptap/core";
import { formatDateLabel } from "./date-format";
import { showDatePicker } from "./date-picker";
import { CALENDAR_ICON as CALENDAR_SVG } from "@rootstring/set-markdown";

const DATE_NODE = "date";

const SCHEME = "date:";

export function insertDateMention(
  editor: Editor,
  range: Range,
  iso: string,
  openPicker: boolean,
): void {
  const pos = range.from;
  editor
    .chain()
    .focus()
    .deleteRange(range)
    .insertContent({ type: DATE_NODE, attrs: { date: iso } })
    .run();
  if (!openPicker) return;
  const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
  if (!dom) return;
  const rect = dom.getBoundingClientRect();
  showDatePicker(rect.left, rect.bottom + 6, {
    value: iso,
    onSelect: (picked) => {
      editor.view.dispatch(
        editor.view.state.tr.setNodeMarkup(pos, undefined, { date: picked }),
      );
    },
    onClear: () => {
      editor.view.dispatch(editor.view.state.tr.delete(pos, pos + 1));
    },
  });
}

export const DateMention = Node.create({
  name: DATE_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      date: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-date"),
        renderHTML: (attrs) => (attrs.date ? { "data-date": attrs.date } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-date-mention]" }];
  },
  renderHTML({ HTMLAttributes, node }) {
    const iso = node.attrs.date as string | null;
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-date-mention": "", class: "date-mention" }),
      iso ? formatDateLabel(iso) : "Set date",
    ];
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = document.createElement("span");
      dom.className = "date-mention";
      dom.setAttribute("data-date-mention", "");
      dom.contentEditable = "false";

      const icon = document.createElement("span");
      icon.className = "date-mention-icon";
      icon.innerHTML = CALENDAR_SVG;

      const label = document.createElement("span");
      label.className = "date-mention-label";

      const paint = (attrs: { date: string | null }) => {
        if (attrs.date) dom.setAttribute("data-date", attrs.date);
        else dom.removeAttribute("data-date");
        label.textContent = attrs.date ? formatDateLabel(attrs.date) : "Set date";
      };
      paint(node.attrs as { date: string | null });

      dom.append(icon, label);

      dom.addEventListener("click", (event) => {
        event.preventDefault();
        // On a locked page the picker must not write to the document.
        if (!editor.isEditable) return;
        if (typeof getPos !== "function") return;
        const rect = dom.getBoundingClientRect();
        showDatePicker(rect.left, rect.bottom + 6, {
          value: current.attrs.date as string | null,
          onSelect: (iso) => {
            const pos = getPos();
            if (pos == null) return;
            editor.view.dispatch(
              editor.view.state.tr.setNodeMarkup(pos, undefined, { date: iso }),
            );
          },
          onClear: () => {
            const pos = getPos();
            if (pos == null) return;
            editor.view.dispatch(
              editor.view.state.tr.delete(pos, pos + current.nodeSize),
            );
          },
        });
      });

      return {
        dom,
        update: (updated) => {
          if (updated.type.name !== this.name) return false;
          current = updated;
          paint(updated.attrs as { date: string | null });
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
          state: { write(s: string): void },
          node: { attrs: { date: string | null } },
        ) {
          const iso = node.attrs.date ?? "";
          const label = (iso ? formatDateLabel(iso) : "").replace(/[[\]]/g, "");
          state.write(`[${label}](${SCHEME}${iso})`);
        },
        parse: {
          updateDOM(element: HTMLElement) {
            element.querySelectorAll(`a[href^="${SCHEME}"]`).forEach((a) => {
              const href = a.getAttribute("href") ?? "";
              const iso = decodeURIComponent(href.slice(SCHEME.length));
              const span = element.ownerDocument.createElement("span");
              span.setAttribute("data-date-mention", "");
              if (iso) span.setAttribute("data-date", iso);
              a.replaceWith(span);
            });
          },
        },
      },
    };
  },
});
