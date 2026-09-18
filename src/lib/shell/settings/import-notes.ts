import { workspace } from "$lib/state/workspace.svelte";
import { isExportBundle } from "$lib/storage/bundle";
import type { FlashTone } from "./shared";

export async function importNotesFile(
  text: string,
): Promise<{ text: string; tone: FlashTone }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!isExportBundle(parsed)) {
    return { text: "That doesn't look like a notes export from Set", tone: "warn" };
  }

  const { imported, failed } = await workspace.importBundle(parsed);
  if (imported === 0) {
    return { text: "Nothing in that file could be imported", tone: "warn" };
  }
  const pages = `${imported} page${imported === 1 ? "" : "s"}`;
  return failed > 0
    ? { text: `Imported ${pages}; ${failed} couldn't be`, tone: "warn" }
    : { text: `Imported ${pages}`, tone: "info" };
}
