import { describe, expect, it } from "vitest";
import { backlinkIds, wikiLinkTitles } from "./wiki-links";

const titles = (body: string) => wikiLinkTitles(body);

describe("wikiLinkTitles", () => {
  it("reads the page a wikilink names", () => {
    expect(titles("see [[Other]] for more")).toEqual(["Other"]);
    expect(titles("[[Other|shown as this]]")).toEqual(["Other"]);
    expect(titles("[[Other#A heading]]")).toEqual(["Other"]);
    expect(titles("[[  Other  ]]")).toEqual(["Other"]);
    expect(titles("[[A]] then [[B]]")).toEqual(["A", "B"]);
  });

  it("ignores what is not a wikilink", () => {
    expect(titles("[not a wikilink](http://x)")).toEqual([]);
    expect(titles("[[unclosed")).toEqual([]);
    expect(titles("[[]]")).toEqual([]);
    expect(titles("[[|only an alias]]")).toEqual([]);
    expect(titles("a [[link\nsplit]] over lines")).toEqual([]);
  });

  it("skips links written inside code", () => {
    expect(titles("`[[Other]]`")).toEqual([]);
    expect(titles("```\n[[Other]]\n```")).toEqual([]);
    expect(titles("~~~md\n[[Other]]\n~~~")).toEqual([]);
    expect(titles("``a ` b [[Other]]``")).toEqual([]);

    // The fence has to close on its own character before text counts again.
    expect(titles("```\n[[A]]\n```\n[[B]]")).toEqual(["B"]);
    expect(titles("```\n~~~\n[[A]]\n```")).toEqual([]);
    expect(titles("`unclosed [[Other]]")).toEqual(["Other"]);
  });

  /**
   * Same cases, same order, as `same_titles_as_the_typescript_scanner` in src-tauri/src/index.rs.
   */
  it("matches the Rust scanner", () => {
    const cases: [string, string[]][] = [
      ["plain [[One]]", ["One"]],
      ["[[One|alias]] and [[Two#section]]", ["One", "Two"]],
      ["[[  Spaced  ]]", ["Spaced"]],
      ["`[[Code]]` but [[Live]]", ["Live"]],
      ["```\n[[Fenced]]\n```\n[[After]]", ["After"]],
      ["   ```\n[[Indented fence]]\n   ```", []],
      ["[[a[b]] [[Good]]", ["Good"]],
      ["[[]] [[|alias]] [[Good]]", ["Good"]],
      ["[[unclosed and [[Good]]", ["Good"]],
      ["nested [[Outer [[Inner]]]]", ["Inner"]],
      ["[[Ünïcödé]]", ["Ünïcödé"]],
    ];

    for (const [body, want] of cases) {
      expect(titles(body), `scanning ${JSON.stringify(body)}`).toEqual(want);
    }
  });
});

describe("backlinkIds", () => {
  const bodies = [
    { id: "a", body: "points at [[Target]]" },
    { id: "b", body: "points at [[target|lowercase]]" },
    { id: "c", body: "points somewhere else: [[Elsewhere]]" },
    { id: "d", body: "no links at all" },
  ];

  it("finds the pages that link to a title", () => {
    expect(backlinkIds(bodies, "Target")).toEqual(["a", "b"]);
    expect(backlinkIds(bodies, "  target  ")).toEqual(["a", "b"]);
    expect(backlinkIds(bodies, "Elsewhere")).toEqual(["c"]);
    expect(backlinkIds(bodies, "Nothing")).toEqual([]);
    expect(backlinkIds(bodies, "   ")).toEqual([]);
  });

  it("lists a page once however many times it links", () => {
    const many = [{ id: "a", body: "[[Target]] and [[Target]] and [[Target|again]]" }];
    expect(backlinkIds(many, "Target")).toEqual(["a"]);
  });
});
