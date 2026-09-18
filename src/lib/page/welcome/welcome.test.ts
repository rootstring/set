// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { markdownToDoc } from "$lib/storage/markdown";
import { welcomeChildren, welcomeRoot, type WelcomeOptions } from "./index";

type Json = { type: string; content?: Json[] };

function types(node: Json, out = new Set<string>()): Set<string> {
  out.add(node.type);
  for (const child of node.content ?? []) types(child, out);
  return out;
}

/** Mac and elsewhere write keys differently. */
const PLATFORMS: [string, WelcomeOptions][] = [
  [
    "as a Mac writes keys",
    {
      context: "Set",
      binding: () => "Mod+KeyK",
      formatShortcut: (s) => s.replace("Mod+", "⌘").replace(/Key|Digit/, ""),
      feedbackUrl: "https://feedback.example.com/?version=1.0.0&platform=macos-silicon",
      now: new Date(2026, 8, 13, 10),
    },
  ],
  [
    "as Windows writes keys",
    {
      context: "Set",
      binding: () => "Mod+KeyK",
      formatShortcut: (s) => s.replace("Mod", "Ctrl").replace(/Key|Digit/, ""),
      feedbackUrl: "https://feedback.example.com/?version=1.0.0&platform=windows",
      now: new Date(2026, 11, 31, 23),
    },
  ],
];

function drafts(opts: WelcomeOptions) {
  const children = welcomeChildren(opts);
  const root = welcomeRoot(
    opts,
    children.map((c, i) => ({ id: `child${i}`, title: c.title })),
  );
  return [root, ...children];
}

describe.each(PLATFORMS)("welcome pages (%s)", (_name, opts) => {
  it.each(drafts(opts).map((d) => [d.title, d.body]))(
    "%s is all real blocks, none shown as raw Markdown",
    (_title, body) => {
      expect(body).not.toMatch(/\{\{/);
      const seen = types(markdownToDoc(body) as Json);
      expect(seen.has("rawBlock")).toBe(false);
      expect(seen.has("rawInline")).toBe(false);
    },
  );
});

describe("welcome pages", () => {
  it("link each sub-page from the parent", () => {
    const [root, ...children] = drafts(PLATFORMS[0][1]);
    const doc = markdownToDoc(root.body) as Json;
    const links = (doc.content ?? []).filter((n) => n.type === "pageLink");
    expect(links).toHaveLength(children.length);
  });
});
