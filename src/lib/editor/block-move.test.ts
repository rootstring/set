import { describe, expect, it } from "vitest";

import { assetRefsIn, pageLinkIdsIn, withAssetRefs } from "./block-move";

/** Nested on purpose: a move that only looked at the top node would leave both behind. */
const toggle = {
  type: "details",
  content: [
    { type: "detailsSummary", content: [{ type: "text", text: "Sprint" }] },
    {
      type: "detailsContent",
      content: [
        { type: "pageLink", attrs: { pageId: "aaa", title: "Standup" } },
        { type: "image", attrs: { src: "Sprint/Set-page-assets/k1.png" } },
        {
          type: "paragraph",
          content: [{ type: "image", attrs: { src: "Sprint/Set-page-assets/k2.png" } }],
        },
      ],
    },
  ],
};

describe("pageLinkIdsIn", () => {
  it("finds a subpage link nested inside a block", () => {
    expect(pageLinkIdsIn(toggle)).toEqual(["aaa"]);
  });

  it("reads the block itself when the block is the link", () => {
    expect(pageLinkIdsIn({ type: "pageLink", attrs: { pageId: "bbb" } })).toEqual([
      "bbb",
    ]);
  });

  it("names each page once, however many times it is linked", () => {
    expect(
      pageLinkIdsIn({
        type: "details",
        content: [
          { type: "pageLink", attrs: { pageId: "ccc" } },
          { type: "pageLink", attrs: { pageId: "ccc" } },
        ],
      }),
    ).toEqual(["ccc"]);
  });

  it("has nothing to say about a plain paragraph", () => {
    expect(
      pageLinkIdsIn({ type: "paragraph", content: [{ type: "text", text: "hi" }] }),
    ).toEqual([]);
  });
});

describe("assetRefsIn", () => {
  it("finds every image, however deep", () => {
    expect(assetRefsIn(toggle)).toEqual([
      "Sprint/Set-page-assets/k1.png",
      "Sprint/Set-page-assets/k2.png",
    ]);
  });
});

describe("withAssetRefs", () => {
  it("swaps the references the copies were made under", () => {
    const moved = withAssetRefs(
      toggle,
      new Map([["Sprint/Set-page-assets/k1.png", "Notes/Set-page-assets/k1.png"]]),
    );
    // The one that was copied points at its copy; the one that wasn't is left
    // exactly as it was, rather than rewritten to a file that isn't there.
    expect(assetRefsIn(moved)).toEqual([
      "Notes/Set-page-assets/k1.png",
      "Sprint/Set-page-assets/k2.png",
    ]);
  });

  it("leaves the block alone when nothing was copied", () => {
    expect(withAssetRefs(toggle, new Map())).toBe(toggle);
  });

  it("doesn't change the block it was given", () => {
    withAssetRefs(
      toggle,
      new Map([["Sprint/Set-page-assets/k1.png", "Notes/Set-page-assets/k1.png"]]),
    );
    expect(assetRefsIn(toggle)).toEqual([
      "Sprint/Set-page-assets/k1.png",
      "Sprint/Set-page-assets/k2.png",
    ]);
  });
});
