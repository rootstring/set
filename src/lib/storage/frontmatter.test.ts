import { describe, expect, it } from "vitest";

import { composeFile, markdownBody, pageSignature } from "./frontmatter";
import type { Page } from "$lib/types";

function page(overrides: Partial<Page> = {}): Page {
  return {
    id: "k7m3qp94x2",
    title: "Project A",
    doc: { type: "doc" },
    parentId: null,
    context: "Set",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

const asSaved = (p: Page, body: string) => pageSignature(p, p.order, body);

const asRead = (p: Page, body: string) =>
  pageSignature(p, p.order, markdownBody(composeFile(p, body)));

describe("pageSignature round trip", () => {
  it("matches whether the body was written or read back", () => {
    const p = page();
    const body = "# Hello\n\nSome text.";
    expect(asRead(p, body)).toBe(asSaved(p, body));
  });

  it("survives the trailing newline pageToFile adds", () => {
    const p = page();
    expect(markdownBody(composeFile(p, "text"))).toBe("text\n");
    expect(asRead(p, "text")).toBe(asSaved(p, "text"));
  });

  it("matches for an empty page", () => {
    const p = page();
    expect(asRead(p, "")).toBe(asSaved(p, ""));
  });

  it("matches for a page carrying every optional field", () => {
    const p = page({ order: 3.5, locked: true, parentId: "parent01" });
    const body = "- [x] done\n- [ ] not";
    expect(asRead(p, body)).toBe(asSaved(p, body));
  });

  it("still notices a body that really did change", () => {
    const p = page();
    expect(asRead(p, "theirs")).not.toBe(asSaved(p, "ours"));
  });

  it("still notices a retitle, a re-parent, a reorder and a lock", () => {
    const base = page();
    const body = "same body";
    expect(asSaved(page({ title: "Project B" }), body)).not.toBe(asSaved(base, body));
    expect(asSaved(page({ parentId: "other" }), body)).not.toBe(asSaved(base, body));
    expect(asSaved(page({ order: 2 }), body)).not.toBe(asSaved(base, body));
    expect(asSaved(page({ locked: true }), body)).not.toBe(asSaved(base, body));
  });

  it("ignores only trailing newlines, not trailing spaces", () => {
    const p = page();
    expect(asSaved(p, "line  ")).not.toBe(asSaved(p, "line"));
    expect(asSaved(p, "line\n\n\n")).toBe(asSaved(p, "line"));
  });
});
