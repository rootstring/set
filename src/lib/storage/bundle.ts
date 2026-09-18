import type { Page, PageId } from "$lib/types";
import type { PageStore, StoredAsset } from "./store";
import { readFileMeta, markdownBody } from "./frontmatter";
import { assetFileName } from "./paths";

export interface ExportedAsset {
  fileName: string;
  ext: string;
  type: string;
  dataBase64: string;
}

export interface ExportedPage {
  file: string;
  assets: ExportedAsset[];
  context?: string;
}

export type BundleVersion = 1 | 2;

export interface ExportBundle {
  version: BundleVersion;
  exportedAt: number;
  pages: ExportedPage[];
}

export interface ImportResult {
  imported: number;
  failed: number;
}

/** Whether a parsed file is a notes export from Set, of a version this build reads. */
export function isExportBundle(value: unknown): value is ExportBundle {
  return (
    !!value &&
    typeof value === "object" &&
    [1, 2].includes((value as ExportBundle).version) &&
    Array.isArray((value as ExportBundle).pages)
  );
}

/** `[Title](page:id)`, the link a parent holds to each of its sub-pages. */
const PAGE_LINK = /\]\(page:([^)\s]*)\)/g;

interface Landed {
  page: Page;
  entry: ExportedPage;
  sortKey: number;
}

/**
 * Three passes: pages (parents first) under new ids, then sibling order before any body is written
 * (a move rewrites the file), then bodies with images copied and links re-pointed.
 */
export async function applyImportBundle(
  store: PageStore,
  bundle: ExportBundle,
): Promise<ImportResult> {
  const byOldId = new Map(
    bundle.pages
      .map((p) => [readFileMeta(p.file).id, p] as const)
      .filter((pair): pair is [PageId, ExportedPage] => pair[0] !== undefined),
  );

  const depths = new Map<PageId, number>();
  function depthOf(id: PageId | undefined): number {
    if (!id) return 0;
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    depths.set(id, 0); // breaks a cycle before it can recurse forever
    const entry = byOldId.get(id);
    const parentId = entry ? readFileMeta(entry.file).parentId : undefined;
    const depth = parentId ? 1 + depthOf(parentId) : 0;
    depths.set(id, depth);
    return depth;
  }

  const ordered = [...bundle.pages].sort(
    (a, b) => depthOf(readFileMeta(a.file).id) - depthOf(readFileMeta(b.file).id),
  );

  const contexts = new Map<string, string>();
  for (const { name } of await store.listContexts()) contexts.set(name, name);

  const idMap = new Map<PageId, PageId>();
  const landed: Landed[] = [];
  let failed = 0;
  for (const entry of ordered) {
    try {
      const meta = readFileMeta(entry.file);
      const newParentId = meta.parentId ? (idMap.get(meta.parentId) ?? null) : null;
      let context: string | undefined;
      if (entry.context) {
        context = contexts.get(entry.context);
        if (!context) {
          context = await store.createContext(entry.context);
          contexts.set(entry.context, context);
        }
      }
      const page: Page = await store.create({
        title: meta.title || "Untitled",
        parentId: newParentId,
        context,
      });
      if (meta.id) idMap.set(meta.id, page.id);
      landed.push({
        page: { ...page, locked: meta.locked },
        entry,
        sortKey: meta.order ?? meta.createdAt ?? 0,
      });
    } catch {
      failed += 1;
    }
  }

  const siblings = new Map<string, Landed[]>();
  for (const item of landed) {
    const key = `${item.page.context}\u0000${item.page.parentId ?? ""}`;
    siblings.set(key, [...(siblings.get(key) ?? []), item]);
  }
  for (const group of siblings.values()) {
    if (group.length < 2) continue;
    const ids = group.sort((a, b) => a.sortKey - b.sortKey).map((g) => g.page.id);
    try {
      await store.move(ids[0], group[0].page.parentId, ids);
    } catch {
      // they're all there, just not in the order they left in
    }
  }

  let imported = 0;
  for (const { page, entry } of landed) {
    try {
      let body = markdownBody(entry.file).replace(PAGE_LINK, (link, id: string) =>
        idMap.has(id) ? `](page:${idMap.get(id)})` : link,
      );
      for (const asset of entry.assets) {
        const kind: StoredAsset = { ext: asset.ext, type: asset.type };
        const newRef = await store.putAsset(
          page.id,
          base64ToBytes(asset.dataBase64),
          kind,
        );
        const newName = assetFileName(newRef);
        if (newName) body = body.split(asset.fileName).join(newName);
      }

      await store.save(page, body);
      imported += 1;
    } catch {
      failed += 1;
    }
  }
  return { imported, failed };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
