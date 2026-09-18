import type { PageId } from "$lib/types";
import type { ContentMatch, Segment } from "$lib/storage/store";
import { merge } from "./ranges";

const SNIPPET_CHARS = 160;

const SNIPPET_LEAD = 32;

export const MIN_QUERY_CHARS = 2;

export interface IndexedBody {
  id: PageId;
  body: string;
  fold: string;
}

/**
 * ASCII-only, matching `to_ascii_lowercase` in index.rs, and length-preserving so offsets index
 * straight back into the body.
 */
export function foldAscii(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export function searchBodies(
  docs: Iterable<IndexedBody>,
  query: string,
  limit: number,
): ContentMatch[] {
  const phrase = query.trim().toLowerCase();
  if ([...phrase].length < MIN_QUERY_CHARS) return [];
  const terms = phrase.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const hits: ContentMatch[] = [];
  for (const doc of docs) {
    const hit = scorePage(doc, phrase, terms);
    if (hit) hits.push(hit);
  }

  hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return hits.slice(0, limit);
}

function scorePage(
  doc: IndexedBody,
  phrase: string,
  terms: string[],
): ContentMatch | null {
  for (const term of terms) {
    if (!doc.fold.includes(term)) return null;
  }
  const best = bestLine(doc.fold, terms);
  if (!best) return null;

  const phraseBonus = terms.length > 1 && doc.fold.includes(phrase) ? 60 : 0;

  const density = 20 * best.terms;

  const repetition = Math.min(best.total, 10);

  const position = 5 * (1 - best.start / Math.max(doc.body.length, 1));

  return {
    id: doc.id,
    score: phraseBonus + density + repetition + position,
    snippet: snippet(doc.body.slice(best.start, best.end), best.ranges),
    total: best.total,
  };
}

interface BestLine {
  start: number;
  end: number;
  terms: number;
  total: number;
  ranges: [number, number][];
}

function bestLine(fold: string, terms: string[]): BestLine | null {
  let best: BestLine | null = null;
  let total = 0;
  let offset = 0;

  for (const line of fold.split("\n")) {
    const ranges: [number, number][] = [];
    let distinct = 0;
    for (const term of terms) {
      const before = ranges.length;
      for (let from = 0; ;) {
        const at = line.indexOf(term, from);
        if (at === -1) break;
        ranges.push([at, at + term.length]);
        from = at + Math.max(term.length, 1);
      }
      if (ranges.length > before) distinct++;
    }
    total += ranges.length;

    if (distinct > 0 && (!best || distinct > best.terms)) {
      best = {
        start: offset,
        end: offset + line.length,
        terms: distinct,
        total: 0,
        ranges,
      };
    }
    offset += line.length + 1; // + the "\n" that `split` consumed
  }

  return best && { ...best, total };
}

function snippet(line: string, raw: [number, number][]): Segment[] {
  const lead = line.length - line.trimStart().length;
  const trimmed = line.trim();
  const ranges = merge(raw)
    .filter(([s]) => s >= lead && s - lead < trimmed.length)
    .map(([s, e]) => [s - lead, Math.min(e - lead, trimmed.length)] as [number, number]);

  const [from, to] = windowAround(trimmed, ranges.length ? ranges[0][0] : 0);
  const visible = trimmed.slice(from, to);

  const out: Segment[] = [];
  let cursor = 0;
  for (const [rawStart, rawEnd] of ranges) {
    if (rawEnd <= from || rawStart >= to) continue;
    const start = Math.max(rawStart - from, cursor, 0);
    const end = Math.min(rawEnd - from, visible.length);
    if (end <= start) continue;
    push(out, visible.slice(cursor, start), false);
    push(out, visible.slice(start, end), true);
    cursor = end;
  }
  push(out, visible.slice(cursor), false);

  if (from > 0) out.unshift({ text: "… ", hit: false });
  if (to < trimmed.length) out.push({ text: " …", hit: false });
  return out;
}

function push(out: Segment[], text: string, hit: boolean): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.hit === hit) last.text += text;
  else out.push({ text, hit });
}

function windowAround(text: string, at: number): [number, number] {
  const starts: number[] = [];
  for (let i = 0; i < text.length; i += text.codePointAt(i)! > 0xffff ? 2 : 1) {
    starts.push(i);
  }
  if (starts.length <= SNIPPET_CHARS) return [0, text.length];

  let k = 0;
  while (k + 1 < starts.length && starts[k + 1] <= at) k++;

  const first = Math.max(0, k - SNIPPET_LEAD);
  const last = first + SNIPPET_CHARS;
  return [starts[first], last < starts.length ? starts[last] : text.length];
}
