import { workspace } from "$lib/state/workspace.svelte";
import { isUnsupportedPlatform } from "$lib/shell/unsupported";
import type { LayoutLoad } from "./$types";

export const ssr = false;

export const load: LayoutLoad = async () => {
  // Before `workspace.init()`: opening the store is one of the things that fails on a phone, and
  // this load blocks the first render.
  const unsupported = isUnsupportedPlatform();
  if (unsupported) return { unsupported };

  await workspace.init();
  return { unsupported };
};
