import { error } from "@sveltejs/kit";
import { workspace } from "$lib/state/workspace.svelte";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, parent }) => {
  const { unsupported } = await parent();
  // A deep link on a phone has no workspace behind it.
  if (unsupported) return;

  const id = workspace.resolveId(params.slug);
  if (!id || !(await workspace.open(id))) error(404, "That page doesn't exist.");
};
