import { describe, expect, it } from "vitest";
import { contextPath, contextSegment, matchContext, pagePath } from "./addresses";

describe("contextSegment", () => {
  it("is the name as a slug", () => {
    const all = ["Set", "My Notes", "Café Recipes"];
    expect(contextSegment("Set", all)).toBe("set");
    expect(contextSegment("My Notes", all)).toBe("my-notes");
    expect(contextSegment("Café Recipes", all)).toBe("cafe-recipes");
  });

  it("is the name itself when there's no slug to be had", () => {
    expect(contextSegment("日記", ["日記", "Set"])).toBe("日記");
  });

  it("is the name itself when another context makes the same slug", () => {
    const all = ["My Notes", "my-notes!", "Work"];
    expect(contextSegment("My Notes", all)).toBe("My Notes");
    expect(contextSegment("my-notes!", all)).toBe("my-notes!");
    expect(contextSegment("Work", all)).toBe("work");
  });

  it("never gives two contexts the same segment", () => {
    const all = ["My Notes", "my-notes", "MY  NOTES?", "日記", "Work", "work 2", "A.B"];
    const segments = all.map((name) => contextSegment(name, all).toLowerCase());
    expect(new Set(segments).size).toBe(all.length);
  });
});

describe("matchContext", () => {
  const all = ["Set", "My Notes", "日記", "Work", "work!"];

  it("finds a context by the segment its address uses", () => {
    for (const name of all) {
      expect(matchContext(contextSegment(name, all), all)).toBe(name);
    }
  });

  it("takes a name or a slug in any case", () => {
    expect(matchContext("set", all)).toBe("Set");
    expect(matchContext("SET", all)).toBe("Set");
    expect(matchContext("My-Notes", all)).toBe("My Notes");
    expect(matchContext("my notes", all)).toBe("My Notes");
  });

  it("won't guess between two contexts that share a slug", () => {
    // `work` is both contexts' slug; the name that matches it outright wins.
    expect(matchContext("work", all)).toBe("Work");
    expect(matchContext("my-notes", ["My Notes", "My-Notes!"])).toBeNull();
  });

  it("finds nothing for a context that isn't there", () => {
    expect(matchContext("nowhere", all)).toBeNull();
  });
});

describe("addresses", () => {
  it("escapes what a slug leaves in", () => {
    expect(contextPath("日記")).toBe("/%E6%97%A5%E8%A8%98");
    expect(contextPath("My Notes")).toBe("/My%20Notes");
  });

  it("puts a page under its context", () => {
    expect(pagePath("abc123", "Q3 Budget", "work")).toBe("/work/pages/q3-budget-abc123");
    expect(pagePath("abc123", "", "work")).toBe("/work/pages/abc123");
  });
});
