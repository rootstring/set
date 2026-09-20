import { mathSpanAt } from "./math";
import {
  escapeAttr,
  type BlockRule,
  type InlineRule,
  type MarkdownIt,
  type StateBlock,
  type StateCore,
  type Token,
} from "./types";

/**
 * Footnotes, wikilinks, GitHub alerts and math; parsed by `Footnote.ts`, `WikiLink.ts`,
 * `Callout.ts` and `Math.ts`.
 */
export function registerExtras(md: MarkdownIt): void {
  md.block.ruler.before("reference", "set_footnote_def", footnoteDefinition, {
    alt: ["paragraph", "reference"],
  });
  // Like a fence, it can cut a paragraph short.
  md.block.ruler.before("fence", "set_math_block", mathBlock, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
  md.inline.ruler.before("link", "set_wikilink", wikiLink);
  md.inline.ruler.before("link", "set_footnote_ref", footnoteReference);
  md.inline.ruler.before("link", "set_math_inline", mathInline);
  md.core.ruler.after("block", "set_callouts", callouts);

  const escape = md.utils.escapeHtml;
  const rules = md.renderer.rules;
  rules.math_block = (tokens, idx) => {
    const form = tokens[idx].meta?.single ? ' data-md="single"' : "";
    return `<div data-math-block=""${form}>${escape(tokens[idx].content)}</div>`;
  };
  rules.math_inline = (tokens, idx) => {
    const display = tokens[idx].meta?.display ? ' data-display=""' : "";
    return `<span data-math="${escapeAttr(tokens[idx].content)}"${display}></span>`;
  };
  rules.footnote_def = (tokens, idx) => {
    const { label, space } = tokens[idx].meta as { label: string; space: string };
    return (
      `<div data-footnote="${escapeAttr(label)}" data-space="${escapeAttr(space)}">` +
      `${escape(tokens[idx].content)}</div>`
    );
  };
  rules.footnote_ref = (tokens, idx) => {
    const { label } = tokens[idx].meta as { label: string };
    return `<sup data-footnote-ref="${escapeAttr(label)}"></sup>`;
  };
  rules.wikilink = (tokens, idx) => {
    const { target, alias } = tokens[idx].meta as {
      target: string;
      alias: string | null;
    };
    const aliasAttr = alias === null ? "" : ` data-alias="${escapeAttr(alias)}"`;
    return `<span data-wikilink="${escapeAttr(target)}"${aliasAttr}></span>`;
  };
  rules.callout_open = (tokens, idx, options, _env, self) =>
    self.renderToken(tokens, idx, options);
  rules.callout_close = (tokens, idx, options, _env, self) =>
    self.renderToken(tokens, idx, options);
}

function lineText(state: StateBlock, line: number): string {
  return state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
}

/** Whether `line` starts a block that would end a paragraph. */
function interrupts(state: StateBlock, line: number, endLine: number): boolean {
  const rules = state.md.block.ruler.getRules("paragraph");
  const oldParent = state.parentType;
  state.parentType = "paragraph";
  try {
    return rules.some((rule) => rule(state, line, endLine, true));
  } finally {
    state.parentType = oldParent;
  }
}

/** The body is kept as written. */
const footnoteDefinition: BlockRule = (state, startLine, endLine, silent) => {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const first = lineText(state, startLine);
  const match = /^\[\^([^\]\s]+)\]:([ \t]?)/.exec(first);
  if (!match) return false;
  if (silent) return true;

  let line = startLine + 1;
  while (
    line < endLine &&
    !state.isEmpty(line) &&
    (state.sCount[line] - state.blkIndent >= 4 || !interrupts(state, line, endLine))
  ) {
    line++;
  }
  let end = line;
  for (let probe = line; probe < endLine; probe++) {
    if (state.isEmpty(probe)) continue;
    if (state.sCount[probe] - state.blkIndent < 4) break;
    end = probe + 1;
  }

  const source = state
    .getLines(startLine, end, state.blkIndent, false)
    .replace(/\n+$/, "");
  const token = state.push("footnote_def", "", 0);
  token.block = true;
  token.map = [startLine, end];
  token.meta = { label: match[1], space: match[2] };
  token.content = source.slice(source.indexOf(":") + 1 + match[2].length);
  state.env.setFootnotes ??= new Set();
  state.env.setFootnotes.add(match[1]);
  state.line = end;
  return true;
};

/** `[^label]`, where a definition for `label` exists. */
const footnoteReference: InlineRule = (state, silent) => {
  if (
    state.src.charCodeAt(state.pos) !== 0x5b ||
    state.src.charCodeAt(state.pos + 1) !== 0x5e
  ) {
    return false;
  }
  const match = /^\[\^([^\]\s]+)\]/.exec(state.src.slice(state.pos, state.posMax));
  if (!match || !state.env.setFootnotes?.has(match[1])) return false;
  if (state.src[state.pos + match[0].length] === "(") return false;
  if (!silent) {
    const token = state.push("footnote_ref", "", 0);
    token.meta = { label: match[1] };
  }
  state.pos += match[0].length;
  return true;
};

/** `$x$` and `$$x$$` in running text; `math.ts` says what counts. */
const mathInline: InlineRule = (state, silent) => {
  const span = mathSpanAt(state.src, state.pos, state.posMax);
  if (!span) return false;
  const open = span.display ? 2 : 1;
  if (!silent) {
    const token = state.push("math_inline", "", 0);
    token.content = state.src.slice(state.pos + open, span.end - open);
    token.markup = span.display ? "$$" : "$";
    token.meta = { display: span.display };
  }
  state.pos = span.end;
  return true;
};

/** `$$` on a line of its own up to the next, or `$$x$$` on one line. */
const mathBlock: BlockRule = (state, startLine, endLine, silent) => {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const first = lineText(state, startLine).trimEnd();
  if (!first.startsWith("$$")) return false;

  if (first !== "$$") {
    const span = mathSpanAt(first, 0);
    if (!span?.display || span.end !== first.length) return false;
    if (silent) return true;
    const token = state.push("math_block", "", 0);
    token.block = true;
    token.map = [startLine, startLine + 1];
    token.content = first.slice(2, -2);
    token.meta = { single: true };
    state.line = startLine + 1;
    return true;
  }

  let line = startLine + 1;
  for (; line < endLine; line++) {
    if (!state.isEmpty(line) && state.sCount[line] < state.blkIndent) return false;
    if (lineText(state, line).trimEnd() === "$$") break;
  }
  // Left open, it is a paragraph that starts with two dollars.
  if (line >= endLine) return false;
  if (silent) return true;
  const token = state.push("math_block", "", 0);
  token.block = true;
  token.map = [startLine, line + 1];
  token.content = state.getLines(startLine + 1, line, state.sCount[startLine], false);
  state.line = line + 1;
  return true;
};

/** `[[Page]]`, `[[Page|shown as]]`. */
const wikiLink: InlineRule = (state, silent) => {
  const { src, pos } = state;
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
  const end = src.indexOf("]]", pos + 2);
  if (end < 0 || end + 2 > state.posMax) return false;
  const inner = src.slice(pos + 2, end);
  if (!inner.trim() || /[[\]\n]/.test(inner)) return false;
  const bar = inner.indexOf("|");
  const target = bar < 0 ? inner : inner.slice(0, bar);
  if (!target.trim()) return false;
  if (!silent) {
    const token = state.push("wikilink", "", 0);
    token.meta = { target, alias: bar < 0 ? null : inner.slice(bar + 1) };
  }
  state.pos = end + 2;
  return true;
};

const CALLOUT = /^\[!([A-Za-z][\w-]*)\]([+-]?)(?:[ \t]+([^\n]*))?(?:\n|$)/;

/**
 * Whether the marker stood alone on its own `>` line is recorded so it is written back the same
 * way.
 */
function callouts(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i];
    if (open.type !== "blockquote_open") continue;
    const inline = tokens[i + 2];
    if (tokens[i + 1]?.type !== "paragraph_open" || inline?.type !== "inline") continue;
    const match = CALLOUT.exec(inline.content);
    if (!match) continue;
    const close = findClose(tokens, i);
    if (close < 0) continue;

    open.type = "callout_open";
    open.tag = "div";
    tokens[close].type = "callout_close";
    tokens[close].tag = "div";
    open.attrSet("data-callout", match[1]);
    if (match[2]) open.attrSet("data-fold", match[2]);
    if (match[3]?.trim()) open.attrSet("data-title", match[3].trim());

    const body = inline.content.slice(match[0].length);
    if (body.trim()) {
      inline.content = body;
    } else {
      const marker = tokens[i + 1].map;
      tokens.splice(i + 1, 3);
      const next = tokens[i + 1];
      // A `>` line between the marker and the body, as opposed to a list or
      // fence starting straight under it.
      if (
        next?.type !== "callout_close" &&
        marker &&
        next?.map &&
        next.map[0] > marker[1]
      ) {
        open.attrSet("data-gap", "");
      }
    }
  }
}

function findClose(tokens: Token[], openIndex: number): number {
  const level = tokens[openIndex].level;
  for (let i = openIndex + 1; i < tokens.length; i++) {
    if (tokens[i].type === "blockquote_close" && tokens[i].level === level) return i;
  }
  return -1;
}
