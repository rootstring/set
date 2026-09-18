import { Extension, type Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { setSyntax } from "./syntax";
import { SetMarkdownState, type SerializeContext } from "./state";
import {
  markOverrides,
  nodeOverrides,
  type MarkSerializer,
  type NodeSerializer,
} from "./serialize";
import type { MarkdownIt } from "./types";

interface MarkdownStorage {
  parser: { md: MarkdownIt };
  serializer: {
    serialize(content: PMNode): string;
    readonly nodes: Record<string, NodeSerializer>;
    readonly marks: Record<string, MarkSerializer>;
  };
}

/** An attribute read from `data-md` (or the `<code>` inside a `<pre>`). */
function recorded(name: string, attribute: string) {
  return {
    [name]: {
      default: null,
      parseHTML: (el: HTMLElement) =>
        el.getAttribute(attribute) ??
        (el.tagName === "PRE" ? el.firstElementChild?.getAttribute(attribute) : null) ??
        null,
      renderHTML: (attrs: Record<string, unknown>) =>
        attrs[name] ? { [attribute]: String(attrs[name]) } : {},
    },
  };
}

/**
 * Keeps a note's Markdown as written. Parsing: `syntax.ts`; writing: `serialize.ts` via `state.ts`.
 * Priority below tiptap-markdown (50) so its serializer exists first.
 */
export const MarkdownFidelity = Extension.create({
  name: "markdownFidelity",
  priority: 40,

  addGlobalAttributes() {
    return [
      {
        types: [
          "heading",
          "codeBlock",
          "bulletList",
          "orderedList",
          "taskList",
          "horizontalRule",
          "hardBreak",
          "bold",
          "italic",
          "strike",
          "code",
          "highlight",
        ],
        attributes: recorded("markup", "data-md"),
      },
      { types: ["codeBlock"], attributes: recorded("info", "data-md-info") },
      { types: ["orderedList"], attributes: recorded("numbering", "data-md-numbering") },
      {
        types: ["link"],
        attributes: {
          ...recorded("markup", "data-md"),
          ...recorded("refForm", "data-md-ref"),
          ...recorded("refLabel", "data-md-label"),
          ...recorded("refHref", "data-md-href"),
        },
      },
      {
        // tiptap-markdown gives `tight` to bullet and ordered lists but not task lists.
        types: ["taskList"],
        attributes: {
          tight: {
            default: true,
            parseHTML: (el: HTMLElement) =>
              el.getAttribute("data-tight") === "true" || !el.querySelector("p"),
            renderHTML: (attrs: Record<string, unknown>) =>
              attrs.tight ? { class: "tight", "data-tight": "true" } : {},
          },
        },
      },
    ];
  },

  addStorage() {
    return {
      markdown: {
        parse: {
          setup(md: MarkdownIt) {
            setSyntax(md);
          },
        },
      },
    };
  },

  onBeforeCreate() {
    patchSerializer(this.editor);
  },
});

function patchSerializer(editor: Editor): void {
  const storage = (editor.storage as unknown as { markdown?: MarkdownStorage }).markdown;
  if (!storage?.serializer) {
    throw new Error(
      "MarkdownFidelity has to load after tiptap-markdown's Markdown extension.",
    );
  }
  const { serializer } = storage;
  serializer.serialize = (content: PMNode) => {
    const nodes = serializer.nodes;
    const marks = serializer.marks;
    const state = new SetMarkdownState(
      { ...nodes, ...nodeOverrides(nodes) } as never,
      { ...marks, ...markOverrides(marks) } as never,
      { hardBreakNodeName: "hardBreak" },
      contextFor(content, storage.parser.md),
    );
    state.renderContent(content);
    return state.out;
  };
}

function contextFor(doc: PMNode, md: MarkdownIt): SerializeContext {
  const referenceLabels = new Set<string>();
  const footnoteLabels = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === "rawBlock" && node.attrs.kind === "definition") {
      for (const line of node.textContent.split("\n")) {
        const label = /^\s{0,3}\[([^\]]+)\]:/.exec(line)?.[1];
        if (label) referenceLabels.add(md.utils.normalizeReference(label));
      }
    } else if (node.type.name === "footnoteDefinition") {
      footnoteLabels.add(String(node.attrs.label));
    }
    return !node.isTextblock;
  });
  return { md, referenceLabels, footnoteLabels };
}
