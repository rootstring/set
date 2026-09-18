import { describe, expect, it } from "vitest";
import type { ContentMatch } from "$lib/storage/store";
import { foldAscii, searchBodies, MIN_QUERY_CHARS, type IndexedBody } from "./content";

function index(pages: [string, string][]): IndexedBody[] {
  return pages.map(([id, body]) => ({ id, body, fold: foldAscii(body) }));
}

function search(pages: [string, string][], query: string, limit = 50): ContentMatch[] {
  return searchBodies(index(pages), query, limit);
}

function text(hit: ContentMatch): string {
  return hit.snippet.map((s) => s.text).join("");
}

function marks(hit: ContentMatch): string[] {
  return hit.snippet.filter((s) => s.hit).map((s) => s.text);
}

const ids = (hits: ContentMatch[]) => hits.map((h) => h.id);

describe("searchBodies: matching", () => {
  it("matches case-insensitively and snippets the matching line", () => {
    const hits = search([["a", "first line\nA TODO item lives here\nlast line"]], "todo");
    expect(hits).toHaveLength(1);
    expect(text(hits[0])).toBe("A TODO item lives here");
    expect(marks(hits[0])).toEqual(["TODO"]);
  });

  it("matches mid-word, which is the point of scanning rather than tokenizing", () => {
    const pages: [string, string][] = [["a", "Refactoring the serializer"]];
    expect(marks(search(pages, "serial")[0])).toEqual(["serial"]);
    expect(marks(search(pages, "factor")[0])).toEqual(["factor"]);
  });

  it("requires every term, so refining a query narrows it", () => {
    const pages: [string, string][] = [
      ["both", "alpha\nbeta"],
      ["one", "alpha only"],
      ["neither", "nothing here"],
    ];
    expect(ids(search(pages, "alpha"))).toEqual(expect.arrayContaining(["both", "one"]));
    expect(ids(search(pages, "alpha beta"))).toEqual(["both"]);
  });

  it("finds nothing for a query below the minimum length", () => {
    const pages: [string, string][] = [["a", "a page about everything"]];
    expect(search(pages, "a")).toEqual([]);
    expect("a".length).toBeLessThan(MIN_QUERY_CHARS);
  });

  it("finds nothing for a blank query", () => {
    expect(search([["a", "anything"]], "   ")).toEqual([]);
  });

  it("ignores surrounding whitespace and collapses inner runs", () => {
    const pages: [string, string][] = [["a", "alpha and beta"]];
    expect(ids(search(pages, "  alpha   beta  "))).toEqual(["a"]);
  });
});

describe("searchBodies: ranking", () => {
  it("ranks a verbatim phrase above the same words scattered", () => {
    const pages: [string, string][] = [
      ["scattered", "project\nsomething else entirely\nalpha"],
      ["verbatim", "notes about project alpha\nmore"],
    ];
    expect(ids(search(pages, "project alpha"))[0]).toBe("verbatim");
  });

  it("prefers a page whose single line carries the most terms", () => {
    const pages: [string, string][] = [
      ["split", "alpha here\nbeta over there"],
      ["together", "alpha and beta on one line"],
    ];
    expect(ids(search(pages, "alpha beta"))[0]).toBe("together");
  });

  it("caps the weight of sheer repetition", () => {
    const pages: [string, string][] = [
      ["shouty", `${"alpha ".repeat(40)}\nbeta`],
      ["precise", "alpha beta"],
    ];
    expect(ids(search(pages, "alpha beta"))[0]).toBe("precise");
  });

  it("orders deterministically when scores tie", () => {
    const pages: [string, string][] = [
      ["b", "needle"],
      ["a", "needle"],
    ];
    expect(ids(search(pages, "needle"))).toEqual(["a", "b"]);
  });

  it("respects the limit", () => {
    const pages: [string, string][] = Array.from({ length: 10 }, (_, i) => [
      `p${i}`,
      "needle",
    ]);
    expect(search(pages, "needle", 3)).toHaveLength(3);
  });

  it("reports total occurrences across the page, not just the shown line", () => {
    const [hit] = search([["a", "needle one\nneedle two\nneedle three"]], "needle");
    expect(hit.total).toBe(3);
  });
});

describe("searchBodies: snippets", () => {
  it("picks the line carrying the most terms and marks each one", () => {
    const [hit] = search(
      [["a", "alpha alone\nbeta alone\nalpha and beta together"]],
      "alpha beta",
    );
    expect(text(hit)).toBe("alpha and beta together");
    expect(marks(hit)).toEqual(["alpha", "beta"]);
  });

  it("windows a long line around the match, with ellipses", () => {
    const body = `${"pad ".repeat(80)} NEEDLE ${"tail ".repeat(80)}`;
    const [hit] = search([["a", body]], "needle");
    const shown = text(hit);
    expect(shown.startsWith("… ")).toBe(true);
    expect(shown.endsWith(" …")).toBe(true);
    expect(shown).toContain("NEEDLE");
    expect([...shown].length).toBeLessThanOrEqual(164);
    expect(marks(hit)).toEqual(["NEEDLE"]);
  });

  it("leaves a short line whole, with no ellipses", () => {
    const [hit] = search([["a", "a short line with a needle in it"]], "needle");
    expect(text(hit)).toBe("a short line with a needle in it");
  });

  it("trims leading Markdown indentation off the snippet", () => {
    const [hit] = search(
      [["a", "intro\n    - a nested bullet about needles\n"]],
      "needle",
    );
    expect(text(hit)).toBe("- a nested bullet about needles");
    expect(marks(hit)).toEqual(["needle"]);
  });

  it("coalesces overlapping terms into one highlighted run", () => {
    const [hit] = search([["a", "the pages page"]], "page pages");
    expect(marks(hit)).toEqual(["pages", "page"]);
    expect(text(hit)).toBe("the pages page");
  });

  it("preserves the body's capitalization in the snippet", () => {
    const [hit] = search([["a", "The Quarterly Planning Doc"]], "quarterly");
    expect(text(hit)).toBe("The Quarterly Planning Doc");
    expect(marks(hit)).toEqual(["Quarterly"]);
  });

  it("always reconstructs the matched line from its segments", () => {
    const line = "mixed CASE and needle and NEEDLE again";
    const [hit] = search([["a", line]], "needle");
    expect(text(hit)).toBe(line);
  });
});

describe("searchBodies: non-ASCII text", () => {
  it("matches accented text against itself", () => {
    const [hit] = search([["a", "héllo wörld, naïve café notes\nsecond line"]], "café");
    expect(text(hit)).toContain("café");
    expect(marks(hit)).toEqual(["café"]);
  });

  it("matches an emoji without splitting it", () => {
    const [hit] = search([["a", "🎯 target practice"]], "🎯 target");

    expect(marks(hit)).toEqual(["🎯", "target"]);
    expect(text(hit)).toBe("🎯 target practice");
  });

  it("does not fold case beyond ASCII, matching the native index", () => {
    expect(search([["a", "CAFÉ"]], "café")).toEqual([]);
    expect(ids(search([["a", "CAFE"]], "cafe"))).toEqual(["a"]);
  });

  it("windows a long line of wide characters on whole characters", () => {
    const body = `${"🎯".repeat(200)}NEEDLE${"🎯".repeat(200)}`;
    const [hit] = search([["a", body]], "needle");

    expect(text(hit)).not.toContain("�");
    expect(text(hit)).toContain("NEEDLE");
  });
});

describe("foldAscii", () => {
  it("lowercases A–Z and nothing else", () => {
    expect(foldAscii("ABC-DÉF")).toBe("abc-dÉf");
  });

  it("preserves length exactly, which the offset alignment depends on", () => {
    for (const s of ["ABC", "İstanbul", "🎯 MIXED Café", "", "ǅungla"]) {
      expect(foldAscii(s).length, s).toBe(s.length);
    }
  });
});
