import type { Mark, Node as PMNode } from "@tiptap/pm/model";
import type { SetMarkdownState } from "./state";
import { mathSpanAt } from "@rootstring/set-markdown";

/**
 * With no recorded syntax the output is what tiptap-markdown wrote; recorded `markup` (see
 * `syntax.ts`) is written back as it came.
 */

export type NodeSerializer = (
  state: SetMarkdownState,
  node: PMNode,
  parent: PMNode,
  index: number,
) => void;

type Delimiter =
  | string
  | ((state: SetMarkdownState, mark: Mark, parent: PMNode, index: number) => string);

export interface MarkSerializer {
  open: Delimiter;
  close: Delimiter;
  mixable?: boolean;
  expelEnclosingWhitespace?: boolean;
  escape?: boolean;
}

const isTag = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("<");

const closingTag = (open: string) =>
  `</${/^<([A-Za-z][A-Za-z0-9-]*)/.exec(open)?.[1] ?? "span"}>`;

const delimiter = (
  value: Delimiter,
  state: SetMarkdownState,
  mark: Mark,
  parent: PMNode,
  index: number,
) => (typeof value === "string" ? value : value(state, mark, parent, index));

export function nodeOverrides(
  base: Record<string, NodeSerializer>,
): Record<string, NodeSerializer> {
  const list: NodeSerializer = (state, node) =>
    state.renderList(node, "  ", () => `${(node.attrs.markup as string | null) || "-"} `);

  return {
    text: serializeText,

    paragraph(state, node, parent, index) {
      const spacer = node.content.size === 0 && parent.type.name === "doc";
      // A blank line at either end of a file is not read back.
      const before = spacer ? filled(parent, index, -1) : null;
      const after = before ? filled(parent, index, 1) : null;
      if (!before || !after) {
        base.paragraph(state, node, parent, index);
        return;
      }
      // An empty paragraph writes nothing, so write its blank line; `injectSpacers` reads it back.
      state.write();
      // Two lists of a kind are separated by two blank lines (`flushClose(3)`); close on the list
      // so this blank line sits on top of that.
      const pair = before.type === after.type && LIST_NODES.has(before.type.name);
      state.closeBlock(pair ? before : node);
    },

    heading(state, node, parent, index) {
      const underline = node.attrs.markup;
      const setext =
        typeof underline === "string" &&
        /^(=+|-+)$/.test(underline) &&
        node.attrs.level === (underline[0] === "=" ? 1 : 2);
      if (!setext) {
        base.heading(state, node, parent, index);
        return;
      }
      state.renderInline(node);
      state.ensureNewLine();
      state.write(underline);
      state.closeBlock(node);
    },

    bulletList: list,
    taskList: list,

    orderedList(state, node, parent, index) {
      const start = (node.attrs.start as number) || 1;
      const same = node.attrs.numbering === "same";
      const last = same ? start : start + node.childCount - 1;
      const width = String(last).length;
      const markup = node.attrs.markup;
      const separator =
        markup === ")"
          ? ") "
          : markup === "."
            ? ". "
            : adjacentIndex(node, parent, index) % 2
              ? ") "
              : ". ";
      state.renderList(node, state.repeat(" ", width + 2), (i) => {
        const number = String(same ? start : start + i);
        return state.repeat(" ", width - number.length) + number + separator;
      });
    },

    hardBreak(state, node, parent, index) {
      for (let i = index + 1; i < parent.childCount; i++) {
        if (parent.child(i).type === node.type) continue;
        const markup = node.attrs.markup;
        if (state.inTable) state.write("<br>");
        else if (typeof markup === "string" && markup.trim() === "")
          state.write(`${markup}\n`);
        else state.write("\\\n");
        return;
      }
    },
  };
}

/** The nodes prosemirror-markdown writes through `renderList`. */
const LIST_NODES = new Set(["bulletList", "orderedList", "taskList"]);

/** The nearest sibling in `step`'s direction that isn't an empty paragraph. */
function filled(parent: PMNode, index: number, step: 1 | -1): PMNode | null {
  for (let i = index + step; i >= 0 && i < parent.childCount; i += step) {
    const child = parent.child(i);
    if (child.type.name !== "paragraph" || child.content.size > 0) return child;
  }
  return null;
}

/** How many ordered lists sit directly before this one (tiptap-markdown's rule). */
function adjacentIndex(node: PMNode, parent: PMNode, index: number): number {
  let i = 0;
  for (; index - i > 0; i++) {
    if (parent.child(index - i - 1).type.name !== node.type.name) break;
  }
  return i;
}

export function markOverrides(
  base: Record<string, MarkSerializer>,
): Record<string, MarkSerializer> {
  return {
    italic: emphasis("italic", "*", "_", base.italic),
    bold: emphasis("bold", "**", "__", base.bold),
    strike: tagged("strike", base.strike, "~~"),
    highlight: tagged(
      "highlight",
      { open: "==", close: "==", mixable: true, expelEnclosingWhitespace: true },
      "==",
    ),
    code: {
      ...base.code,
      open: (state, mark, parent, index) =>
        isTag(mark.attrs.markup)
          ? mark.attrs.markup
          : delimiter(base.code.open, state, mark, parent, index),
      close: (state, mark, parent, index) =>
        isTag(mark.attrs.markup)
          ? closingTag(mark.attrs.markup)
          : delimiter(base.code.close, state, mark, parent, index),
    },
    link: link(base.link),
  };
}

/** A mark written either with Markdown delimiters or as the HTML tag it came as. */
function tagged(name: string, base: MarkSerializer, markdown: string): MarkSerializer {
  return {
    ...base,
    open: (state, mark) =>
      state.pushChosen(name, isTag(mark.attrs.markup) ? mark.attrs.markup : markdown),
    close: (state) => {
      const open = state.popChosen(name, markdown);
      return isTag(open) ? closingTag(open) : open;
    },
  };
}

/** An underscore cannot open or close inside a word, so falls back to `*`. */
function emphasis(
  name: string,
  star: string,
  underscore: string,
  base: MarkSerializer,
): MarkSerializer {
  return {
    ...base,
    open(state, mark, parent, index) {
      const markup = mark.attrs.markup;
      let chosen = star;
      if (isTag(markup)) chosen = markup;
      else if (markup === underscore && underscoreFits(state, mark, parent, index))
        chosen = underscore;
      return state.pushChosen(name, chosen);
    },
    close(state) {
      const open = state.popChosen(name, star);
      return isTag(open) ? closingTag(open) : open;
    },
  };
}

function underscoreFits(
  state: SetMarkdownState,
  mark: Mark,
  parent: PMNode,
  index: number,
): boolean {
  if (/\w/.test(state.out.slice(-1))) return false;
  let end = index;
  while (end < parent.childCount && mark.isInSet(parent.child(end).marks)) end++;
  const after = parent.maybeChild(end);
  return !(after?.isText && /^\w/.test(after.text ?? ""));
}

/** The text a link's mark covers, when it is plain text and nothing else. */
function linkText(mark: Mark, parent: PMNode, index: number): string | null {
  let text = "";
  for (let i = index; i < parent.childCount; i++) {
    const child = parent.child(i);
    if (!mark.isInSet(child.marks)) break;
    if (!child.isText || child.marks.length !== 1) return null;
    text += child.text;
  }
  return text || null;
}

function link(base: MarkSerializer): MarkSerializer {
  return {
    ...base,
    open(state, mark, parent, index) {
      const form = linkForm(state, mark, parent, index);
      state.pushChosen("link", form);
      if (form === "bare" || form === "autolink") {
        state.inAutolink = true;
        return form === "bare" ? "" : "<";
      }
      if (form.startsWith("ref")) return "[";
      return delimiter(base.open, state, mark, parent, index);
    },
    close(state, mark, parent, index) {
      const form = state.popChosen("link", "");
      if (form === "bare" || form === "autolink") {
        state.inAutolink = undefined;
        return form === "bare" ? "" : ">";
      }
      if (form === "ref:shortcut") return "]";
      if (form === "ref:collapsed") return "][]";
      if (form.startsWith("ref:full:")) return `][${form.slice("ref:full:".length)}]`;
      return delimiter(base.close, state, mark, parent, index);
    },
  };
}

function linkForm(
  state: SetMarkdownState,
  mark: Mark,
  parent: PMNode,
  index: number,
): string {
  const { md, referenceLabels } = state.context;
  const attrs = mark.attrs as Record<string, string | null>;
  const text = linkText(mark, parent, index);

  // Reference style only while the definition still gives this address.
  if (attrs.refForm && attrs.refLabel && attrs.refHref === attrs.href) {
    const label = md.utils.normalizeReference(attrs.refLabel);
    if (referenceLabels.has(label)) {
      const short = attrs.refForm === "shortcut" || attrs.refForm === "collapsed";
      if (short && text !== null && md.utils.normalizeReference(text) === label) {
        return `ref:${attrs.refForm}`;
      }
      return `ref:full:${attrs.refLabel}`;
    }
  }
  if (attrs.title || text === null) return "";
  if (
    attrs.markup === "linkify" &&
    bareFits(state, text, attrs.href ?? "", parent, index, mark)
  ) {
    return "bare";
  }
  if (
    attrs.markup === "autolink" &&
    (text === attrs.href || `mailto:${text}` === attrs.href)
  ) {
    return "autolink";
  }
  return "";
}

/** Nothing it touches may join a bare URL. */
function bareFits(
  state: SetMarkdownState,
  text: string,
  href: string,
  parent: PMNode,
  index: number,
  mark: Mark,
): boolean {
  const { md } = state.context;
  if (/\w/.test(state.out.slice(-1))) return false;
  const found = md.linkify.match(text);
  if (found?.length !== 1 || found[0].index !== 0 || found[0].lastIndex !== text.length)
    return false;
  if (md.normalizeLink(found[0].url) !== href) return false;

  let end = index;
  while (end < parent.childCount && mark.isInSet(parent.child(end).marks)) end++;
  const after = parent.maybeChild(end);
  const tail = after?.isText ? (/^\S*/.exec(after.text ?? "")?.[0] ?? "") : "";
  if (!tail) return true;
  const joined = md.linkify.match(text + tail);
  return joined?.[0]?.index === 0 && joined[0].lastIndex === text.length;
}

const SPECIAL = /[[\]=&$]/;
const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);

/** tiptap-markdown's own HTML escape — kept, so `<` is still written `&lt;`. */
const escapeHTML = (value: string) => value.replace(/</g, "&lt;").replace(/>/g, "&gt;");

let decoder: HTMLTextAreaElement | null = null;
function decodesAsEntity(entity: string): boolean {
  decoder ??= document.createElement("textarea");
  decoder.innerHTML = entity;
  return decoder.value !== entity;
}

/**
 * Brackets are escaped only where they could make a link, reference, footnote or wikilink, and
 * dollars only where they would close into an equation.
 */
const serializeText: NodeSerializer = (state, node, parent, index) => {
  const text = node.text ?? "";
  if (state.inAutolink) {
    state.text(escapeHTML(text), false);
    return;
  }
  const afterBreak = state.lineStartPending;
  state.lineStartPending = false;
  const startOfLine = state.atBlockStart || afterBreak;
  const inLink = node.marks.some((mark) => mark.type.name === "link");
  state.text(
    escapeText(
      state,
      text,
      startOfLine,
      afterBreak,
      inLink,
      following(node, parent, index),
      startOfLine && text.trimEnd() === "$$" && dollarLineAfter(parent, index),
    ),
    false,
  );
};

/** Whether a later wrapped line of the paragraph is `$$` on its own, closing an equation block. */
function dollarLineAfter(parent: PMNode, index: number): boolean {
  let lineStart = false;
  for (let i = index + 1; i < parent.childCount; i++) {
    const child = parent.child(i);
    if (child.type.name === "softBreak") {
      lineStart = true;
      continue;
    }
    if (lineStart && child.isText && (child.text ?? "").trimEnd() === "$$") return true;
    lineStart = false;
  }
  return false;
}

/** The first character written after this node, as far as a bracket cares. */
function following(node: PMNode, parent: PMNode, index: number): string {
  const next = parent.maybeChild(index + 1);
  if (!next) return "";
  if (next.isText) {
    const opensLink = next.marks.some(
      (mark) => mark.type.name === "link" && !mark.isInSet(node.marks),
    );
    return opensLink ? "[" : (next.text ?? "").charAt(0);
  }
  switch (next.type.name) {
    case "softBreak":
    case "hardBreak":
      return " ";
    case "rawInline":
      return String(next.attrs.source ?? "").charAt(0);
    case "entity":
      return "&";
    default:
      return "[";
  }
}

function matchingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]" && --depth === 0) return i;
  }
  return -1;
}

export function escapeText(
  state: SetMarkdownState,
  text: string,
  startOfLine: boolean,
  afterBreak: boolean,
  inLink: boolean,
  next: string,
  closesBlock = false,
): string {
  // `<` and `>` become entities only as each run is written.
  if (!SPECIAL.test(text))
    return guardLineStart(state.esc(escapeHTML(text), startOfLine), afterBreak);

  const { md, referenceLabels, footnoteLabels } = state.context;
  const escaped = new Set<number>();

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "[") {
      const close = matchingBracket(text, i);
      if (inLink || close < 0) {
        escaped.add(i);
        continue;
      }
      const after = close + 1 < text.length ? text[close + 1] : next;
      const label = text.slice(i + 1, close);
      const risky =
        after === "(" ||
        after === "[" ||
        after === ":" ||
        (label.startsWith("^") && footnoteLabels.has(label.slice(1))) ||
        referenceLabels.has(md.utils.normalizeReference(label)) ||
        (text[i + 1] === "[" && text[close - 1] === "]");
      if (risky) {
        escaped.add(i);
        escaped.add(close);
      }
    } else if (ch === "]") {
      if (inLink) escaped.add(i);
    } else if (ch === "=") {
      let end = i;
      while (text[end] === "=") end++;
      if (end - i >= 2 && !isSpace(text[end]) && closesHighlight(text, end))
        escaped.add(i);
      i = end - 1;
    } else if (ch === "$") {
      // A matched pair would make an equation, and a `$$` line with another below it a block;
      // the opener is what is escaped, so the scan goes on past it.
      const opensBlock = i === 0 && startOfLine && text.trimEnd() === "$$" && closesBlock;
      if (opensBlock || mathSpanAt(text, i)) {
        escaped.add(i);
        if (text[i + 1] === "$") escaped.add(i + 1);
      }
    } else if (ch === "&") {
      const entity =
        /^&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(
          text.slice(i),
        );
      if (entity && decodesAsEntity(entity[0])) escaped.add(i);
    }
  }

  let out = "";
  let segment = "";
  let first = true;
  const flush = () => {
    out += state.esc(escapeHTML(segment), first && startOfLine);
    segment = "";
    first = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!SPECIAL.test(ch)) {
      segment += ch;
      continue;
    }
    flush();
    out += (escaped.has(i) ? "\\" : "") + ch;
  }
  flush();
  return guardLineStart(out, afterBreak);
}

function closesHighlight(text: string, from: number): boolean {
  for (let at = text.indexOf("==", from); at >= 0; at = text.indexOf("==", at + 1)) {
    if (!isSpace(text[at - 1])) return true;
  }
  return false;
}

/** A setext underline or a table delimiter row after a soft break would close the paragraph. */
function guardLineStart(line: string, afterBreak: boolean): string {
  if (!afterBreak) return line;
  if (/^=+\s*$/.test(line)) return `\\${line}`;
  if (/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line) && line.includes("|"))
    return `\\${line}`;
  return line;
}
