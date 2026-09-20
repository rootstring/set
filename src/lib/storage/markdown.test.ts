// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { docToMarkdown, markdownToDoc } from "./markdown";

function roundTrip(markdown: string): string {
  return docToMarkdown(markdownToDoc(markdown)).replace(/\n+$/, "");
}

const SET_NATIVE: [string, string][] = [
  ["paragraphs", "One paragraph.\n\nAnother one."],
  ["headings", "# One\n\n## Two\n\n### Three"],
  ["inline marks", "**bold** *italic* ~~strike~~ `code` <u>under</u>"],
  ["nested marks", "***both*** and **bold *inner***"],
  ["link", "[a link](https://example.com)"],
  ["link with title", '[a](https://example.com "Title")'],
  ["plain url link", "<https://example.com>"],
  ["bullet list", "- one\n- two\n  - nested"],
  ["ordered list", "1. one\n2. two"],
  ["ordered from three", "3. three\n4. four"],
  ["adjacent ordered lists", "1. a\n\n\n1) b"],
  ["loose list", "- a\n\n- b"],
  ["task list as Set writes it", "- [ ] todo\n\n- [x] done"],
  ["blockquote", "> quoted\n>\n> > nested"],
  ["code block", "```js\nconst x = 1\n```"],
  ["code block holding a fence", "````md\n```js\nx\n```\n````"],
  ["divider", "above\n\n---\n\nbelow"],
  ["toggle", "<details open>\n<summary>plans</summary>\n\nship it\n\n\n</details>"],
  ["closed toggle", "<details>\n<summary>later</summary>\n\nhidden\n\n\n</details>"],
  ["image", "![sunset](Page/Set-page-assets/k3m9.png)"],
  ["resized image", '<img src="Page/Set-page-assets/k3m9.png" alt="sunset" width="300">'],
  ["child page", "[Child page](page:abc123)"],
  ["hard break", "line\\\nnext"],
  ["escaped emphasis", "not \\*emphasis\\*"],
  ["link written as text", "\\[bad\\](javascript:alert(1))"],
  ["table", "| a | b |\n| --- | --- |\n| 1 | 2 |"],
  ["aligned table", "| L | C | R |\n| :--- | :---: | ---: |\n| a \\| b | **x** | 3 |"],
  ["table with a break", "| one<br>two |  |\n| --- | --- |\n|  |  |"],
  [
    "html table",
    '<table>\n<tr><td>a</td><td>b</td></tr>\n<tr><td colspan="2">wide</td></tr>\n</table>',
  ],
  ["list inside a quote", "> - a\n> - b"],
  ["a blank line between blocks", "one\n\n\ntwo"],
  ["several blank lines", "one\n\n\n\n\ntwo"],
  ["a blank line before a heading", "text\n\n\n## Next"],
  ["a blank line after a list", "- a\n- b\n\n\nafter"],
  ["a blank line after a quote", "> q\n\n\nafter"],
  ["a blank line after a fence", "```js\nx\n```\n\n\nafter"],
  ["a blank line after a table", "| a |\n| --- |\n| 1 |\n\n\nafter"],
  [
    "a blank line after a toggle",
    "<details>\n<summary>s</summary>\n\nbody\n\n\n</details>\n\n\nafter",
  ],
  ["blank lines around a divider", "one\n\n\n---\n\n\ntwo"],
];

const FROM_ELSEWHERE: [string, string][] = [
  ["h4 to h6", "#### Four\n\n##### Five\n\n###### Six"],
  ["setext headings", "Title\n=====\n\nSub\n---\n\nafter"],
  ["underscore emphasis", "_em_ and __strong__"],
  ["hard-wrapped paragraph", "one line\nwrapped here\nand here"],
  ["two-space break", "line  \nnext"],
  ["indented code", "    code line\n    second"],
  ["tilde fence", "~~~py\nprint(1)\n~~~"],
  ["fence with a full info string", '```js title="a.js"\nx\n```'],
  ["star bullets", "* a\n* b"],
  ["plus bullets", "+ a\n+ b"],
  ["ordered with parens", "1) a\n2) b"],
  ["all-ones numbering", "1. a\n1. b\n1. c"],
  ["star rule", "a\n\n***\n\nb"],
  ["tight task list", "- [ ] todo\n- [x] done"],
  ["wrapped list item", "- one\n  continued"],
  ["wrapped quote", "> one\n> two"],
  ["image inside a line", "text ![alt](https://example.com/i.png) text"],
  ["full reference link", "[a][r]\n\n[r]: https://example.com"],
  ["collapsed reference link", "[a][]\n\n[a]: https://example.com"],
  ["shortcut reference link", '[a]\n\n[a]: https://example.com "T"'],
  ["consecutive definitions", "[a][x] [b][y]\n\n[x]: https://x.com\n[y]: https://y.com"],
  ["mail autolink", "<me@example.com>"],
  ["inline html", "press <kbd>Ctrl</kbd> and H<sub>2</sub>O and x<sup>2</sup>"],
  [
    "html formatting tags",
    "<b>bold</b> <i>it</i> <del>gone</del> <mark>hi</mark> <code>c</code>",
  ],
  ["html block", '<div align="center">\n\ncentered\n\n</div>'],
  ["html comment", "<!-- note to self -->\n\ntext"],
  ["inline comment", "a <!-- c --> b"],
  ["entities", "&copy; 2026 &amp; co &#8212; x"],
  ["brackets in prose", "not \\*emphasis\\* and array[0] and [not a link]"],
  ["bare url", "see https://example.com/a_b_c and www.example.com"],
  ["bare email", "mail me@example.com today"],
  ["footnote", "Claim[^1]\n\n[^1]: Source."],
  ["footnote with a continuation", "A[^n]\n\n[^n]: First line\n    more of it"],
  ["wikilinks", "[[Other page]] and [[Other page|alias]]"],
  ["github alert", "> [!NOTE]\n> Useful."],
  ["alert with a blank line", "> [!WARNING]\n>\n> Careful."],
  ["obsidian callout", "> [!tip]- Title here\n> Body"],
  ["highlight", "==marked=="],
  ["dollars in prose", "costs $5 and $10, and $E = mc^2$ is an equation"],
  ["inline math", "Euler: $e^{i\\pi} + 1 = 0$, and $$\\sum_{i} x_i$$ on display"],
  ["dollars inside math", "$\\$5 + \\$6$"],
  ["math block", "$$\n\\int_0^1 x\\,dx = \\frac{1}{2}\n$$"],
  ["one-line math block", "$$E = mc^2$$"],
  ["math block in a quote", "> $$\n> x\n> $$"],
  ["math block in a list", "- item\n\n  $$\n  x\n  $$"],
  ["unclosed dollars", "$$\nnot math"],
  ["mermaid", "```mermaid\ngraph TD; A-->B\n```"],
  ["heading id", "## Title {#custom-id}"],
  ["empty alert", "> [!NOTE]"],
  ["wikilink in a table", "| [[Page\\|alias]] |\n| --- |\n| x |"],
];

describe("Markdown from elsewhere survives a load and a save", () => {
  it.each(FROM_ELSEWHERE)("%s", (_name, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });
});

const TYPED: string[] = [
  "$x$",
  "a $b$ c",
  "$$x$$",
  "a==b==c",
  "[[Page]]",
  "[a](b)",
  "[a][b]",
  "[^1]",
  "&copy;",
  "array[0] and [x]",
  "<kbd>",
  "costs $5",
  "$a$b$c$",
  "$$",
  "a == b",
  "x_y_z",
];

describe("text that looks like syntax stays text", () => {
  it.each(TYPED)("%s", (text) => {
    const doc = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    };
    const markdown = docToMarkdown(doc as never);
    const back = markdownToDoc(markdown) as {
      content?: { content?: { text?: string }[] }[];
    };
    const inline = back.content?.[0]?.content ?? [];
    expect(inline.map((node) => node.text ?? "").join("")).toBe(text);
    expect(inline.every((node) => "text" in node)).toBe(true);
  });
});

type Json = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: Json[];
};

function find(node: Json, type: string): Json | undefined {
  if (node.type === type) return node;
  for (const child of node.content ?? []) {
    const hit = find(child, type);
    if (hit) return hit;
  }
  return undefined;
}

const paragraph = (...content: Json[]): Json => ({
  type: "doc",
  content: [{ type: "paragraph", content }],
});

describe("math", () => {
  it("a price is prose, a formula an equation", () => {
    const doc = markdownToDoc("costs $5 and $10, and $E = mc^2$") as Json;
    const inline = doc.content![0].content!;
    expect(inline.map((node) => node.type)).toEqual(["text", "mathInline"]);
    expect(inline[0].text).toBe("costs $5 and $10, and ");
    expect(inline[1].attrs).toEqual({ source: "E = mc^2", display: false });
  });

  it("$$ on its own lines is a block, holding its source as written", () => {
    const doc = markdownToDoc("$$\n  a \\\\\n  b\n$$") as Json;
    expect(doc.content![0].type).toBe("mathBlock");
    expect(doc.content![0].attrs!.source).toBe("  a \\\\\n  b");
  });

  it("$$ cuts a paragraph short, as a fence does", () => {
    const doc = markdownToDoc("text\n$$\nx\n$$") as Json;
    expect(doc.content!.slice(0, 2).map((node) => node.type)).toEqual([
      "paragraph",
      "mathBlock",
    ]);
  });

  it("a $$ line that never closes stays a paragraph", () => {
    const doc = markdownToDoc("$$\nstill text") as Json;
    expect(doc.content!.map((node) => node.type)).toEqual(["paragraph"]);
    expect(find(doc, "mathInline")).toBeUndefined();
  });

  it("an equation typed in the editor is written the way Set writes it", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "so " },
            { type: "mathInline", attrs: { source: "a^2 + b^2 = c^2", display: false } },
          ],
        },
        { type: "mathBlock", attrs: { source: "\\sum_{n=1}^\\infty" } },
        { type: "mathBlock", attrs: { source: "" } },
      ],
    };
    expect(docToMarkdown(doc as never).trim()).toBe(
      "so $a^2 + b^2 = c^2$\n\n$$\n\\sum_{n=1}^\\infty\n$$\n\n$$\n$$",
    );
  });

  it("a dollar inside an equation's source is escaped for the file", () => {
    const doc = paragraph({
      type: "mathInline",
      attrs: { source: "a$b", display: false },
    });
    expect(docToMarkdown(doc as never).trim()).toBe("$a\\$b$");
    expect(find(markdownToDoc("$a\\$b$") as Json, "mathInline")!.attrs!.source).toBe(
      "a\\$b",
    );
  });
});

describe("edits keep the file valid", () => {
  it("a reference link whose address changed is written inline", () => {
    const doc = markdownToDoc("[a][r]\n\n[r]: https://example.com") as Json;
    const text = find(doc, "text")!;
    text.marks![0].attrs = { ...text.marks![0].attrs, href: "https://other.com" };
    expect(docToMarkdown(doc as never).trim()).toBe(
      "[a](https://other.com)\n\n[r]: https://example.com",
    );
  });

  it("a reference link whose definition was deleted is written inline", () => {
    const doc = markdownToDoc("[a][r]\n\n[r]: https://example.com") as Json;
    doc.content = doc.content!.filter((node) => node.type !== "rawBlock");
    expect(docToMarkdown(doc as never).trim()).toBe("[a](https://example.com)");
  });

  it("underscore emphasis pressed against a letter becomes a star", () => {
    const doc = paragraph(
      { type: "text", text: "a" },
      { type: "text", text: "em", marks: [{ type: "italic", attrs: { markup: "_" } }] },
    );
    expect(docToMarkdown(doc as never).trim()).toBe("a*em*");
  });

  it("a wrapped line that starts like a list item stays in the paragraph", () => {
    const doc = paragraph(
      { type: "text", text: "a" },
      { type: "softBreak" },
      { type: "text", text: "- x" },
    );
    const markdown = docToMarkdown(doc as never).trim();
    expect(markdown).toBe("a\n\\- x");
    expect((markdownToDoc(markdown) as Json).content?.map((node) => node.type)).toEqual([
      "paragraph",
    ]);
  });

  it("a setext heading moved to level three is written with hashes", () => {
    const doc = markdownToDoc("Title\n=====") as Json;
    find(doc, "heading")!.attrs!.level = 3;
    expect(docToMarkdown(doc as never).trim()).toBe("### Title");
  });

  it("new content is written the way Set always wrote it", () => {
    const doc = paragraph(
      { type: "text", text: "b", marks: [{ type: "bold" }] },
      { type: "text", text: " " },
      { type: "text", text: "i", marks: [{ type: "italic" }] },
      { type: "hardBreak" },
      { type: "text", text: "n" },
    );
    expect(docToMarkdown(doc as never).trim()).toBe("**b** *i*\\\nn");
  });
});

describe("Set's own Markdown survives a load and a save", () => {
  it.each(SET_NATIVE)("%s", (_name, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it("date mention", () => {
    const once = roundTrip("Due [someday](date:2020-01-15)");
    expect(once).toMatch(/^Due \[[^\]]+\]\(date:2020-01-15\)$/);
    expect(roundTrip(once)).toBe(once);
  });

  it("date mention with a time", () => {
    const once = roundTrip("Call [someday](date:2020-01-15T15:30)");
    expect(once).toMatch(/^Call \[[^\]]+\]\(date:2020-01-15T15:30\)$/);
    expect(roundTrip(once)).toBe(once);
  });

  it("date mention this version can't read", () => {
    const markdown = "Call [2020-W03](date:2020-W03)";
    expect(roundTrip(markdown)).toBe(markdown);
  });
});

describe("empty paragraphs between blocks", () => {
  const para = (text?: string) =>
    text
      ? { type: "paragraph", content: [{ type: "text", text }] }
      : { type: "paragraph" };

  function blocks(doc: Json): string {
    return (doc.content ?? [])
      .map((node) => (node.type === "paragraph" && !node.content ? "·" : node.type))
      .join(" ");
  }

  function reload(content: unknown[]): string {
    return blocks(
      markdownToDoc(docToMarkdown({ type: "doc", content } as never)) as Json,
    );
  }

  it("keeps one", () => {
    expect(reload([para("one"), para(), para("two")])).toBe("paragraph · paragraph");
  });

  it("keeps several", () => {
    expect(reload([para("one"), para(), para(), para(), para("two")])).toBe(
      "paragraph · · · paragraph",
    );
  });

  it("keeps one after a list", () => {
    const list = {
      type: "bulletList",
      attrs: { tight: true },
      content: [{ type: "listItem", content: [para("a")] }],
    };
    expect(reload([list, para(), para("after")])).toBe("bulletList · paragraph");
  });

  it("writes a blank line for each one", () => {
    expect(
      docToMarkdown({ type: "doc", content: [para("a"), para(), para("b")] } as never),
    ).toBe("a\n\n\nb");
  });

  it("writes nothing at the end of a page", () => {
    expect(
      docToMarkdown({ type: "doc", content: [para("a"), para(), para()] } as never),
    ).toBe("a");
  });

  it("writes nothing for a page that is all empty", () => {
    expect(
      docToMarkdown({ type: "doc", content: [para(), para(), para()] } as never),
    ).toBe("");
  });

  it.each([
    ["a loose list", "- a\n\n- b", "bulletList"],
    ["a blank line in a quote", "> q\n>\n> more", "blockquote"],
    [
      "a toggle's own blank line",
      "<details>\n<summary>s</summary>\n\nbody\n\n\n</details>",
      "details",
    ],
    ["two lists that touch", "1. a\n\n\n1) b", "orderedList orderedList"],
  ])("leaves %s alone", (_name, markdown, expected) => {
    expect(blocks(markdownToDoc(markdown) as Json).replace(/ ·$/, "")).toBe(expected);
  });
});
