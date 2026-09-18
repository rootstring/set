/** As `src-tauri/src/sync/preview.rs` sends it. */

export type SyncVerb = "add" | "update" | "move" | "trash" | "remove";

export type SyncNote =
  "merged" | "conflict" | "copy" | "too_big" | "unreadable" | "changing";

export interface SyncAction {
  verb: SyncVerb;
  /** Where a moved file is now. */
  from: string | null;
}

export interface SyncChange {
  /** Where it is afterwards, or for something going to the Trash, where it is now. */
  path: string;
  /** A context rather than a file. */
  dir: boolean;
  here: SyncAction | null;
  there: SyncAction | null;
  note: SyncNote | null;
  diffable: boolean;
}

export interface SyncPreview {
  changes: SyncChange[];
  unchanged: string[];
  contexts: string[];
  /** What each note is called, by path. One that isn't here goes by its file name. */
  titles: Record<string, string>;
  /** Set when the sync trashes more than anyone is likely to have meant. */
  massTrash: { here: number; there: number } | null;
}

export interface SyncDiff {
  side: "here" | "there";
  lines: { kind: "same" | "add" | "del" | "gap"; text: string }[];
  truncated: boolean;
}

export interface TreeNode {
  /** Unique among its siblings. */
  key: string;
  /** A page's title; for anything else, its name on disk. */
  name: string;
  /** A page or a context has an icon of its own; the rest are plain files. */
  kind: "context" | "page" | "folder" | "file";
  change: SyncChange | null;
  children: TreeNode[];
  /** How many changes sit at or under this node, which is what opens it. */
  changed: number;
}

const ASSETS_DIR = "Set-page-assets";

const isNote = (name: string) => /\.md$/i.test(name);

/** Whether the change takes the file away from where it is listed. */
const leaves = (change: SyncChange) =>
  [change.here, change.there].some((a) => a?.verb === "trash" || a?.verb === "remove");

/** What the note at `path` is called: its title, or failing that its file name. */
export function pageName(preview: SyncPreview, path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  return preview.titles[path] ?? file;
}

/**
 * What is leaving is still shown where it leaves from. A page's file and its folder are one node.
 */
export function buildTree(preview: SyncPreview): TreeNode[] {
  const root: TreeNode = node("", "", "folder");

  const place = (path: string, change: SyncChange | null, dir = change?.dir ?? false) => {
    const parts = path.split("/").filter(Boolean);
    let at = root;
    parts.forEach((part, depth) => {
      const last = depth === parts.length - 1;
      const file = last && !dir;
      const page = file && isNote(part);
      const name = page ? part.replace(/\.md$/i, "") : part;
      // Something leaving gets its own key, so a page made under a trashed one's name does not take
      // its line.
      const gone = last && change !== null && leaves(change);
      const key = `${file && !page ? "file:" : ""}${name}${gone ? ":gone" : ""}`;

      let next = at.children.find((child) => child.key === key);
      if (!next) {
        const kind = depth === 0 && !file ? "context" : file && !page ? "file" : "folder";
        next = node(key, name, kind);
        at.children.push(next);
      }
      if (page) {
        next.kind = "page";
        // The key stays the file name, which ties a page to its subpage folder.
        next.name = pageName(preview, path);
      }
      if (last) next.change = change;
      at = next;
    });
  };

  for (const context of preview.contexts) place(context, null, true);
  for (const path of preview.unchanged) place(path, null);
  for (const change of preview.changes) place(change.path, change);

  const finish = (n: TreeNode): number => {
    n.children.sort(
      (a, b) =>
        Number(a.name === ASSETS_DIR) - Number(b.name === ASSETS_DIR) ||
        a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
    n.changed = (n.change ? 1 : 0) + n.children.reduce((sum, c) => sum + finish(c), 0);
    // Sorted under its real name first, so it stays last among the subpages.
    if (n.name === ASSETS_DIR) n.name = "Attachments";
    return n.changed;
  };
  finish(root);
  return root.children;
}

function node(key: string, name: string, kind: TreeNode["kind"]): TreeNode {
  return { key, name, kind, change: null, children: [], changed: 0 };
}

export interface SideCounts {
  added: number;
  updated: number;
  moved: number;
  trashed: number;
}

export interface Summary {
  here: SideCounts;
  there: SideCounts;
  merged: number;
  conflicts: number;
  /** Files the sync leaves where they are, because it can't carry them yet. */
  leftOut: number;
}

export function summarize(preview: SyncPreview): Summary {
  const none = (): SideCounts => ({ added: 0, updated: 0, moved: 0, trashed: 0 });
  const out: Summary = {
    here: none(),
    there: none(),
    merged: 0,
    conflicts: 0,
    leftOut: 0,
  };

  const count = (side: SideCounts, action: SyncAction | null) => {
    if (!action) return;
    if (action.verb === "add") side.added++;
    else if (action.verb === "update") side.updated++;
    else if (action.verb === "move") side.moved++;
    else side.trashed++;
  };

  for (const change of preview.changes) {
    count(out.here, change.here);
    count(out.there, change.there);
    if (change.note === "merged") out.merged++;
    else if (change.note === "conflict") out.conflicts++;
    else if (change.note && change.note !== "copy") out.leftOut++;
  }
  return out;
}

/** "3 new, 1 updated, 2 to the Trash", or "" for a device nothing changes on. */
export function countsLabel(counts: SideCounts): string {
  return [
    counts.added > 0 ? `${counts.added} new` : "",
    counts.updated > 0 ? `${counts.updated} updated` : "",
    counts.moved > 0 ? `${counts.moved} moved` : "",
    counts.trashed > 0 ? `${counts.trashed} to the Trash` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

const VERBS: Record<SyncVerb, string> = {
  add: "New",
  update: "Updated",
  move: "Moved",
  trash: "To the Trash",
  remove: "Removed",
};

const NOTES: Record<SyncNote, string> = {
  merged: "Edits from both merged",
  conflict: "Edited on both, newer kept",
  copy: "The other version, kept as a copy",
  too_big: "Too large to sync, stays where it is",
  unreadable: "Couldn't be read, left alone",
  changing: "Still changing, waits for the next sync",
};

/** What happens to one file, in a few words: "Updated here", "New on MacBook". */
export function changeLabel(change: SyncChange, peerName: string): string {
  const where = (action: SyncAction | null, place: string) =>
    action ? `${VERBS[action.verb]} ${place}` : "";
  const { here, there } = change;

  let actions: string;
  if (here && there && here.verb === there.verb) actions = `${VERBS[here.verb]} on both`;
  else {
    const [first, ...rest] = [where(here, "here"), where(there, `on ${peerName}`)].filter(
      Boolean,
    );
    actions = [first, ...rest.map((text) => text[0].toLowerCase() + text.slice(1))].join(
      ", ",
    );
  }

  // A merge or a conflict is the fuller account of the same line.
  if (change.note === "merged" || change.note === "conflict" || !actions) {
    return change.note ? NOTES[change.note] : actions;
  }
  return change.note ? `${actions}. ${NOTES[change.note]}` : actions;
}

/** The colour a line is drawn in: what is leaving and what is arriving stand out. */
export function changeTone(change: SyncChange): "add" | "gone" | "warn" | "edit" {
  if (leaves(change)) return "gone";
  if (change.note === "conflict" || change.note === "copy") return "warn";
  if (change.note && change.note !== "merged") return "warn";
  const verbs = [change.here?.verb, change.there?.verb];
  return verbs.includes("add") && !verbs.includes("update") ? "add" : "edit";
}
