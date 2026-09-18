import { Node } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { showBlockMenu } from "./block-menu";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (kind?: string) => ReturnType;
    };
  }
}

/** GitHub's five; others (Obsidian) are kept. */
const KINDS = ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"] as const;

const svg = (body: string) =>
  '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" ' +
  'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  body +
  "</svg>";

const ICONS: Record<string, string> = {
  note: svg('<circle cx="8" cy="8" r="5.75"/><path d="M8 7.25v3.5M8 5.25h.01"/>'),
  tip: svg(
    '<path d="M6 12.25h4M6.75 14h2.5"/><path d="M8 2a4 4 0 0 0-2.4 7.2c.4.3.65.75.65 1.25v.3h3.5v-.3c0-.5.25-.95.65-1.25A4 4 0 0 0 8 2Z"/>',
  ),
  important: svg(
    '<path d="M2.75 3.25h10.5v7.5H8.5l-3 2.5v-2.5H2.75z"/><path d="M8 5v2.75M8 9.25h.01"/>',
  ),
  warning: svg('<path d="M8 2.25 14 13H2z"/><path d="M8 6.5v3M8 11.25h.01"/>'),
  caution: svg(
    '<path d="M5.5 2h5L14 5.5v5L10.5 14h-5L2 10.5v-5z"/><path d="M8 5v3.5M8 10.75h.01"/>',
  ),
};

const title = (kind: string) =>
  kind.charAt(0).toUpperCase() + kind.slice(1).toLowerCase();

interface State {
  write(content?: string): void;
  ensureNewLine(): void;
  closeBlock(node: PMNode): void;
  renderContent(node: PMNode): void;
  wrapBlock(delim: string, firstDelim: string | null, node: PMNode, f: () => void): void;
}

/**
 * `> [!NOTE]`: a GitHub alert or Obsidian callout. Edits like a quote; a click on the header
 * changes the kind.
 */
export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: "NOTE",
        parseHTML: (el) => el.getAttribute("data-callout") || "NOTE",
        renderHTML: (attrs) => ({ "data-callout": attrs.kind }),
      },
      title: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-title"),
        renderHTML: (attrs) => (attrs.title ? { "data-title": attrs.title } : {}),
      },
      fold: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-fold"),
        renderHTML: (attrs) => (attrs.fold ? { "data-fold": attrs.fold } : {}),
      },
      gap: {
        default: false,
        parseHTML: (el) => el.hasAttribute("data-gap"),
        renderHTML: (attrs) => (attrs.gap ? { "data-gap": "" } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-callout]", priority: 60 }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", { ...HTMLAttributes, class: "callout" }, 0];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = document.createElement("div");
      dom.className = "callout";
      const header = document.createElement("div");
      header.className = "callout-header";
      header.contentEditable = "false";
      const icon = document.createElement("span");
      icon.className = "callout-icon";
      const label = document.createElement("span");
      label.className = "callout-label";
      header.append(icon, label);
      const body = document.createElement("div");
      body.className = "callout-body";
      dom.append(header, body);

      const paint = () => {
        const kind = String(current.attrs.kind);
        dom.setAttribute("data-kind", kind.toLowerCase());
        icon.innerHTML = ICONS[kind.toLowerCase()] ?? ICONS.note;
        label.textContent = (current.attrs.title as string | null) || title(kind);
      };
      paint();

      header.addEventListener("mousedown", (event) => event.preventDefault());
      header.addEventListener("click", (event) => {
        if (!editor.isEditable || typeof getPos !== "function") return;
        const rect = header.getBoundingClientRect();
        const lower =
          String(current.attrs.kind) === String(current.attrs.kind).toLowerCase();
        showBlockMenu(
          rect.left,
          rect.bottom + 4,
          KINDS.map((kind) => ({
            label: title(kind),
            icon: ICONS[kind.toLowerCase()],
            run: () => {
              const pos = getPos();
              if (pos == null) return;
              const at = editor.state.doc.nodeAt(pos);
              if (!at) return;
              editor.view.dispatch(
                editor.state.tr.setNodeMarkup(pos, undefined, {
                  ...at.attrs,
                  kind: lower ? kind.toLowerCase() : kind,
                }),
              );
            },
          })),
        );
        event.preventDefault();
      });

      return {
        dom,
        contentDOM: body,
        update: (updated) => {
          if (updated.type.name !== "callout") return false;
          current = updated;
          paint();
          return true;
        },
        ignoreMutation: (mutation) =>
          mutation.type !== "selection" && !body.contains(mutation.target),
      };
    };
  },

  addCommands() {
    return {
      setCallout:
        (kind = "NOTE") =>
        ({ commands }) =>
          commands.wrapIn(this.name, { kind }),
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: State, node: PMNode) {
          const { kind, fold, title: heading, gap } = node.attrs;
          const marker = `[!${kind}]${fold ?? ""}${heading ? ` ${heading}` : ""}`;
          const first = node.firstChild;
          const empty =
            node.childCount === 1 &&
            first?.type.name === "paragraph" &&
            first.content.size === 0;
          state.wrapBlock("> ", null, node, () => {
            state.write(marker);
            if (empty) return;
            if (gap) state.closeBlock(node);
            else state.ensureNewLine();
            state.renderContent(node);
          });
        },
        parse: {},
      },
    };
  },
});
