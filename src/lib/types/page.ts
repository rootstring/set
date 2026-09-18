export type PageId = string;

export interface PageDoc {
  type: "doc";
  content?: unknown[];
}

export interface Page {
  id: PageId;
  title: string;
  doc: PageDoc;
  parentId: PageId | null;
  context: string;
  order?: number;
  locked?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PageSummary {
  id: PageId;
  title: string;
  parentId: PageId | null;
  context: string;
  createdAt: number;
  locked?: boolean;
}

export type TrashEntry = TrashedPage | TrashedContext;

export type TrashRef = { kind: "page"; id: PageId } | { kind: "context"; name: string };

export interface TrashedPage {
  kind: "page";
  id: PageId;
  title: string;
  trashedAt: number;
  context: string;
  descendants: number;
}

export interface TrashedContext {
  kind: "context";
  name: string;
  trashedAt: number;
  pages: number;
}

export interface Context {
  name: string;
  pages: number;
}

export function emptyDoc(): PageDoc {
  return { type: "doc", content: [{ type: "paragraph" }] };
}
