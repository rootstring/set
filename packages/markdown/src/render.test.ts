import { describe, expect, it } from "vitest";
import { renderHtml, type RenderOptions } from "./render";

const published: RenderOptions = {
  pageHref: (id) => (id === "p1" ? "/blog/launch" : null),
  wikiHref: (title) => (title === "Launch" ? "/blog/launch" : null),
  assetUrl: (src) => `/media/${src.split("/").pop()}`,
};

describe("renderHtml", () => {
  it("draws a callout the way the editor does", () => {
    const html = renderHtml("> [!WARNING] Careful\n> Hot surface");
    expect(html).toContain('<div class="callout" data-kind="warning">');
    expect(html).toContain('<span class="callout-label">Careful</span>');
    expect(html).toContain('<div class="callout-body">\n<p>Hot surface</p>');
    expect(html).not.toContain("<blockquote");
  });

  it("names an untitled callout by its kind", () => {
    expect(renderHtml("> [!tip]\n> Try this")).toContain(
      '<span class="callout-label">Tip</span>',
    );
  });

  it("keeps a plain quote a quote", () => {
    expect(renderHtml("> just a quote")).toContain("<blockquote>");
  });

  it("links a published child page as a page block", () => {
    const html = renderHtml("[Launch](page:p1)", published);
    expect(html).toContain('<a class="page-link" href="/blog/launch">');
    expect(html).toContain('<span class="page-link-title">Launch</span>');
    expect(html).not.toContain("<p>");
  });

  it("leaves out a child page that isn't published", () => {
    expect(renderHtml("Before\n\n[Draft](page:p2)\n\nAfter", published)).toBe(
      "<p>Before</p>\n<p>After</p>\n",
    );
  });

  it("leaves out an unpublished child page that ends the note", () => {
    expect(renderHtml("Before\n\n[Draft](page:p2)", published)).toBe("<p>Before</p>\n");
  });

  it("keeps the words of an unpublished page link in running text", () => {
    expect(renderHtml("See [Draft](page:p2) soon", published)).toBe(
      "<p>See Draft soon</p>\n",
    );
  });

  it("draws a date as a date mention", () => {
    const html = renderHtml("Due [Sep 22, 2026](date:2026-09-22)");
    expect(html).toContain('<time class="date-mention" datetime="2026-09-22">');
    expect(html).toContain('<span class="date-mention-label">Sep 22, 2026</span></time>');
  });

  it("resolves wikilinks, and shows the rest as text", () => {
    const html = renderHtml("[[Launch#Why|the launch]] and [[Nowhere]]", published);
    expect(html).toContain('<a class="wiki-link" href="/blog/launch">');
    expect(html).toContain('<span class="wiki-link-title">the launch</span>');
    expect(html).toContain(" and Nowhere</p>");
  });

  it("typesets math, and leaves prices alone", () => {
    const html = renderHtml("$e^{i\\pi}$ costs $5 and $10\n\n$$\nx^2\n$$");
    expect(html).toContain('<span class="math-inline"><span class="katex">');
    expect(html).toContain("costs $5 and $10");
    expect(html).toContain('<div class="math-block"><div class="math-preview">');
    expect(html).toContain('class="katex-display"');
  });

  it("links footnotes both ways", () => {
    const html = renderHtml("Claim[^1]\n\n[^1]: Source *here*");
    expect(html).toContain(
      '<sup class="footnote-ref"><a href="#fn-1" id="fnref-1">1</a></sup>',
    );
    expect(html).toContain('<div class="footnote-definition" id="fn-1">');
    expect(html).toContain('<div class="footnote-body">Source <em>here</em></div>');
  });

  it("draws task lists as the editor does", () => {
    const html = renderHtml("- [x] Done\n- [ ] Todo");
    expect(html).toContain('<ul data-type="taskList">');
    expect(html).toContain(
      '<li data-checked="true">\n<label><input type="checkbox" disabled checked></label><div>Done</div></li>',
    );
    expect(html).toContain('<li data-checked="false">');
  });

  it("leaves bullet lists that aren't tasks alone", () => {
    expect(renderHtml("- one\n- two")).toBe("<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n");
  });

  it("points images at their published copy, as blocks when alone", () => {
    const html = renderHtml("![A cat](Launch/Set-page-assets/cat.png)", published);
    expect(html).toContain('<div class="image-block"><div class="image-frame"><img');
    expect(html).toContain('src="/media/cat.png"');
    expect(html).toContain('alt="A cat"');
  });

  it("points resized images, written as HTML, at their published copy", () => {
    const html = renderHtml(
      '<img src="Launch/Set-page-assets/cat.png" width="320">',
      published,
    );
    expect(html).toBe(
      '<div class="image-block"><div class="image-frame"><img src="/media/cat.png" width="320"></div></div>\n',
    );
  });

  it("highlights code the editor's colours can reach", () => {
    const html = renderHtml("```ts\nconst a = 1;\n```");
    expect(html).toContain('<span class="hljs-keyword">const</span>');
  });

  it("wraps tables so a wide one scrolls", () => {
    expect(renderHtml("| a |\n| - |\n| 1 |")).toContain(
      '<div class="tableWrapper"><table>',
    );
  });

  it("gives headings unique ids to link to", () => {
    const html = renderHtml("## Why local-first?\n\n## Why local-first?");
    expect(html).toContain('<h2 id="why-local-first">');
    expect(html).toContain('<h2 id="why-local-first-2">');
  });

  it("highlights ==marked== text", () => {
    expect(renderHtml("a ==b== c")).toBe("<p>a <mark>b</mark> c</p>\n");
  });
});
