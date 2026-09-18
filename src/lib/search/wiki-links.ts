import type { PageId } from "$lib/types";

/** Structurally `IndexedBody`, so the same cache serves both. */
export interface ScannableBody {
  id: PageId;
  body: string;
}

/**
 * Read off raw Markdown, which the index already holds. Must agree with `markdown/syntax-extras.ts`
 * and `Workspace.pageIdByTitle`. Mirrored by `wiki_link_titles` in src-tauri/src/index.rs.
 */
export function wikiLinkTitles(body: string): string[] {
  const found: string[] = [];
  let fence: string | null = null;

  for (const line of body.split("\n")) {
    const marker = fenceMarker(line);
    if (fence !== null) {
      // A fence closes on its own character, and on at least as long a run.
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    scanLine(line, found);
  }
  return found;
}

/** The ids of pages whose body links to `title`, in no particular order. */
export function backlinkIds(bodies: Iterable<ScannableBody>, title: string): PageId[] {
  const wanted = title.trim().toLowerCase();
  if (!wanted) return [];

  const ids: PageId[] = [];
  for (const doc of bodies) {
    // Cheap reject first: no `[[` at all is the common case by far.
    if (!doc.body.includes("[[")) continue;
    if (wikiLinkTitles(doc.body).some((t) => t.toLowerCase() === wanted)) {
      ids.push(doc.id);
    }
  }
  return ids;
}

/** The ``` or ~~~ run opening or closing a fence, with up to three spaces in front. */
function fenceMarker(line: string): string | null {
  let at = 0;
  while (at < line.length && line[at] === " ") at++;
  if (at > 3) return null;
  const ch = line[at];
  if (ch !== "`" && ch !== "~") return null;
  let end = at;
  while (end < line.length && line[end] === ch) end++;
  return end - at >= 3 ? line.slice(at, end) : null;
}

function scanLine(line: string, found: string[]): void {
  let at = 0;
  while (at < line.length) {
    if (line[at] === "`") {
      let end = at;
      while (end < line.length && line[end] === "`") end++;
      const run = line.slice(at, end);
      const close = line.indexOf(run, end);
      // Unclosed backticks are literal text, so only the run itself is skipped.
      at = close === -1 ? end : close + run.length;
      continue;
    }
    if (line[at] !== "[" || line[at + 1] !== "[") {
      at++;
      continue;
    }
    const end = line.indexOf("]]", at + 2);
    if (end === -1) break;
    const inner = line.slice(at + 2, end);
    if (inner.includes("[") || inner.includes("]")) {
      at++; // not a link; markdown-it would try again one character along
      continue;
    }
    const title = linkTitle(inner);
    if (title) found.push(title);
    at = end + 2;
  }
}

/** `Page|shown as` and `Page#Heading` both name the page `Page`. */
function linkTitle(inner: string): string {
  return inner.split("|")[0].split("#")[0].trim();
}
