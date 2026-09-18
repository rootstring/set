import type { Editor } from "@tiptap/core";
import { pickPage } from "$lib/state/page-picker.svelte";

export const WIKI_LINK_NODE = "wikiLink";

/**
 * A wikilink names its page by title, so untitled pages are hidden. Scoped "anywhere": a link may
 * point out of the context.
 */
export async function askForPage(
  resolveTitle: ((id: string) => string | undefined) | undefined,
  opts: { title: string; emptyTitle: string; anchor: HTMLElement | DOMRect | null },
): Promise<string | null> {
  const id = await pickPage({
    title: opts.title,
    anchor: opts.anchor,
    emptyTitle: opts.emptyTitle,
    scope: "anywhere",
    titledOnly: true,
  });
  if (!id) return null;
  const title = resolveTitle?.(id)?.trim();
  return title ? title : null;
}

/** Put a link to `title` at the caret, replacing whatever is selected. */
export function insertWikiLink(editor: Editor, title: string): void {
  editor
    .chain()
    .focus()
    .insertContent({ type: WIKI_LINK_NODE, attrs: { target: title, alias: null } })
    .run();
}
