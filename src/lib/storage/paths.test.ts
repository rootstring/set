import { describe, expect, it } from "vitest";

import { contextOf, findAssetRefs, isReserved, sanitizeContextName } from "./paths";

describe("findAssetRefs", () => {
  it("reads a Markdown image reference", () => {
    expect(findAssetRefs("![](Project-A/Set-page-assets/k3m9.png)")).toEqual([
      "k3m9.png",
    ]);
  });

  it("reads the angle-bracket form a title with parentheses forces", () => {
    expect(findAssetRefs("![](<A (draft)/Set-page-assets/k3m9.png>)")).toEqual([
      "k3m9.png",
    ]);
  });

  it("reads a resized image's <img> form", () => {
    const markdown = '<img src="Project-A/Set-page-assets/k3m9.png" width="240">';
    expect(findAssetRefs(markdown)).toEqual(["k3m9.png"]);
  });

  it("ignores a link that isn't one of ours", () => {
    const markdown = "[a link](https://example.com/photo.png)";
    expect(findAssetRefs(markdown)).toEqual([]);
  });
});

describe("contextOf", () => {
  it("reads the context off a page's path, at any depth", () => {
    expect(contextOf("Work/Standups.md")).toBe("Work");
    expect(contextOf("Work/Standups/Monday.md")).toBe("Work");
    expect(contextOf("Work/A/B/C/D.md")).toBe("Work");
  });

  it("answers the default for a path with no context in it", () => {
    expect(contextOf("Loose.md")).toBe("Set");
  });
});

describe("sanitizeContextName", () => {
  it("keeps the spaces a folder name can hold", () => {
    expect(sanitizeContextName("My Work")).toBe("My Work");
  });

  it("strips what a path can't carry", () => {
    expect(sanitizeContextName("Work/Home")).toBe("Work-Home");
    expect(sanitizeContextName('a:b*c?d"e<f>g|h')).toBe("a-b-c-d-e-f-g-h");
    expect(sanitizeContextName("  padded  ")).toBe("padded");

    expect(sanitizeContextName(".hidden.")).toBe("hidden");
  });

  it("refuses a name with nothing in it, rather than inventing one", () => {
    expect(sanitizeContextName("")).toBe(null);
    expect(sanitizeContextName("   ")).toBe(null);
    expect(sanitizeContextName("///")).toBe(null);
  });

  it("refuses the names the layout keeps for itself, at every level", () => {
    expect(sanitizeContextName("Set-Trash")).toBe(null);
    expect(sanitizeContextName("set-trash")).toBe(null);
    expect(sanitizeContextName("Set-page-assets")).toBe(null);
    expect(isReserved("Set-Trash")).toBe(true);
    expect(isReserved("SET-PAGE-ASSETS")).toBe(true);

    expect(isReserved("Set")).toBe(false);
  });

  it("keeps letters and digits from any script", () => {
    expect(sanitizeContextName("日本語")).toBe("日本語");
    expect(sanitizeContextName("Проект")).toBe("Проект");
  });
});
