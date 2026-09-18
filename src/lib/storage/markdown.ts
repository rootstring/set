import { Editor } from "@tiptap/core";
import type { Content } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { createExtensions } from "$lib/editor/extensions";
import { emptyDoc, type PageDoc } from "$lib/types";

let converter: Editor | undefined;

function getConverter(): Editor {
  if (typeof window === "undefined") {
    throw new Error("Markdown conversion is only available in the browser.");
  }
  if (!converter) {
    converter = new Editor({ extensions: createExtensions({ interactive: false }) });
  }
  return converter;
}

interface MarkdownStorage {
  markdown: {
    getMarkdown(): string;
    serializer: { serialize(node: ProseMirrorNode): string };
  };
}

export function docToMarkdown(doc: PageDoc): string {
  const editor = getConverter();
  editor.commands.setContent(doc as Content, { emitUpdate: false });
  return (editor.storage as unknown as MarkdownStorage).markdown.getMarkdown();
}

export function markdownToDoc(markdown: string): PageDoc {
  if (!markdown.trim()) return emptyDoc();
  const editor = getConverter();

  editor.commands.setContent(markdown, { emitUpdate: false });
  return editor.getJSON() as PageDoc;
}

export function editorToMarkdown(editor: Editor): string {
  const { serializer } = (editor.storage as unknown as MarkdownStorage).markdown;
  return serializer.serialize(editor.state.doc);
}
