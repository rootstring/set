import { CodeBlock } from "@tiptap/extension-code-block";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";

interface MarkdownState {
  write(text: string): void;
  text(text: string, escape?: boolean): void;
  ensureNewLine(): void;
  closeBlock(node: unknown): void;
}

interface CodeBlockNode {
  /** `markup` and `info` are what the file wrote, when it wasn't Set's own form. */
  attrs: { language?: string | null; markup?: string | null; info?: string | null };
  textContent: string;
}

/** No shorter than the file's own fence, in the character it used. */
function fenceFor(text: string, markup?: string | null): string {
  const char = markup?.[0] === "~" ? "~" : "`";
  const runs = text.match(char === "~" ? /~+/g : /`+/g);
  const longest = runs ? Math.max(...runs.map((run) => run.length)) : 0;
  const recorded = markup?.[0] === char ? markup.length : 0;
  return char.repeat(Math.max(3, longest + 1, recorded));
}

function codeBlockMarkdownStorage(parent: Record<string, unknown> | undefined) {
  return {
    ...parent,
    markdown: {
      serialize(state: MarkdownState, node: CodeBlockNode) {
        const { language, markup, info } = node.attrs;
        if (markup === "indented" && !language) {
          // Written as it was: four spaces in, no fence.
          node.textContent.split("\n").forEach((line, i) => {
            if (i) state.ensureNewLine();
            state.write(line ? `    ${line}` : "");
          });
          state.closeBlock(node);
          return;
        }
        const fence = fenceFor(node.textContent, markup);
        // The whole info string (`js title="x"`), while it still names the
        // block's language.
        const infoString =
          info && language && info.split(/\s+/)[0] === language ? info : language || "";
        state.write(fence + infoString + "\n");
        state.text(node.textContent, false);
        state.ensureNewLine();
        state.write(fence);
        state.closeBlock(node);
      },
    },
  };
}

export const CodeBlockMarkdown = CodeBlock.extend({
  addStorage() {
    return codeBlockMarkdownStorage(this.parent?.());
  },
});

export const CodeBlockHighlight = CodeBlockLowlight.extend({
  addStorage() {
    return codeBlockMarkdownStorage(this.parent?.());
  },
});
