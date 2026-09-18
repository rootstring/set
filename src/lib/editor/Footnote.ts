import { Node } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { writeLines } from "./RawMarkdown";

interface State {
  write(content?: string): void;
  text(text: string, escape?: boolean): void;
  ensureNewLine(): void;
  closeBlock(node: PMNode): void;
}

/** `[^label]: body`; the body is edited as Markdown. */
export const FootnoteDefinition = Node.create({
  name: "footnoteDefinition",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,

  addAttributes() {
    return {
      label: {
        default: "1",
        parseHTML: (el) => el.getAttribute("data-footnote") ?? "1",
        renderHTML: (attrs) => ({ "data-footnote": attrs.label }),
      },
      space: {
        default: " ",
        parseHTML: (el) => el.getAttribute("data-space") ?? " ",
        renderHTML: (attrs) => ({ "data-space": attrs.space }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-footnote]", preserveWhitespace: "full", priority: 60 }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      { ...HTMLAttributes, class: "footnote-definition", spellcheck: "false" },
      0,
    ];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.className = "footnote-definition";
      dom.spellcheck = false;
      const label = document.createElement("span");
      label.className = "footnote-label";
      label.contentEditable = "false";
      const body = document.createElement("div");
      body.className = "footnote-body";
      dom.append(label, body);

      const paint = (current: PMNode) => {
        label.textContent = String(current.attrs.label);
        dom.setAttribute("data-footnote", String(current.attrs.label));
      };
      paint(node);

      return {
        dom,
        contentDOM: body,
        update: (updated) => {
          if (updated.type.name !== "footnoteDefinition") return false;
          paint(updated);
          return true;
        },
        ignoreMutation: (mutation) =>
          mutation.type !== "selection" && !body.contains(mutation.target),
      };
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: State, node: PMNode) {
          writeLines(
            state,
            `[^${node.attrs.label}]:${node.attrs.space}${node.textContent}`,
          );
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

/** `[^label]` in running text; a click goes to its definition. */
export const FootnoteReference = Node.create({
  name: "footnoteReference",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      label: {
        default: "1",
        parseHTML: (el) => el.getAttribute("data-footnote-ref") ?? "1",
        renderHTML: (attrs) => ({ "data-footnote-ref": attrs.label }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "sup[data-footnote-ref]", priority: 60 }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "sup",
      { ...HTMLAttributes, class: "footnote-ref" },
      String(node.attrs.label),
    ];
  },

  renderText: ({ node }) => `[^${node.attrs.label}]`,

  addStorage() {
    return {
      markdown: {
        serialize(state: State, node: PMNode) {
          state.text(`[^${node.attrs.label}]`, false);
        },
        parse: {},
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("footnoteReference"),
        props: {
          handleClickOn: (view, _pos, node, _nodePos, event) => {
            if (node.type.name !== "footnoteReference" || event.button !== 0)
              return false;
            let target = -1;
            view.state.doc.descendants((child, pos) => {
              if (target >= 0) return false;
              if (
                child.type.name === "footnoteDefinition" &&
                child.attrs.label === node.attrs.label
              ) {
                target = pos;
              }
              return !child.isTextblock;
            });
            if (target < 0) return false;
            const dom = view.nodeDOM(target);
            if (dom instanceof HTMLElement) dom.scrollIntoView({ block: "center" });
            view.dispatch(
              view.state.tr.setSelection(
                TextSelection.near(view.state.doc.resolve(target + 1)),
              ),
            );
            view.focus();
            return true;
          },
        },
      }),
    ];
  },
});

export const footnoteExtensions = [FootnoteDefinition, FootnoteReference];
