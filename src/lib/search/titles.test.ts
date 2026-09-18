import { describe, expect, it } from "vitest";
import type { PageSummary } from "$lib/types";
import type { Segment } from "$lib/storage/store";
import { rankPages, titleOf, split } from "./titles";

let seq = 0;
function page(title: string, parentId: string | null = null): PageSummary {
  return { id: `p${++seq}`, title, parentId, context: "Set", createdAt: seq };
}

function order(pages: PageSummary[], query: string): string[] {
  return rankPages(pages, query, 50).map((m) => titleOf(m.page));
}

function marks(segments: Segment[]): string[] {
  return segments.filter((s) => s.hit).map((s) => s.text);
}

function text(segments: Segment[]): string {
  return segments.map((s) => s.text).join("");
}

describe("rankPages: what comes first", () => {
  it("puts an exact title above a prefix above a mid-word match", () => {
    const pages = [
      page("Unrelated but mentions notes inline"),
      page("Notes on the offsite"),
      page("Field notes"),
      page("Notes"),
    ];
    expect(order(pages, "notes")).toEqual([
      "Notes",
      "Notes on the offsite",
      "Field notes",
      "Unrelated but mentions notes inline",
    ]);
  });

  it("ranks a word-start match above one buried mid-word", () => {
    const pages = [page("Reasonable"), page("Son of a page")];
    expect(order(pages, "son")).toEqual(["Son of a page", "Reasonable"]);
  });

  it("prefers the shorter title when both match the same way", () => {
    const pages = [page("Project Alpha and the long tail"), page("Project Alpha")];
    expect(order(pages, "project")).toEqual([
      "Project Alpha",
      "Project Alpha and the long tail",
    ]);
  });

  it("orders equal-tier siblings by length, then alphabetically", () => {
    const pages = [page("Project Alpha"), page("Projects"), page("Project Beta")];
    expect(order(pages, "project")).toEqual([
      "Projects",
      "Project Beta",
      "Project Alpha",
    ]);
  });

  it("matches every term in any order, below a whole-query prefix", () => {
    const pages = [page("Alpha Project"), page("Project Alpha Notes")];

    expect(order(pages, "project alpha")).toEqual([
      "Project Alpha Notes",
      "Alpha Project",
    ]);
  });

  it("falls back to a fuzzy subsequence when nothing else matches", () => {
    const pages = [page("Project Alpha"), page("Unrelated")];
    expect(order(pages, "pjal")).toEqual(["Project Alpha"]);
  });

  it("is case-insensitive", () => {
    expect(order([page("Quarterly Planning")], "QUARTERLY")).toEqual([
      "Quarterly Planning",
    ]);
    expect(order([page("QUARTERLY PLANNING")], "quarterly")).toEqual([
      "QUARTERLY PLANNING",
    ]);
  });

  it("excludes pages that match nothing", () => {
    const pages = [page("Alpha"), page("Beta")];
    expect(order(pages, "gamma")).toEqual([]);
  });

  it("orders deterministically when scores tie", () => {
    const pages = [page("Notes B"), page("Notes A")];
    expect(order(pages, "notes")).toEqual(["Notes A", "Notes B"]);
  });

  it("respects the limit", () => {
    const pages = Array.from({ length: 10 }, (_, i) => page(`Note ${i}`));
    expect(rankPages(pages, "note", 3)).toHaveLength(3);
  });
});

describe("rankPages: metadata (the ancestor breadcrumb)", () => {
  const projects = page("Projects");
  const child = page("Notes", projects.id);
  const personal = page("Personal");
  const other = page("Notes", personal.id);
  const pages = [projects, child, personal, other];

  it("matches a page through its ancestors", () => {
    const hits = rankPages(pages, "personal", 50);

    expect(hits.map((m) => titleOf(m.page))).toEqual(["Personal", "Notes"]);
    expect(hits[1].page.id).toBe(other.id);
  });

  it("never lets a breadcrumb match outrank a title match", () => {
    const notes = page("Notes");
    const filed = page("Agenda", notes.id);
    const hits = rankPages([filed, notes], "notes", 50);
    expect(hits.map((m) => titleOf(m.page))).toEqual(["Notes", "Agenda"]);
  });

  it("highlights the breadcrumb, not the title, on a metadata match", () => {
    const hits = rankPages(pages, "personal", 50);
    const viaPath = hits.find((m) => m.page.id === other.id)!;
    expect(marks(viaPath.title)).toEqual([]);
    expect(marks(viaPath.path)).toEqual(["Personal"]);
  });

  it("builds the breadcrumb from the whole ancestor chain", () => {
    const a = page("A");
    const b = page("B", a.id);
    const c = page("C", b.id);
    const hits = rankPages([a, b, c], "", 50);
    expect(text(hits[2].path)).toBe("A / B");
  });

  it("survives a parent cycle rather than hanging", () => {
    const ctx = "Set";
    const x: PageSummary = {
      id: "x",
      title: "X",
      parentId: "y",
      context: ctx,
      createdAt: 1,
    };
    const y: PageSummary = {
      id: "y",
      title: "Y",
      parentId: "x",
      context: ctx,
      createdAt: 2,
    };
    expect(() => rankPages([x, y], "x", 50)).not.toThrow();
  });
});

describe("rankPages: highlighting", () => {
  it("marks the matched run of a prefix match", () => {
    const [hit] = rankPages([page("Project Alpha")], "proj", 50);
    expect(marks(hit.title)).toEqual(["Proj"]);
    expect(text(hit.title)).toBe("Project Alpha");
  });

  it("marks the matched word for a word-start match", () => {
    const [hit] = rankPages([page("Project Alpha")], "alpha", 50);
    expect(marks(hit.title)).toEqual(["Alpha"]);
  });

  it("marks each term of a multi-term match", () => {
    const [hit] = rankPages([page("Project Alpha Notes")], "notes alpha", 50);
    expect(marks(hit.title)).toEqual(["Alpha", "Notes"]);
    expect(text(hit.title)).toBe("Project Alpha Notes");
  });

  it("marks the scattered letters of a fuzzy match", () => {
    const [hit] = rankPages([page("Project Alpha")], "pjal", 50);

    expect(marks(hit.title)).toEqual(["P", "j", "Al"]);
    expect(text(hit.title)).toBe("Project Alpha");
  });

  it("always reconstructs the original title, capitalization intact", () => {
    for (const query of ["pro", "ALPHA", "ject", "pjal", "project alpha"]) {
      const [hit] = rankPages([page("Project Alpha")], query, 50);
      expect(text(hit.title), `query: ${query}`).toBe("Project Alpha");
    }
  });
});

describe("rankPages: the empty query", () => {
  it("lists every page unranked, in the order given", () => {
    const pages = [page("Zebra"), page("Apple")];
    expect(order(pages, "")).toEqual(["Zebra", "Apple"]);
  });

  it("highlights nothing", () => {
    const hits = rankPages([page("Zebra")], "  ", 50);
    expect(marks(hits[0].title)).toEqual([]);
  });

  it("still respects the limit", () => {
    const pages = Array.from({ length: 10 }, (_, i) => page(`Note ${i}`));
    expect(rankPages(pages, "", 4)).toHaveLength(4);
  });
});

describe("rankPages: grouped by the chroot", () => {
  function seed() {
    const work = page("Work");
    const roadmap = page("Roadmap", work.id);
    const goals = page("Goals", roadmap.id);
    const personal = page("Personal");
    const notes = page("Roadmap notes", personal.id);
    return { work, pages: [work, roadmap, goals, personal, notes] };
  }

  it("puts the root's pages first, however much better the others match", () => {
    const { work, pages } = seed();

    expect(order(pages, "roadmap")).toEqual(["Roadmap", "Roadmap notes", "Goals"]);

    expect(rankPages(pages, "roadmap", 50, work.id).map((m) => titleOf(m.page))).toEqual([
      "Roadmap",
      "Goals",
      "Roadmap notes",
    ]);
  });

  it("still shows what's outside the root", () => {
    const { work, pages } = seed();

    expect(rankPages(pages, "personal", 50, work.id).map((m) => titleOf(m.page))).toEqual(
      ["Personal", "Roadmap notes"],
    );
  });

  it("counts the root itself, and everything under it however deep", () => {
    const { work, pages } = seed();
    const inside = rankPages(pages, "", 50, work.id)
      .filter((m) => m.inRoot)
      .map((m) => titleOf(m.page));
    expect(inside).toEqual(["Work", "Roadmap", "Goals"]);
  });

  it("flags nothing as in-root when there's no chroot", () => {
    const { pages } = seed();
    expect(rankPages(pages, "", 50).some((m) => m.inRoot)).toBe(false);
  });

  it("gives each group its own budget, so neither crowds the other out", () => {
    const root = page("Root");
    const inside = Array.from({ length: 6 }, () => page("Note", root.id));
    const outside = Array.from({ length: 6 }, () => page("Note"));
    const hits = rankPages([root, ...inside, ...outside], "note", 3, root.id);

    expect(hits.filter((m) => m.inRoot)).toHaveLength(3);
    expect(hits.filter((m) => !m.inRoot)).toHaveLength(3);
  });

  it("groups the empty query too, so an unopened switcher is already scoped", () => {
    const { work, pages } = seed();
    expect(rankPages(pages, "", 50, work.id).map((m) => titleOf(m.page))).toEqual([
      "Work",
      "Roadmap",
      "Goals",
      "Personal",
      "Roadmap notes",
    ]);
  });

  it("treats a root that isn't in the list as empty rather than throwing", () => {
    const { pages } = seed();
    const hits = rankPages(pages, "roadmap", 50, "gone");
    expect(hits.some((m) => m.inRoot)).toBe(false);
    expect(hits.map((m) => titleOf(m.page))).toEqual([
      "Roadmap",
      "Roadmap notes",
      "Goals",
    ]);
  });
});

describe("titleOf", () => {
  it("labels an untitled page", () => {
    expect(titleOf(page(""))).toBe("Untitled");
    expect(titleOf(page("   "))).toBe("Untitled");
  });

  it("makes an untitled page findable by that label", () => {
    expect(order([page("")], "untitled")).toEqual(["Untitled"]);
  });
});

describe("split", () => {
  it("coalesces overlapping ranges rather than nesting them", () => {
    const segments = split("pages", [
      [0, 4],
      [0, 5],
    ]);
    expect(marks(segments)).toEqual(["pages"]);
    expect(text(segments)).toBe("pages");
  });

  it("returns the whole string as one plain run when nothing matched", () => {
    expect(split("plain", [])).toEqual([{ text: "plain", hit: false }]);
  });
});
