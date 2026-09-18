import { describe, expect, it } from "vitest";
import type { TrashEntry } from "$lib/types";
import { trashInContext } from "./trash";

const page = (id: string, context: string): TrashEntry => ({
  kind: "page",
  id,
  title: id,
  trashedAt: 0,
  context,
  descendants: 0,
});

const context = (name: string): TrashEntry => ({
  kind: "context",
  name,
  trashedAt: 0,
  pages: 0,
});

const trash = [
  page("a", "Work"),
  page("b", "Personal"),
  context("Old"),
  page("c", "Work"),
];

describe("trashInContext", () => {
  it("keeps only the pages trashed out of that context", () => {
    expect(trashInContext(trash, "Work").map(entryName)).toEqual(["a", "Old", "c"]);
    expect(trashInContext(trash, "Personal").map(entryName)).toEqual(["b", "Old"]);
  });

  it("shows deleted contexts in every scope, since they belong to none", () => {
    expect(trashInContext(trash, "Nowhere").map(entryName)).toEqual(["Old"]);
  });
});

function entryName(entry: TrashEntry): string {
  return entry.kind === "page" ? entry.id : entry.name;
}
