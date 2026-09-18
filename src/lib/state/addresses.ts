import type { PageId } from "$lib/types";

/**
 * `/<context>` and `/<context>/pages/<title>-<id>`. Context and title are labels, not keys: the
 * page is found by id, so an old address still opens and is corrected in place (`navigation.ts`).
 * Pure.
 */

const MAX_SLUG = 60;

function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/, "");
}

/**
 * The name itself when its slug is empty or another context makes the same one; a context's slug
 * has no id beside it.
 */
export function contextSegment(name: string, all: readonly string[]): string {
  const slug = slugify(name);
  if (!slug) return name;
  const shared = all.some((other) => other !== name && slugify(other) === slug);
  return shared ? name : slug;
}

/** Names first (case-insensitive), then a slug only one context makes. */
export function matchContext(segment: string, all: readonly string[]): string | null {
  const exact = all.find((name) => name === segment);
  if (exact !== undefined) return exact;

  const lower = segment.toLowerCase();
  const named = all.find((name) => name.toLowerCase() === lower);
  if (named !== undefined) return named;

  const slugged = all.filter((name) => slugify(name) === lower);
  return slugged.length === 1 ? slugged[0] : null;
}

/** A context's own address, from its {@link contextSegment}. */
export function contextPath(segment: string): string {
  return `/${encodeURIComponent(segment)}`;
}

/** A page's address, in the context whose {@link contextSegment} is given. */
export function pagePath(id: PageId, title: string, segment: string): string {
  const slug = slugify(title);
  return `${contextPath(segment)}/pages/${slug ? `${slug}-${id}` : id}`;
}

export function splitPageRef(segment: string): string[] {
  const candidates = [segment];
  for (let i = segment.indexOf("-"); i !== -1; i = segment.indexOf("-", i + 1)) {
    candidates.push(segment.slice(i + 1));
  }
  return candidates;
}
