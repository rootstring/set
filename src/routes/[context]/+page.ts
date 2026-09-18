import { redirect } from "@sveltejs/kit";
import { workspace } from "$lib/state/workspace.svelte";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, parent }) => {
  const { unsupported } = await parent();
  if (unsupported) return;

  // A context renamed or deleted since the address was made.
  const context = workspace.resolveContext(params.context);
  if (!context) redirect(307, "/");

  workspace.showContext(context);
  const id = workspace.startPageId();
  if (id) redirect(307, workspace.pathFor(id));
  workspace.closePage();
};
