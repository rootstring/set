import type { Page, PageId } from "$lib/types";

const FENCE = "---";

interface Frontmatter {
  id: PageId;
  title: string;
  parentId: PageId | null;
  order?: number;
  locked?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PageFallback {
  id: PageId;
  title: string;
  parentId: PageId | null;
  context: string;
}

export interface FileMeta {
  id?: PageId;
  title?: string;
  parentId?: PageId | null;
  order?: number;
  locked?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export function splitFile(text: string): { meta: FileMeta; body: string } {
  const { front, body } = splitFrontmatter(text);
  return {
    meta: {
      id: str(front.id) ?? undefined,
      title: str(front.title) ?? undefined,
      parentId: str(front.parentId),
      order: num(front.order),
      locked: bool(front.locked),
      createdAt: num(front.createdAt),
      updatedAt: num(front.updatedAt),
    },
    body,
  };
}

export function readFileMeta(text: string): FileMeta {
  return splitFile(text).meta;
}

/** `text` with its frontmatter `id` swapped for `id`, and nothing else touched. */
export function replaceId(text: string, id: PageId): string {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith(FENCE + "\n")) return text;
  const end = normalized.indexOf(`\n${FENCE}`, FENCE.length);
  if (end === -1) return text;

  const block = normalized
    .slice(FENCE.length + 1, end)
    .replace(/^id:.*$/m, `id: ${JSON.stringify(id)}`);
  return normalized.slice(0, FENCE.length + 1) + block + normalized.slice(end);
}

export function markdownBody(text: string): string {
  return splitFrontmatter(text).body;
}

export function composeFile(page: Page, body: string): string {
  const front: Frontmatter = {
    id: page.id,
    title: page.title,
    parentId: page.parentId,
    ...(page.order != null ? { order: page.order } : {}),
    ...(page.locked ? { locked: true } : {}),
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };
  const lines = (Object.keys(front) as (keyof Frontmatter)[]).map(
    (key) => `${key}: ${JSON.stringify(front[key])}`,
  );
  return `${FENCE}\n${lines.join("\n")}\n${FENCE}\n\n${body}\n`;
}

export function pageSignature(
  page: Page,
  order: number | undefined,
  body: string,
): string {
  return [
    page.title,
    page.parentId ?? "",
    order ?? "",
    page.locked ? "locked" : "",
    body.replace(/\n+$/, ""),
  ].join("\u0000");
}

function splitFrontmatter(text: string): {
  front: Record<string, unknown>;
  body: string;
} {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith(FENCE + "\n")) {
    return { front: {}, body: normalized };
  }
  const end = normalized.indexOf(`\n${FENCE}`, FENCE.length);
  if (end === -1) return { front: {}, body: normalized };

  const block = normalized.slice(FENCE.length + 1, end);
  const body = normalized.slice(end + 1 + FENCE.length + 1).replace(/^\n/, "");

  const front: Record<string, unknown> = {};
  for (const line of block.split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const raw = line.slice(sep + 1).trim();
    try {
      front[key] = JSON.parse(raw);
    } catch {
      front[key] = raw;
    }
  }
  return { front, body };
}

function str(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return value === true ? true : undefined;
}
