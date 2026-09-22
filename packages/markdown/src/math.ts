/**
 * Where a `$…$` or `$$…$$` span opened at `pos` closes, by Pandoc's rules: a `$` opens only in
 * front of a non-space, and the first `$` after it closes only behind a non-space and never in
 * front of a digit. Otherwise there is no span here at all, so "$5 and $10" is prose. Shared by
 * the parser and by the text serializer, which escapes what would read as math.
 */
export interface MathSpan {
  /** One past the closing delimiter. */
  end: number;
  display: boolean;
}

const DOLLAR = 0x24;
const BACKSLASH = 0x5c;

const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);

export function mathSpanAt(src: string, pos: number, max = src.length): MathSpan | null {
  if (src.charCodeAt(pos) !== DOLLAR) return null;
  const display = src.charCodeAt(pos + 1) === DOLLAR;
  const open = display ? 2 : 1;
  const start = pos + open;
  if (start >= max) return null;
  if (!display && (isSpace(src[start]) || src[start] === "$")) return null;

  for (let i = start; i < max; i++) {
    const code = src.charCodeAt(i);
    // `\$` is a dollar sign inside the formula.
    if (code === BACKSLASH) {
      i++;
      continue;
    }
    if (code !== DOLLAR) continue;
    if (display) {
      if (i + 1 >= max || src.charCodeAt(i + 1) !== DOLLAR) continue;
      return src.slice(start, i).trim() ? { end: i + 2, display } : null;
    }
    if (isSpace(src[i - 1]) || /\d/.test(src[i + 1] ?? "")) return null;
    return { end: i + 1, display };
  }
  return null;
}

/** A formula's source, written so it reads back as one formula. */
export function delimit(source: string, display: boolean): string {
  const fence = display ? "$$" : "$";
  const safe = source.replace(/\\\$|\$/g, (m) => (m === "$" ? "\\$" : m));
  return fence + safe + fence;
}
