import { describe, expect, it } from "vitest";
import {
  ancestorIds,
  bySiblingOrder,
  isSelfOrDescendant,
  parentsById,
  subtreeIds,
  trailTo,
} from "./tree";

const pages = [
  { id: "a", parentId: null },
  { id: "b", parentId: "a" },
  { id: "c", parentId: "b" },
  { id: "d", parentId: null },
];

describe("subtreeIds", () => {
  it("takes the root and everything under it, at any depth", () => {
    expect([...subtreeIds(pages, "a")].sort()).toEqual(["a", "b", "c"]);
    expect([...subtreeIds(pages, "b")].sort()).toEqual(["b", "c"]);
    expect([...subtreeIds(pages, "d")]).toEqual(["d"]);
  });

  it("returns the root alone when it isn't in the list", () => {
    expect([...subtreeIds(pages, "gone")]).toEqual(["gone"]);
  });

  it("survives a parent cycle rather than hanging", () => {
    const cyclic = [
      { id: "x", parentId: "y" },
      { id: "y", parentId: "x" },
    ];
    expect([...subtreeIds(cyclic, "x")].sort()).toEqual(["x", "y"]);
  });
});

describe("ancestorIds", () => {
  const parents = parentsById(pages);

  it("walks up from the page, nearest first", () => {
    expect(ancestorIds("c", parents)).toEqual(["b", "a"]);
  });

  it("stops before the root it is given", () => {
    expect(ancestorIds("c", parents, "a")).toEqual(["b"]);
  });

  it("survives a parent cycle rather than hanging", () => {
    const cyclic = parentsById([
      { id: "x", parentId: "y" },
      { id: "y", parentId: "x" },
    ]);
    expect(ancestorIds("x", cyclic)).toEqual(["y"]);
  });
});

describe("isSelfOrDescendant", () => {
  const parents = parentsById(pages);

  it("is true for the page itself and anything beneath it", () => {
    expect(isSelfOrDescendant("a", "a", parents)).toBe(true);
    expect(isSelfOrDescendant("c", "a", parents)).toBe(true);
  });

  it("is false across branches and upwards", () => {
    expect(isSelfOrDescendant("d", "a", parents)).toBe(false);
    expect(isSelfOrDescendant("a", "c", parents)).toBe(false);
  });
});

describe("bySiblingOrder", () => {
  it("keeps an untouched group in creation order", () => {
    const siblings = [
      { id: "1", parentId: null, createdAt: 300 },
      { id: "2", parentId: null, createdAt: 100 },
      { id: "3", parentId: null, createdAt: 200 },
    ];
    expect([...siblings].sort(bySiblingOrder).map((s) => s.id)).toEqual(["2", "3", "1"]);
  });

  it("follows the dragged position once a group has been reordered", () => {
    const siblings = [
      { id: "1", parentId: null, createdAt: 100, order: 2 },
      { id: "2", parentId: null, createdAt: 200, order: 0 },
      { id: "3", parentId: null, createdAt: 300, order: 1 },
    ];
    expect([...siblings].sort(bySiblingOrder).map((s) => s.id)).toEqual(["2", "3", "1"]);
  });
});

describe("trailTo", () => {
  const ids = (trail: { id: string }[]) => trail.map((p) => p.id);

  it("lists the ancestors outermost first, without the page itself", () => {
    expect(ids(trailTo("c", pages))).toEqual(["a", "b"]);
    expect(ids(trailTo("b", pages))).toEqual(["a"]);
  });

  it("is empty for a top-level page", () => {
    expect(trailTo("a", pages)).toEqual([]);
    expect(trailTo("d", pages)).toEqual([]);
  });

  it("starts at the chroot, keeping the root itself", () => {
    expect(ids(trailTo("c", pages, "b"))).toEqual(["b"]);
    expect(ids(trailTo("c", pages, "a"))).toEqual(["a", "b"]);
  });

  it("is empty for the chroot's own page", () => {
    expect(trailTo("b", pages, "b")).toEqual([]);
  });

  it("keeps the whole trail for a page outside the chroot", () => {
    expect(ids(trailTo("c", pages, "d"))).toEqual(["a", "b"]);
  });

  it("skips an ancestor that is no longer in the list", () => {
    const orphaned = [
      { id: "b", parentId: "gone" },
      { id: "c", parentId: "b" },
    ];
    expect(ids(trailTo("c", orphaned))).toEqual(["b"]);
  });

  it("survives a parent cycle rather than hanging", () => {
    const cyclic = [
      { id: "x", parentId: "y" },
      { id: "y", parentId: "x" },
    ];
    expect(ids(trailTo("x", cyclic))).toEqual(["y"]);
  });
});
