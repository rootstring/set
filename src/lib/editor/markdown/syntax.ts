import markPlugin from "markdown-it-mark";
import { registerExtras } from "./syntax-extras";
import {
  escapeAttr,
  wrapRule,
  type InlineRule,
  type BlockRule,
  type MarkdownIt,
  type StateCore,
  type Token,
} from "./types";

/**
 * Parsing goes Markdown → HTML → schema, and the schema loses what it has no node for. So the
 * syntax used is stamped as `data-md` for `serialize.ts`, and anything unrepresentable goes to a
 * raw node. `parse.setup` runs before every parse, so configure once.
 */
const configured = new WeakSet<MarkdownIt>();

/** Block-level HTML that Set itself writes, and so reads through the DOM. */
const DOM_BLOCK_TAGS = new Set(["details", "summary", "table"]);

/** Inline HTML the editor has a mark or node for. Everything else is raw. */
const DOM_INLINE_TAGS = new Set(["u", "sub", "sup"]);

/** Tags that are formatting marks in the editor; their HTML form is recorded. */
const FORMAT_TAGS = new Set([
  "strong",
  "b",
  "em",
  "i",
  "s",
  "del",
  "strike",
  "code",
  "mark",
]);

const TAG = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)(\s[^>]*?)?\s*(\/?)>$/;

export function setSyntax(md: MarkdownIt): void {
  if (configured.has(md)) return;
  configured.add(md);

  md.use(markPlugin as unknown as (md: MarkdownIt) => void);
  configureLinkify(md);
  recordBreaks(md);
  recordReferences(md);
  registerExtras(md);
  md.core.ruler.before("text_join", "set_markup", stampMarkup);
  md.core.ruler.after("set_markup", "set_spacers", injectSpacers);

  const escape = md.utils.escapeHtml;
  const rules = md.renderer.rules;

  rules.html_block = (tokens, idx) => {
    const source = tokens[idx].content;
    return isDomBlock(source)
      ? source
      : `<div data-raw-block="">${escape(source.replace(/\n+$/, ""))}</div>`;
  };
  rules.html_inline = (tokens, idx) => {
    const token = tokens[idx];
    const markup = token.meta?.markup;
    if (typeof markup === "string") {
      const name = TAG.exec(markup)?.[2]?.toLowerCase() ?? "span";
      return `<${name} data-md="${escapeAttr(markup)}">`;
    }
    if (token.meta?.dom) return token.content;
    return `<span data-raw-inline="${escapeAttr(token.content)}"></span>`;
  };
  // Looks like a space, written back as the newline it was.
  rules.softbreak = () => '<span data-soft-break=""></span>';
  rules.hardbreak = (tokens, idx) => {
    const markup = tokens[idx].markup;
    return markup && markup !== "\\" ? `<br data-md="${escapeAttr(markup)}">` : "<br>";
  };
  rules.md_entity = (tokens, idx) =>
    `<span data-entity="${escapeAttr(tokens[idx].markup)}">${escape(tokens[idx].content)}</span>`;
  rules.link_definition = (tokens, idx) =>
    `<div data-raw-block="" data-kind="definition">${escape(tokens[idx].content)}</div>`;
  // See `injectSpacers`.
  rules.set_spacer = () => "<p></p>";
}

/** Set's own HTML blocks go through the DOM; anything else is kept exactly. */
function isDomBlock(source: string): boolean {
  const tag = /^\s*<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(source)?.[1]?.toLowerCase();
  if (!tag) return false;
  if (DOM_BLOCK_TAGS.has(tag)) return true;
  return tag === "img" && /^\s*<img\b[^>]*>\s*$/i.test(source);
}

/** Only URLs that say they are; a fuzzy match turns every `README.md` into a link. */
function configureLinkify(md: MarkdownIt): void {
  md.set({ linkify: true });
  md.linkify.set({ fuzzyLink: false });
  md.linkify.add("www.", {
    validate(text: string, pos: number, self: { re: Record<string, string | RegExp> }) {
      self.re.set_www ??= new RegExp(
        `^${self.re.src_host_port_strict as string}${self.re.src_path as string}`,
        "i",
      );
      const match = (self.re.set_www as RegExp).exec(text.slice(pos));
      return match ? match[0].length : 0;
    },
    normalize(match: { url: string }) {
      match.url = `http://${match.url}`;
    },
  });
}

/** Which of the two hard-break spellings was used: trailing spaces or `\`. */
function recordBreaks(md: MarkdownIt): void {
  const ruler = md.inline.ruler;
  wrapRule<InlineRule>(ruler, "newline", (original) => (state, silent) => {
    const spaces = / {2,}$/.exec(state.pending)?.[0];
    const before = state.tokens.length;
    const ok = original(state, silent);
    if (ok && !silent && spaces) {
      for (let i = before; i < state.tokens.length; i++) {
        if (state.tokens[i].type === "hardbreak") state.tokens[i].markup = spaces;
      }
    }
    return ok;
  });
  wrapRule<InlineRule>(ruler, "escape", (original) => (state, silent) => {
    const before = state.tokens.length;
    const ok = original(state, silent);
    if (ok && !silent) {
      for (let i = before; i < state.tokens.length; i++) {
        if (state.tokens[i].type === "hardbreak") state.tokens[i].markup = "\\";
      }
    }
    return ok;
  });
}

/**
 * Definitions stay as raw blocks; each link records its form so an untouched link is written back
 * as `[text][r]`.
 */
function recordReferences(md: MarkdownIt): void {
  wrapRule<BlockRule>(
    md.block.ruler,
    "reference",
    (original) => (state, start, end, silent) => {
      const ok = original(state, start, end, silent);
      if (ok && !silent) {
        const token = state.push("link_definition", "", 0);
        token.map = [start, state.line];
        token.block = true;
        token.content = state
          .getLines(start, state.line, state.blkIndent, false)
          .replace(/\n+$/, "");
      }
      return ok;
    },
  );

  // Definitions on consecutive lines are one block, not one block each.
  md.core.ruler.after("block", "set_definitions", (state) => {
    const kept: Token[] = [];
    for (const token of state.tokens) {
      const prev = kept[kept.length - 1];
      if (
        token.type === "link_definition" &&
        prev?.type === "link_definition" &&
        prev.level === token.level &&
        prev.map &&
        token.map &&
        prev.map[1] === token.map[0]
      ) {
        prev.content += `\n${token.content}`;
        prev.map[1] = token.map[1];
        continue;
      }
      kept.push(token);
    }
    state.tokens.splice(0, state.tokens.length, ...kept);
  });

  wrapRule<InlineRule>(md.inline.ruler, "link", (original) => (state, silent) => {
    const start = state.pos;
    const before = state.tokens.length;
    const ok = original(state, silent);
    if (!ok || silent) return ok;
    // Text waiting in front of the link is pushed first, so look past it.
    const open = state.tokens.slice(before).find((token) => token.type === "link_open");
    if (!open) return ok;

    const labelEnd = state.md.helpers.parseLinkLabel(state, start, true);
    if (labelEnd < 0) return ok;
    const after = state.src.slice(labelEnd + 1, state.pos);
    if (after.startsWith("(")) return ok;

    const text = state.src.slice(start + 1, labelEnd);
    const form = after === "" ? "shortcut" : after === "[]" ? "collapsed" : "full";
    open.attrSet("data-md-ref", form);
    open.attrSet("data-md-label", form === "full" ? after.slice(1, -1) : text);
    open.attrSet("data-md-href", open.attrGet("href") ?? "");
    return ok;
  });
}

function fenceLength(content: string, char: string): number {
  const runs = content.match(char === "~" ? /~+/g : /`+/g);
  const longest = runs ? Math.max(...runs.map((run) => run.length)) : 0;
  return Math.max(3, longest + 1);
}

/** Items of an ordered list that all carry the same number (`1.`, `1.`, …). */
function sameNumbered(tokens: Token[], index: number): boolean {
  const list = tokens[index];
  const numbers: number[] = [];
  for (let i = index + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === "ordered_list_close" && token.level === list.level) break;
    if (token.type === "list_item_open" && token.level === list.level + 1) {
      numbers.push(Number(token.info));
    }
  }
  return numbers.length > 1 && numbers.every((n) => n === numbers[0]);
}

/** A block at the top level of the file, with where its source sits. */
interface TopBlock {
  /** Index of the block's opening token. */
  index: number;
  token: Token;
  /** First source line of the block. */
  start: number;
  /**
   * One past its last line. A list runs on past the blank lines it swallowed; `gapBetween` walks
   * back over them.
   */
  end: number;
  /** How many of Set's own HTML containers are open after this block. */
  depth: number;
}

/** The list openings prosemirror-markdown keeps two blank lines between. */
const LIST_OPEN = new Set(["bullet_list_open", "ordered_list_open"]);

/**
 * Blank lines past the separator become empty paragraphs (the way back is `paragraph` in
 * `serialize.ts`). Top level only: inside a list a blank line already means loose.
 */
function injectSpacers(state: StateCore): void {
  const blank = state.src.split("\n").map((line) => line.trim() === "");
  const blocks = topBlocks(state.tokens);
  const runs: { at: number; count: number }[] = [];

  for (let i = 1; i < blocks.length; i++) {
    const prev = blocks[i - 1];
    const next = blocks[i];
    // Inside a toggle, skip it.
    if (prev.depth > 0) continue;
    const count = gapBetween(blank, prev, next) - separator(prev, next);
    if (count > 0) runs.push({ at: next.index, count });
  }

  // Back to front, so an insertion doesn't move the next one's index.
  for (const { at, count } of runs.reverse()) {
    const spacers = Array.from(
      { length: count },
      () => new state.Token("set_spacer", "p", 0),
    );
    state.tokens.splice(at, 0, ...spacers);
  }
}

/** Every block that sits at the top level of the file, in source order. */
function topBlocks(tokens: Token[]): TopBlock[] {
  const blocks: TopBlock[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    // Openings and blocks that stand alone; a closing token has no map.
    if (token.level !== 0 || token.nesting < 0 || !token.map) continue;
    if (token.type === "html_block")
      depth = Math.max(0, depth + containerDelta(token.content));
    blocks.push({
      index: i,
      token,
      start: token.map[0],
      end: token.map[1],
      depth,
    });
  }
  return blocks;
}

/** A toggle opens in one block and closes in another; the blank lines between are the toggle's. */
function containerDelta(source: string): number {
  let delta = 0;
  for (const [, closing, name] of source.matchAll(/<(\/?)([A-Za-z][A-Za-z0-9-]*)/g)) {
    if (name.toLowerCase() !== "details" && name.toLowerCase() !== "table") continue;
    delta += closing ? -1 : 1;
  }
  return delta;
}

/** How many blank lines the file has between two blocks. */
function gapBetween(blank: boolean[], prev: TopBlock, next: TopBlock): number {
  let end = prev.end;
  while (end > prev.start && blank[end - 1]) end--;
  return next.start - end;
}

/**
 * Two lists of a kind need two blank lines (`flushClose(3)`). A task list touching a bullet list is
 * still lost; rare enough to leave.
 */
function separator(prev: TopBlock, next: TopBlock): number {
  const type = prev.token.type;
  return type === next.token.type && LIST_OPEN.has(type) ? 2 : 1;
}

/** Only what differs from what Set would write anyway. */
function stampMarkup(state: StateCore): void {
  const lines = state.src.split("\n");
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case "heading_open": {
        if ((token.markup === "=" || token.markup === "-") && token.map) {
          const underline = /[=-]+\s*$/.exec(lines[token.map[1] - 1] ?? "")?.[0].trim();
          if (underline) token.attrSet("data-md", underline);
        }
        break;
      }
      case "fence": {
        const char = token.markup[0];
        if (char === "~" || token.markup.length > fenceLength(token.content, char)) {
          token.attrSet("data-md", token.markup);
        }
        const info = token.info.trim();
        if (info && info !== info.split(/\s+/)[0]) token.attrSet("data-md-info", info);
        break;
      }
      case "code_block":
        token.attrSet("data-md", "indented");
        break;
      case "bullet_list_open":
        if (token.markup !== "-") token.attrSet("data-md", token.markup);
        break;
      case "ordered_list_open":
        // Always: two lists that touch have to keep their different delimiters.
        token.attrSet("data-md", token.markup);
        if (sameNumbered(tokens, i)) token.attrSet("data-md-numbering", "same");
        break;
      case "hr":
        if (token.markup !== "---") token.attrSet("data-md", token.markup);
        break;
      case "inline":
        stampInline(token.children ?? []);
        break;
    }
  }
}

function stampInline(children: Token[]): void {
  const open: { name: string; token: Token }[] = [];
  for (const token of children) {
    switch (token.type) {
      case "em_open":
      case "strong_open":
        if (token.markup === "_" || token.markup === "__")
          token.attrSet("data-md", token.markup);
        break;
      case "link_open":
        if (token.markup === "autolink" || token.markup === "linkify") {
          token.attrSet("data-md", token.markup);
        }
        break;
      case "text_special":
        // Except `&lt;` and `&gt;`, which Set writes itself.
        if (
          token.info === "entity" &&
          token.markup !== "&lt;" &&
          token.markup !== "&gt;"
        ) {
          token.type = "md_entity";
        }
        break;
      case "html_inline":
        pairInlineHtml(token, open);
        break;
    }
  }
}

/**
 * Only matched pairs of tags the editor has a mark for reach the DOM; anything else stays raw so
 * the file gains no closing tag it never had.
 */
function pairInlineHtml(token: Token, open: { name: string; token: Token }[]): void {
  const match = TAG.exec(token.content);
  if (!match) return;
  const [, closing, raw, attrs] = match;
  const name = raw.toLowerCase();

  if (!closing && name === "br" && !attrs?.trim()) {
    token.meta = { dom: true };
    return;
  }
  if (!closing && name === "img") {
    if (/\bsrc\s*=/.test(attrs ?? "")) token.meta = { dom: true };
    return;
  }
  // The task-list plugin's own checkbox, not HTML the note wrote.
  if (!closing && name === "input" && /\btask-list-item-checkbox\b/.test(attrs ?? "")) {
    token.meta = { dom: true };
    return;
  }
  const format = FORMAT_TAGS.has(name);
  if (!format && !DOM_INLINE_TAGS.has(name)) return;
  if (!closing) {
    if (!attrs?.trim()) open.push({ name, token });
    return;
  }
  for (let i = open.length - 1; i >= 0; i--) {
    if (open[i].name !== name) continue;
    const opener = open.splice(i, 1)[0].token;
    opener.meta = format ? { markup: opener.content } : { dom: true };
    token.meta = { dom: true };
    return;
  }
}
