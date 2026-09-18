import { describe, expect, test } from "vitest";

import {
  buildTree,
  changeLabel,
  changeTone,
  countsLabel,
  summarize,
  type SyncAction,
  type SyncChange,
  type SyncPreview,
  type TreeNode,
} from "./sync-preview";

const act = (verb: SyncAction["verb"], from: string | null = null): SyncAction => ({
  verb,
  from,
});

function change(path: string, fields: Partial<SyncChange> = {}): SyncChange {
  return {
    path,
    dir: false,
    here: null,
    there: null,
    note: null,
    diffable: false,
    ...fields,
  };
}

function preview(fields: Partial<SyncPreview>): SyncPreview {
  return {
    changes: [],
    unchanged: [],
    contexts: [],
    titles: {},
    massTrash: null,
    ...fields,
  };
}

/** The tree as indented names, which is how it reads on screen. */
function outline(nodes: TreeNode[], depth = 0): string[] {
  return nodes.flatMap((n) => [
    `${"  ".repeat(depth)}${n.name} [${n.kind}${n.change ? "*" : ""}]`,
    ...outline(n.children, depth + 1),
  ]);
}

describe("buildTree", () => {
  test("a page and the folder of its subpages are one line, as in the sidebar", () => {
    const tree = buildTree(
      preview({
        contexts: ["Set", "Empty"],
        unchanged: ["Set/Projects.md", "Set/Projects/Set-page-assets/logo.png"],
        changes: [change("Set/Projects/Roadmap.md", { here: act("add") })],
      }),
    );
    expect(outline(tree)).toEqual([
      "Empty [context]",
      "Set [context]",
      "  Projects [page]",
      "    Roadmap [page*]",
      "    Attachments [folder]",
      "      logo.png [file]",
    ]);
    // What opens a folder by default: whether anything under it changes.
    expect(tree.map((n) => n.changed)).toEqual([0, 1]);
  });

  test("pages go by their titles, and still gather their subpages", () => {
    const tree = buildTree(
      preview({
        unchanged: ["Set/Q4-plan.md", "Set/Q4-plan/No-title.md"],
        changes: [change("Set/Q4-plan/Launch-post.md", { here: act("add") })],
        titles: {
          "Set/Q4-plan.md": "Q4 plan",
          "Set/Q4-plan/Launch-post.md": "Launch: the post",
        },
      }),
    );
    expect(outline(tree)).toEqual([
      "Set [context]",
      "  Q4 plan [page]",
      "    Launch: the post [page*]",
      "    No-title [page]",
    ]);
  });

  test("a page made under the name of one being trashed keeps a line of its own", () => {
    const tree = buildTree(
      preview({
        changes: [
          change("Set/Plan.md", { here: act("trash") }),
          change("Set/Plan.md", { there: act("add") }),
        ],
      }),
    );
    expect(tree[0].children.map((n) => [n.name, n.change?.here?.verb ?? null])).toEqual([
      ["Plan", "trash"],
      ["Plan", null],
    ]);
  });
});

describe("what a change says", () => {
  test("names the device it happens on", () => {
    expect(changeLabel(change("a", { here: act("update") }), "MacBook")).toBe(
      "Updated here",
    );
    expect(changeLabel(change("a", { there: act("add") }), "MacBook")).toBe(
      "New on MacBook",
    );
    expect(
      changeLabel(change("a", { here: act("move"), there: act("update") }), "MacBook"),
    ).toBe("Moved here, updated on MacBook");
    expect(
      changeLabel(change("a", { here: act("add"), there: act("add") }), "MacBook"),
    ).toBe("New on both");
  });

  test("a merge, a conflict and a file left out say what they are", () => {
    const both = { here: act("update"), there: act("update") };
    expect(changeLabel(change("a", { ...both, note: "merged" }), "Mac")).toBe(
      "Edits from both merged",
    );
    expect(changeLabel(change("a", { note: "too_big" }), "Mac")).toBe(
      "Too large to sync, stays where it is",
    );
    expect(changeTone(change("a", { note: "too_big" }))).toBe("warn");
    expect(changeTone(change("a", { there: act("trash") }))).toBe("gone");
    expect(changeTone(change("a", { here: act("add") }))).toBe("add");
    expect(changeTone(change("a", { ...both, note: "merged" }))).toBe("edit");
  });

  test("counts each device's changes apart", () => {
    const summary = summarize(
      preview({
        changes: [
          change("a", { here: act("add") }),
          change("b", { here: act("add") }),
          change("c", { here: act("update"), there: act("update"), note: "merged" }),
          change("d", { there: act("trash") }),
          change("e", { note: "too_big" }),
        ],
      }),
    );
    expect(countsLabel(summary.here)).toBe("2 new, 1 updated");
    expect(countsLabel(summary.there)).toBe("1 updated, 1 to the Trash");
    expect([summary.merged, summary.conflicts, summary.leftOut]).toEqual([1, 0, 1]);
  });
});
