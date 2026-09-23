import { MarkdownSerializerState } from "prosemirror-markdown";
import type { Mark, Node as PMNode } from "@tiptap/pm/model";
import type { MarkdownIt } from "@rootstring/set-markdown";

/** Marked internal by prosemirror-markdown but what every serializer spec is written against. */
interface StateInternals {
  out: string;
  inAutolink: boolean | undefined;
  atBlockStart: boolean;
  marks: Record<string, { expelEnclosingWhitespace?: boolean } | undefined>;
}

type StateOptions = { hardBreakNodeName?: string; tightLists?: boolean };

const StateBase = MarkdownSerializerState as unknown as new (
  nodes: Record<string, unknown>,
  marks: Record<string, unknown>,
  options: StateOptions,
) => MarkdownSerializerState & StateInternals;

/** Labels a bracket in running text could accidentally refer to. */
export interface SerializeContext {
  md: MarkdownIt;
  /** Reference-definition labels, normalized the way markdown-it looks them up. */
  referenceLabels: Set<string>;
  /** Footnote labels that have a definition somewhere on the page. */
  footnoteLabels: Set<string>;
}

interface PendingInline {
  start: number;
  end?: number;
  delimiter: string;
}

/**
 * tiptap-markdown's state, ported exactly, remembering the delimiter a mark actually wrote so
 * `_em_` stays `_em_`.
 */
export class SetMarkdownState extends StateBase {
  inTable = false;
  /** Set by a soft break: the next text starts a line of its own. */
  lineStartPending = false;
  /** Delimiters chosen by `open`, for the matching `close` to reuse. */
  readonly chosen = new Map<string, string[]>();
  readonly context: SerializeContext;
  private readonly inlines: PendingInline[] = [];

  constructor(
    nodes: Record<string, unknown>,
    marks: Record<string, unknown>,
    options: StateOptions,
    context: SerializeContext,
  ) {
    super(nodes, marks, options);
    this.context = context;
  }

  render(node: PMNode, parent: PMNode, index: number): void {
    if (!node.isText && node.type.name !== "softBreak") this.lineStartPending = false;
    super.render(node, parent, index);
    const top = this.inlines[this.inlines.length - 1];
    // `start` of 0 is skipped: tiptap-markdown does, and existing output depends on it.
    if (top?.start && top?.end) {
      let { start } = top;
      while (this.out.charAt(start).match(/\s/)) start++;
      this.out = trimInline(this.context.md, this.out, top.delimiter, start, top.end);
      this.inlines.pop();
    }
  }

  markString(mark: Mark, open: boolean, parent: PMNode, index: number): string {
    const value = super.markString(mark, open, parent, index);
    const info = this.marks[mark.type.name];
    if (info?.expelEnclosingWhitespace) {
      if (open) {
        this.inlines.push({ start: this.out.length, delimiter: value });
      } else {
        const top = this.inlines.pop();
        if (top) this.inlines.push({ ...top, end: this.out.length });
      }
    }
    return value;
  }

  /** Remember the delimiter an opening mark chose, for its close. */
  pushChosen(name: string, delimiter: string): string {
    const stack = this.chosen.get(name) ?? [];
    stack.push(delimiter);
    this.chosen.set(name, stack);
    return delimiter;
  }

  popChosen(name: string, fallback: string): string {
    return this.chosen.get(name)?.pop() ?? fallback;
  }
}

// tiptap-markdown's `util/markdown.js`, typed.

function scanDelims(md: MarkdownIt, text: string, pos: number) {
  const state = new md.inline.State(text, md, {}, []);
  return state.scanDelims(pos, true);
}

function shiftDelim(text: string, delim: string, start: number, offset: number): string {
  let res = text.substring(0, start) + text.substring(start + delim.length);
  res = res.substring(0, start + offset) + delim + res.substring(start + offset);
  return res;
}

function trimStart(
  md: MarkdownIt,
  text: string,
  delim: string,
  from: number,
  to: number,
) {
  let pos = from;
  let res = text;
  while (pos < to) {
    if (scanDelims(md, res, pos).can_open) break;
    res = shiftDelim(res, delim, pos, 1);
    pos++;
  }
  return { text: res, from: pos, to };
}

function trimEnd(md: MarkdownIt, text: string, delim: string, from: number, to: number) {
  let pos = to;
  let res = text;
  while (pos > from) {
    if (scanDelims(md, res, pos).can_close) break;
    res = shiftDelim(res, delim, pos, -1);
    pos--;
  }
  return { text: res, from, to: pos };
}

function trimInline(
  md: MarkdownIt,
  text: string,
  delim: string,
  from: number,
  to: number,
): string {
  let state = trimStart(md, text, delim, from, to);
  state = trimEnd(md, state.text, delim, state.from, state.to);
  if (state.to - state.from < delim.length + 1) {
    state.text =
      state.text.substring(0, state.from) + state.text.substring(state.to + delim.length);
  }
  return state.text;
}
