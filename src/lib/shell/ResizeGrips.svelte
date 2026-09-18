<script lang="ts">
  import { getCurrentWindow } from "@tauri-apps/api/window";

  /**
   * An undecorated GTK window has no resize border; these strips hand the drag to the compositor.
   */
  const EDGES = [
    ["North", "n"],
    ["South", "s"],
    ["West", "w"],
    ["East", "e"],
    ["NorthWest", "nw"],
    ["NorthEast", "ne"],
    ["SouthWest", "sw"],
    ["SouthEast", "se"],
  ] as const;

  function grab(direction: (typeof EDGES)[number][0], event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    void getCurrentWindow().startResizeDragging(direction);
  }
</script>

{#each EDGES as [direction, side] (side)}
  <div
    class="grip {side}"
    role="presentation"
    onpointerdown={(event) => grab(direction, event)}
  ></div>
{/each}

<style>
  .grip {
    position: fixed;
    z-index: 100;
  }

  .n,
  .s {
    left: var(--corner);
    right: var(--corner);
    height: var(--edge);
    cursor: ns-resize;
  }

  .w,
  .e {
    top: var(--corner);
    bottom: var(--corner);
    width: var(--edge);
    cursor: ew-resize;
  }

  .nw,
  .ne,
  .sw,
  .se {
    width: var(--corner);
    height: var(--corner);
  }

  .n {
    top: 0;
  }
  .s {
    bottom: 0;
  }
  .w {
    left: 0;
  }
  .e {
    right: 0;
  }

  .nw {
    top: 0;
    left: 0;
    cursor: nwse-resize;
  }
  .ne {
    top: 0;
    right: 0;
    cursor: nesw-resize;
  }
  .sw {
    bottom: 0;
    left: 0;
    cursor: nesw-resize;
  }
  .se {
    bottom: 0;
    right: 0;
    cursor: nwse-resize;
  }

  .grip {
    --edge: 4px;
    --corner: 10px;
  }
</style>
