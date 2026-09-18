import { redirect } from "@sveltejs/kit";
import { workspace } from "$lib/state/workspace.svelte";
import type { PageLoad } from "./$types";

/** No view of its own: forwards to the last page read, or the open context's empty state. */
export const load: PageLoad = async ({ parent }) => {
  const { unsupported } = await parent();
  // No workspace to pick a start page from, and nowhere to send anyone.
  if (unsupported) return;

  const id = workspace.startPageId();
  redirect(
    307,
    id ? workspace.pathFor(id) : workspace.pathForContext(workspace.activeContext),
  );
};
