import { isTauri, invoke } from "@tauri-apps/api/core";
import { settings } from "$lib/state/settings.svelte";
import type { PageStore } from "./store";
import { IndexedDbPageStore } from "./indexeddb-store";
import { FsPageStore } from "./fs-store";

export type { PageStore } from "./store";

let storePromise: Promise<PageStore> | undefined;

export function getStore(): Promise<PageStore> {
  if (!storePromise) storePromise = createStore();
  return storePromise;
}

export function resetStore(): void {
  storePromise = undefined;
}

export async function currentNotesRoot(): Promise<string> {
  if (settings.notesFolder) return settings.notesFolder;
  return defaultNotesRoot();
}

export async function defaultNotesRoot(): Promise<string> {
  const { documentDir, join } = await import("@tauri-apps/api/path");
  return join(await documentDir(), "Set");
}

async function createStore(): Promise<PageStore> {
  if (isTauri()) {
    const root = await currentNotesRoot();

    await invoke("grant_notes_dir", { path: root });
    const store = new FsPageStore(root);
    await store.init();
    return store;
  }
  if (typeof indexedDB !== "undefined") {
    return new IndexedDbPageStore();
  }
  throw new Error(
    "No storage backend available: this environment has neither Tauri nor IndexedDB.",
  );
}
