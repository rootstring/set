import { InputRule, Node, type Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import {
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { askMath } from "$lib/state/math-dialog.svelte";
import { delimit } from "./markdown/math";
import { cancelMath, renderMath } from "./math-render";
import { writeLines } from "./RawMarkdown";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    math: {
      /** Inserts the equation selected, for `editMath` to open on. */
      insertMathInline: (source?: string) => ReturnType;
      /** Puts a block equation in place of the current block, selected. */
      insertMathBlock: (source?: string) => ReturnType;
    };
  }
}

interface State {
  write(content?: string): void;
  text(text: string, escape?: boolean): void;
  ensureNewLine(): void;
  closeBlock(node: PMNode): void;
}

const INLINE = "mathInline";
const BLOCK = "mathBlock";

const isMath = (node: PMNode | null | undefined): node is PMNode =>
  node?.type.name === INLINE || node?.type.name === BLOCK;

const inlineText = (node: PMNode) =>
  delimit(String(node.attrs.source), Boolean(node.attrs.display));

/**
 * Open the dialog on the equation at `pos`. The page shows only the drawing; the source is
 * typed in the dialog, with what KaTeX makes of it, and reaches the document once, when kept.
 * A new equation dismissed with nothing in it is removed.
 */
export function editMath(editor: Editor, pos: number): void {
  const node = editor.state.doc.nodeAt(pos);
  if (!isMath(node) || !editor.isEditable) return;
  const source = String(node.attrs.source);
  const block = node.type.name === BLOCK;
  const dom = editor.view.nodeDOM(pos);
  const at = editor.view.coordsAtPos(pos);
  const anchor =
    dom instanceof HTMLElement
      ? dom
      : new DOMRect(at.left, at.top, 0, at.bottom - at.top);

  void askMath({
    title: source ? "Edit equation" : "Equation",
    confirmLabel: source ? "Save" : "Add equation",
    source,
    display: block || Boolean(node.attrs.display),
    anchor,
  }).then((answer) => {
    const current = editor.state.doc.nodeAt(pos);
    if (!isMath(current)) return;
    const { tr } = editor.state;
    if (answer === null) {
      // Dismissed: the equation stays selected, so Enter reopens it and Backspace removes it.
      if (!source) {
        tr.delete(pos, pos + current.nodeSize);
        tr.setSelection(Selection.near(tr.doc.resolve(pos)));
        editor.view.dispatch(tr);
      }
    } else {
      if (answer !== current.attrs.source) {
        tr.setNodeMarkup(pos, undefined, { ...current.attrs, source: answer });
      }
      leaveAfter(tr, pos + current.nodeSize, block);
      editor.view.dispatch(tr);
    }
    editor.view.focus();
  });
}

/** The caret after the equation: into what follows, or a new paragraph when nothing does. */
function leaveAfter(tr: Transaction, after: number, block: boolean): void {
  if (!block) {
    tr.setSelection(TextSelection.create(tr.doc, after));
    return;
  }
  if (!tr.doc.nodeAt(after)) {
    const paragraph = tr.doc.type.schema.nodes.paragraph.create();
    tr.insert(after, paragraph);
  }
  tr.setSelection(Selection.near(tr.doc.resolve(after), 1));
}

/** Clicks reach the dialog; a second one within half a second is a double click to ProseMirror. */
function clickPlugin(editor: Editor, name: string): Plugin {
  const open = (view: EditorView, node: PMNode, nodePos: number, event: MouseEvent) => {
    if (node.type.name !== name || event.button !== 0 || !editor.isEditable) return false;
    view.dispatch(
      view.state.tr.setSelection(NodeSelection.create(view.state.doc, nodePos)),
    );
    editMath(editor, nodePos);
    return true;
  };
  return new Plugin({
    key: new PluginKey(`${name}Click`),
    props: {
      handleClickOn: (view, _pos, node, nodePos, event) =>
        open(view, node, nodePos, event),
      handleDoubleClickOn: (view, _pos, node, nodePos, event) =>
        open(view, node, nodePos, event),
      handleTripleClickOn: (view, _pos, node, nodePos, event) =>
        open(view, node, nodePos, event),
    },
  });
}

/** Enter on a selected equation opens it, as a click does. */
function enterOpens(editor: Editor, name: string): () => boolean {
  return () => {
    const { selection } = editor.state;
    if (!(selection instanceof NodeSelection) || selection.node.type.name !== name) {
      return false;
    }
    editMath(editor, selection.from);
    return true;
  };
}

function sourceAttribute(read: (el: HTMLElement) => string) {
  return {
    source: {
      default: "",
      parseHTML: read,
      renderHTML: () => ({}),
    },
  };
}

/** Draws into `el` whenever the equation's source changes; the drawing is cached by source. */
function painter(el: HTMLElement, display: (node: PMNode) => boolean) {
  let painted: string | null = null;
  return (current: PMNode) => {
    const source = String(current.attrs.source);
    const key = (display(current) ? "D" : "I") + source;
    if (key === painted) return;
    painted = key;
    renderMath(el, source, display(current));
  };
}

/** `$x$` in running text, drawn by KaTeX. */
export const MathInline = Node.create({
  name: INLINE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      ...sourceAttribute((el) => el.getAttribute("data-math") ?? ""),
      display: {
        default: false,
        parseHTML: (el) => el.hasAttribute("data-display"),
        renderHTML: (attrs) => (attrs.display ? { "data-display": "" } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-math]", priority: 60 }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      { ...HTMLAttributes, "data-math": node.attrs.source, class: "math-inline" },
      inlineText(node),
    ];
  },

  renderText: ({ node }) => inlineText(node),

  extendNodeSchema() {
    return { leafText: inlineText };
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("span");
      dom.className = "math-inline";
      const paint = painter(dom, (current) => Boolean(current.attrs.display));
      const sync = (current: PMNode) => {
        dom.classList.toggle("math-display", Boolean(current.attrs.display));
        paint(current);
      };
      sync(node);
      return {
        dom,
        update: (updated) => {
          if (updated.type.name !== INLINE) return false;
          sync(updated);
          return true;
        },
        destroy: () => cancelMath(dom),
      };
    };
  },

  addCommands() {
    return {
      insertMathInline:
        (source = "") =>
        ({ tr, dispatch }) => {
          const node = this.type.create({ source });
          tr.replaceSelectionWith(node);
          if (dispatch) {
            const pos = tr.selection.from - node.nodeSize;
            if (tr.doc.nodeAt(pos)?.type === this.type) {
              tr.setSelection(NodeSelection.create(tr.doc, pos));
            }
          }
          return true;
        },
    };
  },

  addInputRules() {
    // `$$x$$` first, or the single form would take the inner dollars.
    const rule = (find: RegExp, display: boolean) =>
      new InputRule({
        find,
        handler: ({ state, range, match }) => {
          const from = range.from + match[1].length;
          state.tr.replaceWith(
            from,
            range.to,
            this.type.create({ source: match[2], display }),
          );
        },
      });
    return [
      rule(/(^|[^$\\])\$\$([^\s$](?:[^$\n]*?[^\s$])?)\$\$$/, true),
      rule(/(^|[^$\\])\$([^\s$](?:[^$\n]*?[^\s$])?)\$$/, false),
    ];
  },

  addKeyboardShortcuts() {
    return { Enter: enterOpens(this.editor, INLINE) };
  },

  addProseMirrorPlugins() {
    return [clickPlugin(this.editor, INLINE)];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: State, node: PMNode) {
          state.text(inlineText(node), false);
        },
        parse: {},
      },
    };
  },
});

/** `$$` on lines of its own: a block that is the drawing, edited in the dialog. */
export const MathBlock = Node.create({
  name: BLOCK,
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      ...sourceAttribute((el) => el.textContent ?? ""),
      // `single` for a file that wrote `$$x$$` on one line.
      form: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-md"),
        renderHTML: (attrs) => (attrs.form ? { "data-md": attrs.form } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-math-block]", priority: 60 }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      { ...HTMLAttributes, "data-math-block": "", class: "math-block" },
      String(node.attrs.source),
    ];
  },

  renderText: ({ node }) => `$$\n${node.attrs.source}\n$$`,

  extendNodeSchema() {
    return { leafText: (node: PMNode) => `$$\n${node.attrs.source}\n$$` };
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.className = "math-block";
      const preview = document.createElement("div");
      preview.className = "math-preview";
      dom.append(preview);
      const paint = painter(preview, () => true);
      const sync = (current: PMNode) => {
        dom.classList.toggle("empty", String(current.attrs.source).trim() === "");
        paint(current);
      };
      sync(node);
      return {
        dom,
        update: (updated) => {
          if (updated.type.name !== BLOCK) return false;
          sync(updated);
          return true;
        },
        destroy: () => cancelMath(preview),
      };
    };
  },

  addCommands() {
    return {
      insertMathBlock:
        (source = "") =>
        ({ tr, dispatch, state }) => {
          const { $from } = state.selection;
          const node = this.type.create({ source });
          // In place of an empty paragraph; after any other block.
          const parent = $from.parent;
          const replace =
            parent.isTextblock && parent.content.size === 0 && $from.depth > 0;
          const from = replace
            ? $from.before()
            : $from.depth > 0
              ? $from.after()
              : $from.pos;
          const to = replace ? $from.after() : from;
          tr.replaceWith(from, to, node);
          if (dispatch) tr.setSelection(NodeSelection.create(tr.doc, from));
          return true;
        },
    };
  },

  addInputRules() {
    const { editor } = this;
    return [
      new InputRule({
        find: /^\$\$\s$/,
        handler: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.depth === 0) return null;
          const from = $from.before();
          state.tr.replaceWith(from, $from.after(), this.type.create());
          state.tr.setSelection(NodeSelection.create(state.tr.doc, from));
          // Once the rule's own transaction is in.
          queueMicrotask(() => editMath(editor, from));
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    return { Enter: enterOpens(this.editor, BLOCK) };
  },

  addProseMirrorPlugins() {
    return [clickPlugin(this.editor, BLOCK)];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: State, node: PMNode) {
          const source = String(node.attrs.source);
          if (node.attrs.form === "single" && source.trim() && !source.includes("\n")) {
            state.write(`$$${source}$$`);
          } else {
            writeLines(state, `$$\n${source}\n$$`);
          }
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

export const mathExtensions = [MathBlock, MathInline];
