<script lang="ts">
  import AppearanceControls from "./AppearanceControls.svelte";
  import type { TabContext } from "./shared";

  let { ctx }: { ctx: TabContext } = $props();

  function confirmReset(scope: string, apply: () => void, anchor: HTMLElement): void {
    ctx.confirm({
      anchor,
      title: `Reset ${scope}`,
      message: `Restore ${scope} defaults. This can't be undone.`,
      confirmLabel: "Reset",
      danger: true,
      onConfirm: apply,
    });
  }
</script>

<AppearanceControls reset={confirmReset} />
