import MarkdownIt from "markdown-it";
import katex from "katex";
import hljs from "highlight.js/lib/common";
import { setDialect } from "./dialect";
import {
  CALENDAR_ICON,
  CALLOUT_ICONS,
  PAGE_ICON,
  WIKI_LINK_ICON,
  calloutLabel,
} from "./icons";
import {
  escapeAttr,
  type MarkdownIt as Dialect,
  type StateCore,
  type Token,
} from "./types";

export interface RenderOptions {
  /**
   * Where `[Title](page:<id>)` goes, or `null` when that page isn't published. An unpublished
   * child-page block is left out; a link in running text keeps its words. Default: none published.
   */
  pageHref?: (id: string) => string | null;
  /** Where `[[Title]]` goes, by the title it names (`#section` dropped), or `null`: plain text. */
  wikiHref?: (title: string) => string | null;
  /** The URL for an image as the note wrote it, e.g. `Launch/Set-page-assets/cover.png`. */
  assetUrl?: (src: string) => string;
}

interface Env {
  render: RenderOptions;
  headingIds: Set<string>;
  [key: string]: unknown;
}

const PAGE = "page:";
const DATE = "date:";

let shared: MarkdownIt | undefined;

/**
 * A note's Markdown as HTML for reading outside Set, in the DOM the editor draws, so the same CSS
 * (`@rootstring/set-design`'s `content.css`, under `.set-content`) styles both.
 *
 * HTML in the note is passed through, as the editor keeps it: render only notes you trust.
 */
export function renderHtml(markdown: string, options: RenderOptions = {}): string {
  shared ??= createRenderer();
  const env: Env = { render: options, headingIds: new Set() };
  return shared.render(markdown, env);
}

function createRenderer(): MarkdownIt {
  const md: MarkdownIt = new MarkdownIt({
    html: true,
    highlight: (code, lang) => {
      const language = lang.trim().split(/\s+/)[0];
      if (!language || !hljs.getLanguage(language)) return "";
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    },
  });
  setDialect(md as unknown as Dialect);

  const dialect = md as unknown as Dialect;
  dialect.core.ruler.after("linkify", "set_publish", (state) => {
    const env = state.env as unknown as Env;
    taskLists(state);
    setLinks(state, env.render);
    imageBlocks(state);
    headingIds(state, env);
  });

  const escape = md.utils.escapeHtml;
  const rules = md.renderer.rules;
  const options = (env: unknown) => (env as Env).render;

  rules.image = (tokens, idx, opts, env, self) => {
    const token = tokens[idx];
    const src = token.attrGet("src") ?? "";
    token.attrSet("src", options(env).assetUrl?.(src) ?? src);
    token.attrSet("alt", self.renderInlineAsText(token.children ?? [], opts, env));
    token.attrSet("loading", "lazy");
    const html = self.renderToken(tokens, idx, opts);
    return token.meta?.block ? `<div class="image-frame">${html}</div>` : html;
  };
  // A resized image is written as `<img src width>`.
  const imgSources = (html: string, env: unknown) =>
    html.replace(/(<img\b[^>]*?\bsrc=")([^"]*)(")/gi, (_, open, src, close) => {
      const url = options(env).assetUrl?.(src) ?? src;
      return open + escapeAttr(url) + close;
    });
  rules.html_block = (tokens, idx, _opts, env) => {
    const html = imgSources(tokens[idx].content, env);
    return /^\s*<img\b[^>]*>\s*$/i.test(html)
      ? `<div class="image-block"><div class="image-frame">${html.trim()}</div></div>\n`
      : html;
  };
  rules.html_inline = (tokens, idx, _opts, env) => imgSources(tokens[idx].content, env);

  rules.table_open = () => '<div class="tableWrapper"><table>\n';
  rules.table_close = () => "</table></div>\n";

  rules.math_inline = (tokens, idx) => {
    const display = Boolean(tokens[idx].meta?.display);
    const cls = display ? "math-inline math-display" : "math-inline";
    return `<span class="${cls}">${tex(tokens[idx].content, display)}</span>`;
  };
  rules.math_block = (tokens, idx) =>
    `<div class="math-block"><div class="math-preview">${tex(tokens[idx].content, true)}</div></div>\n`;

  rules.footnote_ref = (tokens, idx) => {
    const label = escapeAttr(String(tokens[idx].meta?.label));
    return `<sup class="footnote-ref"><a href="#fn-${label}" id="fnref-${label}">${label}</a></sup>`;
  };
  rules.footnote_def = (tokens, idx, _opts, env) => {
    const label = escapeAttr(String(tokens[idx].meta?.label));
    const body = md.renderInline(tokens[idx].content, env);
    return (
      `<div class="footnote-definition" id="fn-${label}">` +
      `<a class="footnote-label" href="#fnref-${label}">${label}</a>` +
      `<div class="footnote-body">${body}</div></div>\n`
    );
  };

  rules.wikilink = (tokens, idx, _opts, env) => {
    const { target, alias } = tokens[idx].meta as {
      target: string;
      alias: string | null;
    };
    const label = escape(alias ?? target);
    const href = options(env).wikiHref?.(target.split("#")[0].trim());
    if (!href) return label;
    return (
      `<a class="wiki-link" href="${escapeAttr(href)}">` +
      `<span class="wiki-link-icon">${WIKI_LINK_ICON}</span>` +
      `<span class="wiki-link-title">${label}</span></a>`
    );
  };

  rules.callout_open = (tokens, idx) => {
    const token = tokens[idx];
    const kind = token.attrGet("data-callout") ?? "note";
    const lower = kind.toLowerCase();
    const title = token.attrGet("data-title") || calloutLabel(kind);
    return (
      `<div class="callout" data-kind="${escapeAttr(lower)}">` +
      `<div class="callout-header"><span class="callout-icon">` +
      `${CALLOUT_ICONS[lower] ?? CALLOUT_ICONS.note}</span>` +
      `<span class="callout-label">${escape(title)}</span></div>` +
      `<div class="callout-body">\n`
    );
  };
  rules.callout_close = () => "</div></div>\n";

  rules.set_page_link = (tokens, idx) => {
    const { href, title } = tokens[idx].meta as { href: string; title: string };
    return (
      `<a class="page-link" href="${escapeAttr(href)}">` +
      `<span class="page-link-icon">${PAGE_ICON}</span>` +
      `<span class="page-link-title">${escape(title)}</span></a>\n`
    );
  };
  rules.set_task_open = (tokens, idx) => {
    const checked = tokens[idx].meta?.checked ? " checked" : "";
    return `<label><input type="checkbox" disabled${checked}></label><div>`;
  };
  rules.set_task_close = () => "</div>";

  return md;
}

function tex(source: string, displayMode: boolean): string {
  return katex.renderToString(source, { displayMode, throwOnError: false });
}

/** The closing token that pairs with `tokens[open]`. */
function closeOf(tokens: Token[], open: number): number {
  const { level } = tokens[open];
  for (let i = open + 1; i < tokens.length; i++) {
    if (tokens[i].nesting === -1 && tokens[i].level === level) return i;
  }
  return -1;
}

const TASK = /^\[([ xX])\][ \t]/;

/** `- [ ] item` and `- [x] item`, drawn the way the editor draws a task list. */
function taskLists(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const item = tokens[i];
    const inline = tokens[i + 2];
    if (item.type !== "list_item_open" || inline?.type !== "inline") continue;
    const match = TASK.exec(inline.content);
    if (!match) continue;

    const first = inline.children?.[0];
    if (first?.type === "text") first.content = first.content.replace(TASK, "");
    inline.content = inline.content.replace(TASK, "");
    const checked = match[1] !== " ";
    item.attrSet("data-checked", String(checked));

    for (let j = i - 1; j >= 0; j--) {
      if (tokens[j].type === "bullet_list_open" && tokens[j].level === item.level - 1) {
        tokens[j].attrSet("data-type", "taskList");
        break;
      }
    }
    const close = closeOf(tokens, i);
    if (close < 0) continue;
    const open = new state.Token("set_task_open", "", 0);
    open.meta = { checked };
    tokens.splice(close, 0, new state.Token("set_task_close", "", 0));
    tokens.splice(i + 1, 0, open);
  }
}

/** Links to other pages and to dates, which only mean something inside Set. */
function setLinks(state: StateCore, options: RenderOptions): void {
  const tokens = state.tokens;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const inline = tokens[i];
    // Past the end when the last block was a child page that was just left out.
    if (inline?.type !== "inline" || !inline.children) continue;
    const children = inline.children;

    // A child-page block: a paragraph that is one page link and nothing else.
    const only = children.length === 3 && children[0].type === "link_open";
    const href = children[0]?.attrGet("href") ?? "";
    if (only && href.startsWith(PAGE) && tokens[i - 1]?.type === "paragraph_open") {
      const target = options.pageHref?.(decodeURIComponent(href.slice(PAGE.length)));
      const title = children[1].content;
      const replacement: Token[] = [];
      if (target) {
        const block = new state.Token("set_page_link", "", 0);
        block.meta = { href: target, title };
        block.block = true;
        replacement.push(block);
      }
      tokens.splice(i - 1, 3, ...replacement);
      continue;
    }

    for (let j = 0; j < children.length; j++) {
      const open = children[j];
      if (open.type !== "link_open") continue;
      const link = open.attrGet("href") ?? "";
      const close = closeOf(children, j);
      if (close < 0) continue;

      if (link.startsWith(DATE)) {
        const iso = decodeURIComponent(link.slice(DATE.length));
        toHtml(
          open,
          `<time class="date-mention" datetime="${escapeAttr(iso)}">` +
            `<span class="date-mention-icon">${CALENDAR_ICON}</span>` +
            `<span class="date-mention-label">`,
        );
        toHtml(children[close], "</span></time>");
      } else if (link.startsWith(PAGE)) {
        const target = options.pageHref?.(decodeURIComponent(link.slice(PAGE.length)));
        if (target) {
          open.attrSet("href", target);
        } else {
          toHtml(open, "");
          toHtml(children[close], "");
        }
      }
    }
  }
}

function toHtml(token: Token, html: string): void {
  token.type = "html_inline";
  token.content = html;
  token.attrs = null;
}

/** An image alone in its paragraph is a block, as in the editor. */
function imageBlocks(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 1; i < tokens.length - 1; i++) {
    const inline = tokens[i];
    const children = inline.children ?? [];
    if (
      inline.type !== "inline" ||
      children.length !== 1 ||
      children[0].type !== "image"
    ) {
      continue;
    }
    if (tokens[i - 1].type !== "paragraph_open") continue;
    tokens[i - 1].tag = "div";
    tokens[i - 1].attrSet("class", "image-block");
    tokens[i + 1].tag = "div";
    children[0].meta = { ...children[0].meta, block: true };
  }
}

/** `## Why local-first` → `id="why-local-first"`, so a section can be linked to. */
function headingIds(state: StateCore, env: Env): void {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "heading_open") continue;
    const text = tokens[i + 1]?.content ?? "";
    const base =
      text
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "") || "section";
    let id = base;
    for (let n = 2; env.headingIds.has(id); n++) id = `${base}-${n}`;
    env.headingIds.add(id);
    tokens[i].attrSet("id", id);
  }
}
