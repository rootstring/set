import { Node } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

/** What the editor has no node for is kept as written. See `markdown/syntax.ts` for routing. */

interface State {
  write(content?: string): void;
  text(text: string, escape?: boolean): void;
  ensureNewLine(): void;
  closeBlock(node: PMNode): void;
  inTable?: boolean;
  lineStartPending?: boolean;
}

/** Write multi-line source so that every line gets its container's prefix. */
export function writeLines(state: State, source: string): void {
  source.split("\n").forEach((line, i) => {
    if (i) state.ensureNewLine();
    state.write(line);
  });
}

/** An HTML block the editor cannot show, or a run of reference definitions. */
export const RawBlock = Node.create({
  name: "rawBlock",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-kind"),
        renderHTML: (attrs) => (attrs.kind ? { "data-kind": attrs.kind } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-raw-block]", preserveWhitespace: "full", priority: 60 }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      {
        ...HTMLAttributes,
        "data-raw-block": "",
        class: "raw-block",
        spellcheck: "false",
      },
      0,
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: State, node: PMNode) {
          writeLines(state, node.textContent);
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

/** Inline HTML the editor has no mark for — `<kbd>`, `<span …>`, a comment. */
export const RawInline = Node.create({
  name: "rawInline",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      source: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-raw-inline") ?? "",
        renderHTML: (attrs) => ({ "data-raw-inline": attrs.source }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-raw-inline]", priority: 60 }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      { ...HTMLAttributes, class: "raw-inline" },
      String(node.attrs.source),
    ];
  },

  renderText: () => "",

  addStorage() {
    return {
      markdown: {
        serialize(state: State, node: PMNode) {
          state.text(String(node.attrs.source), false);
        },
        parse: {},
      },
    };
  },
});

/** Reads as a space, written back as the newline it was. */
export const SoftBreak = Node.create({
  name: "softBreak",
  group: "inline",
  inline: true,
  selectable: false,

  parseHTML() {
    return [{ tag: "span[data-soft-break]", priority: 60 }];
  },

  renderHTML() {
    return ["span", { "data-soft-break": "", class: "soft-break" }, " "];
  },

  renderText: () => " ",

  extendNodeSchema() {
    return { leafText: () => " " };
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: State, node: PMNode, parent: PMNode) {
          const setext =
            parent.type.name === "heading" &&
            /^(=+|-+)$/.test(String(parent.attrs.markup ?? ""));
          if (state.inTable || (parent.type.name === "heading" && !setext)) {
            state.text(" ", false);
            return;
          }
          state.text("\n", false);
          state.lineStartPending = true;
        },
        parse: {},
      },
    };
  },
});

/** `&copy;`, `&#8212;` — shown as the character, written as the entity. */
export const Entity = Node.create({
  name: "entity",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      markup: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-entity") ?? "",
        renderHTML: (attrs) => ({ "data-entity": attrs.markup }),
      },
      text: {
        default: "",
        parseHTML: (el) => el.textContent ?? "",
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-entity]", priority: 60 }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["span", { ...HTMLAttributes, class: "entity" }, String(node.attrs.text)];
  },

  renderText: ({ node }) => String(node.attrs.text),

  extendNodeSchema() {
    return { leafText: (node: PMNode) => String(node.attrs.text) };
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: State, node: PMNode) {
          state.text(String(node.attrs.markup), false);
        },
        parse: {},
      },
    };
  },
});

export const rawMarkdownExtensions = [RawBlock, RawInline, SoftBreak, Entity];
