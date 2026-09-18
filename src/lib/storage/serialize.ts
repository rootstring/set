import type { Page } from "$lib/types";
import { docToMarkdown, markdownToDoc } from "./markdown";
import { composeFile, markdownBody, splitFile, type PageFallback } from "./frontmatter";

export {
  markdownBody,
  pageSignature,
  readFileMeta,
  replaceId,
  type FileMeta,
  type PageFallback,
} from "./frontmatter";

export function pageToFile(page: Page, body = docToMarkdown(page.doc)): string {
  return composeFile(page, body);
}

export function fileToPage(text: string, fallback: PageFallback): Page {
  const { meta, body } = splitFile(text);
  const now = Date.now();
  return {
    id: meta.id ?? fallback.id,
    title: meta.title ?? fallback.title,
    parentId: meta.parentId ?? fallback.parentId,
    context: fallback.context,
    order: meta.order,
    locked: meta.locked,
    createdAt: meta.createdAt ?? now,
    updatedAt: meta.updatedAt ?? now,
    doc: markdownToDoc(body),
  };
}
