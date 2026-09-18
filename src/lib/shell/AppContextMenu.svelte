<script lang="ts">
  import { onMount } from "svelte";
  import { isTauri } from "@tauri-apps/api/core";

  function isEditable(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    return !!el?.closest?.("input, textarea, [contenteditable]");
  }

  onMount(() => {
    if (!isTauri()) return;

    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented || isEditable(event.target)) return;
      event.preventDefault();
    };
    window.addEventListener("contextmenu", onContextMenu);

    return () => window.removeEventListener("contextmenu", onContextMenu);
  });
</script>
