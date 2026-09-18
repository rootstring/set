import type { PageId, PageSummary } from "$lib/types";
import type { Segment } from "$lib/storage/store";
import { subtreeIds } from "$lib/page/tree";
import { merge } from "./ranges";

const TIER = {
  exact: 1000,
  prefix: 900,
  wordPrefix: 800,
  allTermsWordPrefix: 700,
  substring: 600,
  allTerms: 500,
  fuzzy: 400,
  path: 200,
} as const;

export interface TitleMatch {
  page: PageSummary;
  score: number;
  title: Segment[];
  path: Segment[];
  inRoot: boolean;
}

export function titleOf(page: PageSummary): string {
  return page.title.trim() || "Untitled";
}

export function rankPages(
  pages: PageSummary[],
  query: string,
  limit: number,
  rootId: PageId | null = null,
): TitleMatch[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const inside = rootId ? subtreeIds(pages, rootId) : null;
  const q = query.trim();

  const withContext = spansContexts(pages);

  if (!q) {
    return cap(
      pages.map((page) => ({
        page,
        score: 0,
        title: [{ text: titleOf(page), hit: false }],
        path: [{ text: pathOf(page, byId, { withContext }), hit: false }],
        inRoot: inside?.has(page.id) ?? false,
      })),
      limit,
      inside !== null,
    );
  }

  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const matches: TitleMatch[] = [];

  for (const page of pages) {
    const title = titleOf(page);
    const path = pathOf(page, byId, { withContext });
    const inRoot = inside?.has(page.id) ?? false;

    const onTitle = scoreText(title, q, terms);
    if (onTitle) {
      matches.push({
        page,
        score: onTitle.score,
        title: split(title, onTitle.ranges),
        path: [{ text: path, hit: false }],
        inRoot,
      });
      continue;
    }

    const onPath = path ? scoreText(path, q, terms) : null;
    if (onPath) {
      matches.push({
        page,
        score: TIER.path + onPath.score / 100,
        title: [{ text: title, hit: false }],
        path: split(path, onPath.ranges),
        inRoot,
      });
    }
  }

  matches.sort(
    (a, b) =>
      b.score - a.score ||
      titleOf(a.page).length - titleOf(b.page).length ||
      titleOf(a.page).localeCompare(titleOf(b.page)),
  );
  return cap(matches, limit, inside !== null);
}

function cap(matches: TitleMatch[], limit: number, rooted: boolean): TitleMatch[] {
  if (!rooted) return matches.slice(0, limit);

  return [
    ...matches.filter((m) => m.inRoot).slice(0, limit),
    ...matches.filter((m) => !m.inRoot).slice(0, limit),
  ];
}

function spansContexts(pages: PageSummary[]): boolean {
  const first = pages[0]?.context;
  return pages.some((p) => p.context !== first);
}

interface TextMatch {
  score: number;
  ranges: [number, number][];
}

function scoreText(text: string, query: string, terms: string[]): TextMatch | null {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const whole: [number, number][] = [[0, text.length]];

  if (haystack === needle) return { score: TIER.exact, ranges: whole };
  if (haystack.startsWith(needle)) {
    return { score: TIER.prefix, ranges: [[0, needle.length]] };
  }

  const wordAt = wordStart(haystack, needle);
  if (wordAt !== -1) {
    return { score: TIER.wordPrefix, ranges: [[wordAt, wordAt + needle.length]] };
  }

  if (terms.length > 1) {
    const atWordStarts = locate(haystack, terms, true);
    if (atWordStarts) return { score: TIER.allTermsWordPrefix, ranges: atWordStarts };
  }

  const at = haystack.indexOf(needle);
  if (at !== -1) {
    return { score: TIER.substring, ranges: [[at, at + needle.length]] };
  }

  if (terms.length > 1) {
    const anywhere = locate(haystack, terms, false);
    if (anywhere) return { score: TIER.allTerms, ranges: anywhere };
  }

  const scattered = subsequence(haystack, needle.replace(/\s+/g, ""));
  if (scattered) {
    const span = scattered[scattered.length - 1][1] - scattered[0][0];
    return { score: TIER.fuzzy + 50 / (1 + span), ranges: scattered };
  }
  return null;
}

function wordStart(haystack: string, needle: string): number {
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + 1)
  ) {
    if (at === 0 || !isWordChar(haystack[at - 1])) return at;
  }
  return -1;
}

function locate(
  haystack: string,
  terms: string[],
  atWordStart: boolean,
): [number, number][] | null {
  const ranges: [number, number][] = [];
  for (const term of terms) {
    const at = atWordStart ? wordStart(haystack, term) : haystack.indexOf(term);
    if (at === -1) return null;
    ranges.push([at, at + term.length]);
  }
  return ranges;
}

function subsequence(haystack: string, needle: string): [number, number][] | null {
  if (!needle) return null;
  const ranges: [number, number][] = [];
  let at = 0;
  for (const ch of needle) {
    const found = haystack.indexOf(ch, at);
    if (found === -1) return null;
    ranges.push([found, found + ch.length]);
    at = found + ch.length;
  }
  return ranges;
}

export function split(text: string, ranges: [number, number][]): Segment[] {
  const merged = merge(ranges);
  const out: Segment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) out.push({ text: text.slice(cursor, start), hit: false });
    out.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false });
  return out;
}

function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch);
}

export function pathOf(
  page: PageSummary,
  byId: Map<PageId, PageSummary>,
  opts: { withContext?: boolean } = {},
): string {
  const parts: string[] = [];
  const seen = new Set<PageId>([page.id]);
  let cur = page.parentId ? byId.get(page.parentId) : undefined;
  while (cur && !seen.has(cur.id) && parts.length < 20) {
    seen.add(cur.id);
    parts.unshift(titleOf(cur));
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }

  if (opts.withContext) parts.unshift(page.context);
  return parts.join(" / ");
}
