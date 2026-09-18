import { Node, mergeAttributes, InputRule, type JSONContent } from "@tiptap/core";
import { Selection, TextSelection } from "@tiptap/pm/state";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    details: {
      setDetails: () => ReturnType;
      unsetDetails: () => ReturnType;
    };
  }
}

const CARET_SVG =
  '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" ' +
  'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M6 4l4 4-4 4"/></svg>';

export const DetailsSummary = Node.create({
  name: "detailsSummary",
  content: "inline*",
  defining: true,
  selectable: false,
  isolating: true,
  parseHTML() {
    return [{ tag: "summary" }, { tag: "div[data-details-summary]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-details-summary": "",
        class: "details-summary",
      }),
      0,
    ];
  },
  addStorage() {
    return {
      markdown: {
        serialize(
          state: { renderInline(node: unknown): void; closeBlock(node: unknown): void },
          node: unknown,
        ) {
          state.renderInline(node);
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

export const Details = Node.create({
  name: "details",
  group: "block",
  content: "detailsSummary block+",
  defining: true,
  isolating: true,
  priority: 1000,
  addAttributes() {
    return {
      open: {
        default: true,
        parseHTML: (el) => el.hasAttribute("open"),
        renderHTML: (attrs) => (attrs.open ? { open: "" } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "details" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["details", mergeAttributes(HTMLAttributes), 0];
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement("div");
      dom.className = "details";
      dom.setAttribute("data-open", String(node.attrs.open));

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "details-toggle";
      toggle.contentEditable = "false";
      toggle.innerHTML = CARET_SVG;
      toggle.setAttribute("aria-label", "Toggle");

      toggle.addEventListener("mousedown", (e) => e.preventDefault());
      toggle.addEventListener("click", (e) => {
        e.preventDefault();
        if (typeof getPos !== "function") return;
        const pos = getPos();
        if (pos == null) return;
        const current = editor.view.state.doc.nodeAt(pos);
        if (!current) return;
        editor.view.dispatch(
          editor.view.state.tr.setNodeMarkup(pos, undefined, {
            ...current.attrs,
            open: !current.attrs.open,
          }),
        );
      });

      const inner = document.createElement("div");
      inner.className = "details-inner";

      dom.append(toggle, inner);

      return {
        dom,
        contentDOM: inner,
        update: (updated) => {
          if (updated.type.name !== this.name) return false;
          dom.setAttribute("data-open", String(updated.attrs.open));
          return true;
        },
        ignoreMutation: (mutation) => {
          if (mutation.type === "selection") return false;
          return !inner.contains(mutation.target);
        },
      };
    };
  },
  addCommands() {
    return {
      setDetails:
        () =>
        ({ state, chain }) => {
          const { $from } = state.selection;
          const block = $from.parent;
          if (!block.isTextblock || block.type.name === "detailsSummary") return false;
          // In a table cell the replace would split the table.
          const holder = $from.node($from.depth - 1);
          const index = $from.index($from.depth - 1);
          if (!holder.canReplaceWith(index, index + 1, this.type)) return false;

          // The block being replaced becomes the summary, so its text is kept.
          const summary = block.toJSON() as JSONContent;
          const from = $from.before($from.depth);
          const to = $from.after($from.depth);
          const caret = from + 2 + $from.parentOffset;
          return chain()
            .insertContentAt(
              { from, to },
              {
                type: this.name,
                attrs: { open: true },
                content: [
                  {
                    type: "detailsSummary",
                    ...(summary.content ? { content: summary.content } : {}),
                  },
                  { type: "paragraph" },
                ],
              },
            )
            .command(({ tr, dispatch }) => {
              if (dispatch) tr.setSelection(TextSelection.near(tr.doc.resolve(caret)));
              return true;
            })
            .run();
        },
      unsetDetails:
        () =>
        ({ state, chain }) => {
          const { $from } = state.selection;
          for (let depth = $from.depth; depth > 0; depth--) {
            if ($from.node(depth).type.name !== this.name) continue;
            const details = $from.node(depth);
            const from = $from.before(depth);
            const to = $from.after(depth);
            const summary = details.child(0);
            const summaryJSON = summary.toJSON() as { content?: unknown[] };
            const replacement: unknown[] = [
              {
                type: "paragraph",
                ...(summaryJSON.content ? { content: summaryJSON.content } : {}),
              },
            ];
            for (let i = 1; i < details.childCount; i++) {
              replacement.push(details.child(i).toJSON());
            }
            return chain()
              .insertContentAt({ from, to }, replacement as never)
              .run();
          }
          return false;
        },
    };
  },
  addInputRules() {
    return [
      new InputRule({
        find: /^\s*>\s$/,
        handler: ({ chain, can, range, state }) => {
          const $from = state.doc.resolve(range.from);

          const parent = $from.parent.type.name;
          if (parent !== "paragraph" && parent !== "heading") return null;
          // Asked before anything is deleted, so the `>` stays where no toggle can go.
          if (!can().setDetails()) return null;
          chain().deleteRange(range).setDetails().run();
        },
      }),
    ];
  },
  addKeyboardShortcuts() {
    const exitAfter = (afterPos: number) =>
      this.editor
        .chain()
        .focus()
        .insertContentAt(afterPos, { type: "paragraph" })
        .setTextSelection(afterPos + 1)
        .run();

    return {
      Enter: () => {
        const { $from, empty } = this.editor.state.selection;
        if (!empty || $from.parent.type.name !== "detailsSummary") return false;
        const detailsDepth = $from.depth - 1;
        const details = $from.node(detailsDepth);
        if (details?.type.name !== this.name) return false;

        const trailing = $from.parent.content.cut($from.parentOffset);
        if (trailing.size === 0) {
          if (details.attrs.open) {
            const bodyStart = $from.after($from.depth) + 1;
            return this.editor.chain().focus().setTextSelection(bodyStart).run();
          }
          return exitAfter($from.after(detailsDepth));
        }

        const summaryEnd = $from.end($from.depth);
        const paragraph = this.editor.schema.nodes.paragraph;
        return this.editor.commands.command(({ tr, dispatch }) => {
          if (!dispatch) return true;
          const anchor = details.attrs.open
            ? $from.after($from.depth) // body-top boundary, right after the summary
            : $from.after(detailsDepth); // just after the whole toggle
          const dest = anchor - (summaryEnd - $from.pos); // shifts left as we cut
          tr.delete($from.pos, summaryEnd);
          tr.insert(dest, paragraph.create(null, trailing));
          tr.setSelection(TextSelection.near(tr.doc.resolve(dest + 1)));
          return true;
        });
      },
      "Shift-Tab": () => {
        const { $from, empty } = this.editor.state.selection;
        const detailsDepth = $from.depth - 1;
        if ($from.node(detailsDepth)?.type.name !== this.name) return false;
        if ($from.parent.type.name === "detailsSummary") return false;

        const afterToggle = $from.after(detailsDepth);
        const trailing = empty ? $from.parent.content.cut($from.parentOffset) : null;

        if (!trailing || trailing.size === 0) return exitAfter(afterToggle);

        const blockEnd = $from.end($from.depth);
        const paragraph = this.editor.schema.nodes.paragraph;
        return this.editor.commands.command(({ tr, dispatch }) => {
          if (!dispatch) return true;
          const dest = afterToggle - (blockEnd - $from.pos); // shifts left as we cut
          tr.delete($from.pos, blockEnd);
          tr.insert(dest, paragraph.create(null, trailing));
          tr.setSelection(TextSelection.near(tr.doc.resolve(dest + 1)));
          return true;
        });
      },
      Backspace: () => {
        const { doc, selection } = this.editor.state;
        const { $from, empty } = selection;
        if (!empty || $from.parentOffset !== 0) return false;

        if ($from.parent.type.name === "detailsSummary") {
          return this.editor.commands.unsetDetails();
        }
        if (!$from.parent.isTextblock) return false;

        const cut = $from.before($from.depth);
        const nodeBefore = doc.resolve(cut).nodeBefore;

        const detailsDepth = $from.depth - 1;
        const outer = $from.node(detailsDepth);
        if (outer?.type.name === this.name && $from.index(detailsDepth) === 1) {
          return this.editor.commands.command(({ tr, dispatch }) => {
            if (!dispatch) return true;
            if (outer.childCount > 2) {
              tr.join(cut);
              tr.setSelection(TextSelection.create(tr.doc, cut - 1));
            } else {
              const body = $from.parent;
              const summaryEnd = cut - 1;
              tr.delete(cut + 1, cut + 1 + body.content.size);
              tr.insert(summaryEnd, body.content);
              tr.setSelection(TextSelection.create(tr.doc, summaryEnd));
            }
            return true;
          });
        }

        if (nodeBefore?.type.name === this.name) {
          const details = nodeBefore;
          return this.editor.commands.command(({ tr, dispatch }) => {
            if (!dispatch) return true;
            const detailsStart = cut - details.nodeSize;

            const target = Selection.findFrom(doc.resolve(cut - 1), -1, true);
            const following = doc.resolve(cut).nodeAfter;
            if (!target || target.to <= detailsStart || !following) return false;
            const insertPos = target.to;
            tr.delete(cut, cut + following.nodeSize);
            tr.insert(insertPos, following.content);
            if (!details.attrs.open) {
              tr.setNodeMarkup(detailsStart, undefined, { ...details.attrs, open: true });
            }
            tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos), -1));
            return true;
          });
        }

        return false;
      },
    };
  },
  addStorage() {
    return {
      markdown: {
        serialize(
          state: {
            write(s: string): void;
            renderInline(node: unknown): void;
            render(node: unknown, parent: unknown, index: number): void;
            closeBlock(node: unknown): void;
          },
          node: {
            attrs: { open: boolean };
            child(i: number): unknown;
            childCount: number;
          },
        ) {
          state.write(`<details${node.attrs.open ? " open" : ""}>\n`);
          state.write("<summary>");
          state.renderInline(node.child(0));
          state.write("</summary>\n\n");
          for (let i = 1; i < node.childCount; i++) {
            state.render(node.child(i), node, i);
          }
          state.write("\n</details>");
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

export const detailsExtensions = [Details, DetailsSummary];
