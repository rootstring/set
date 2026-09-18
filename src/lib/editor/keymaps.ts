import { Extension, type Editor } from "@tiptap/core";
import { Selection } from "@tiptap/pm/state";

const CODE_INDENT = "  ";

function inCodeBlock(editor: Editor): boolean {
  return editor.state.selection.$from.parent.type.name === "codeBlock";
}

function indentCode(editor: Editor, outdent: boolean): boolean {
  const { selection } = editor.state;
  const { $from, from, to, empty } = selection;
  const blockStart = $from.start();
  const text = $from.parent.textContent;

  if (empty && !outdent) {
    return editor.commands.command(({ tr, dispatch }) => {
      if (dispatch) tr.insertText(CODE_INDENT, from);
      return true;
    });
  }

  const selFrom = from - blockStart;
  const selTo = to - blockStart;
  const lineStarts = [text.lastIndexOf("\n", Math.max(0, selFrom - 1)) + 1];
  for (let i = lineStarts[0]; i < selTo; i++) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }

  return editor.commands.command(({ tr, dispatch }) => {
    if (!dispatch) return true;

    for (let k = lineStarts.length - 1; k >= 0; k--) {
      const offset = lineStarts[k];
      const pos = blockStart + offset;
      if (!outdent) {
        tr.insertText(CODE_INDENT, pos);
        continue;
      }
      let remove = 0;
      while (remove < CODE_INDENT.length && text[offset + remove] === " ") remove++;
      if (remove === 0 && text[offset] === "\t") remove = 1; // tolerate a hard tab
      if (remove > 0) tr.delete(pos, pos + remove);
    }
    return true;
  });
}

export const EditorTab = Extension.create({
  name: "editorTab",
  priority: 50,
  addKeyboardShortcuts() {
    return {
      Tab: () => (inCodeBlock(this.editor) ? indentCode(this.editor, false) : true),
      "Shift-Tab": () =>
        inCodeBlock(this.editor) ? indentCode(this.editor, true) : true,
    };
  },
});

export const LeadingBackspace = Extension.create({
  name: "leadingBackspace",
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      Backspace: () => {
        const { state } = this.editor;
        const { $from, empty } = state.selection;

        if (!empty || $from.parentOffset !== 0) return false;
        if (!$from.parent.isTextblock || $from.parent.content.size !== 0) return false;

        if ($from.depth !== 1 || $from.index(0) !== 0) return false;

        if (state.doc.childCount < 2) return false;

        const from = $from.before(1);
        const to = $from.after(1);
        return this.editor.commands.command(({ tr, dispatch }) => {
          if (!dispatch) return true;
          tr.delete(from, to);

          tr.setSelection(Selection.near(tr.doc.resolve(from), 1));
          return true;
        });
      },
    };
  },
});
