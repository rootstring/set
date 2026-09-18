import type { PageStore } from "./store";
import { docToMarkdown } from "./markdown";
import { pageToFile } from "./serialize";
import { assetRef, findAssetRefs } from "./paths";
import {
  bytesToBase64,
  type ExportBundle,
  type ExportedAsset,
  type ExportedPage,
} from "./bundle";

export type { ExportedAsset, ExportedPage, ExportBundle, ImportResult } from "./bundle";
export { applyImportBundle } from "./bundle";

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

export async function buildExportBundle(store: PageStore): Promise<ExportBundle> {
  const summaries = await store.list();
  const pages: ExportedPage[] = [];
  for (const summary of summaries) {
    // `track: false`: an export must not move the version an open editor's next save is checked
    // against.
    const page = await store.get(summary.id, { track: false });
    if (!page) continue;
    const body = docToMarkdown(page.doc);
    const file = pageToFile(page, body);
    const assets: ExportedAsset[] = [];
    for (const fileName of findAssetRefs(body)) {
      const url = await store.assetUrl(page.id, assetRef("_", fileName));
      if (!url) continue; // referenced but missing
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      const ext = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
      assets.push({
        fileName,
        ext,
        type: MIME_BY_EXT[ext] ?? "application/octet-stream",
        dataBase64: bytesToBase64(bytes),
      });
    }
    pages.push({ file, assets, context: page.context });
  }
  return { version: 2, exportedAt: Date.now(), pages };
}
