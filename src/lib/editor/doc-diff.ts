import type { Node as ProseMirrorNode, Slice } from "@tiptap/pm/model";

/**
 * Replacing the whole document on sync jumps the caret and scroll to the top; a minimal replacement
 * lets ProseMirror map the selection through.
 */
export interface DocPatch {
  from: number;
  to: number;
  slice: Slice;
}

/**
 * A change from outside (sync, outside edit). Not reported as an edit, or it would be saved
 * straight back; not in undo history.
 */
export const EXTERNAL_EDIT = "externalEdit";

/** `null` when already the same. */
export function docPatch(
  current: ProseMirrorNode,
  next: ProseMirrorNode,
): DocPatch | null {
  const from = current.content.findDiffStart(next.content);
  if (from == null) return null;

  const ends = current.content.findDiffEnd(next.content);
  if (!ends) return null;

  let { a: to, b: end } = ends;

  // When the same text sits on both sides of the change the two scans cross over; push both ends
  // out by the overlap.
  const overlap = from - Math.min(to, end);
  if (overlap > 0) {
    to += overlap;
    end += overlap;
  }

  return { from, to, slice: next.slice(from, end) };
}
