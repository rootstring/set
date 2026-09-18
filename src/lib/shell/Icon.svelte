<script lang="ts">
  import type { IconName } from "./icons";

  let { name }: { name: IconName } = $props();

  let gear = $derived(name === "settings");
</script>

<svg
  viewBox={gear ? "0 0 24 24" : "0 0 16 16"}
  width="1em"
  height="1em"
  fill="none"
  stroke="currentColor"
  stroke-width={gear ? 2 : name === "check" ? 1.8 : 1.4}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if name === "alert"}
    <path
      d="M8 2.25c.45 0 .87.24 1.09.63l4.6 8.24c.44.79-.13 1.76-1.03 1.76H3.34c-.9 0-1.47-.97-1.03-1.76l4.6-8.24c.22-.39.64-.63 1.09-.63Z"
    />
    <path d="M8 6.25v3" />
    <path d="M8 11.25h.01" />
  {:else if name === "back"}
    <path d="M12.25 8h-8.5" />
    <path d="M7.5 4.25 3.75 8l3.75 3.75" />
  {:else if name === "bullet"}
    <path d="M6 4.25h7.25M6 8h7.25M6 11.75h7.25" />
    <circle cx="3" cy="4.25" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="3" cy="8" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="3" cy="11.75" r="0.9" fill="currentColor" stroke="none" />
  {:else if name === "callout"}
    <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.75" />
    <path d="M5.25 2.75v10.5" />
    <path d="M7.75 6.25h3.5M7.75 9.25h2.5" opacity="0.6" />
  {:else if name === "check"}
    <path d="M3.5 8.5l3 3 6-7" />
  {:else if name === "chroot"}
    <path d="M2.5 6V2.5H6" />
    <path d="M10 2.5h3.5V6" />
    <path d="M13.5 10v3.5H10" />
    <path d="M6 13.5H2.5V10" />
  {:else if name === "unchroot"}
    <path d="M8 12.5V3.5" />
    <path d="M4.5 7L8 3.5 11.5 7" />
  {:else if name === "close"}
    <path d="M4 4l8 8M12 4l-8 8" />
  {:else if name === "code"}
    <path d="M5.5 5 2.75 8l2.75 3M10.5 5l2.75 3-2.75 3M8.75 4l-1.5 8" />
  {:else if name === "context"}
    <path d="M2 12.5v-9h4.2l1.3 1.8h6.5v7.2z" />
  {:else if name === "date"}
    <rect x="2.25" y="3" width="11.5" height="10.5" rx="1.75" />
    <path d="M5.25 1.75V4.25M10.75 1.75V4.25M2.25 6.5h11.5" />
  {:else if name === "divider"}
    <path d="M2.5 8h11" />
    <path d="M3.5 4.5h9M3.5 11.5h9" opacity="0.4" />
  {:else if name === "download"}
    <path d="M8 2.5v7" />
    <path d="M5 6.5 8 9.5l3-3" />
    <path d="M2.75 12.5h10.5" />
  {:else if name === "forward"}
    <path d="M3.75 8h8.5" />
    <path d="M8.5 4.25 12.25 8l-3.75 3.75" />
  {:else if name === "h1"}
    <path d="M2.75 3.5v9M8.25 3.5v9M2.75 8h5.5" />
    <path d="M11 6.75 12.75 6v6.5" />
  {:else if name === "h2"}
    <path d="M2.75 3.5v9M7.75 3.5v9M2.75 8h5" />
    <path d="M10.5 7c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5c0 1.6-3 2.3-3 4h3" />
  {:else if name === "h3"}
    <path d="M2.75 3.5v9M7.5 3.5v9M2.75 8h4.75" />
    <path
      d="M10.5 6c.2-.6.8-.9 1.5-.9 1.5 0 1.7 2 .2 2.1 1.6-.05 1.5 2.2-.2 2.2-.7 0-1.3-.3-1.5-.9"
    />
  {:else if name === "image"}
    <rect x="2.25" y="3.25" width="11.5" height="9.5" rx="1.75" />
    <circle cx="5.75" cy="6.5" r="1" />
    <path
      d="m2.75 11 2.9-2.6c.5-.45 1.25-.43 1.72.04l1.9 1.9c.45.45 1.16.49 1.66.1l.72-.57c.5-.4 1.22-.35 1.67.1l1.43 1.43"
    />
  {:else if name === "link"}
    <path d="M6.75 9.25a2.5 2.5 0 0 0 3.6.08l2-2a2.5 2.5 0 0 0-3.54-3.54l-.9.9" />
    <path d="M9.25 6.75a2.5 2.5 0 0 0-3.6-.08l-2 2a2.5 2.5 0 0 0 3.54 3.54l.9-.9" />
  {:else if name === "lock" || name === "lock-open"}
    <rect x="3.25" y="7.25" width="9.5" height="7" rx="1.5" />
    {#if name === "lock-open"}
      <path d="M6.25 7.25V4.75a2.75 2.75 0 0 1 5.5 0" />
    {:else}
      <path d="M5.25 7.25V4.75a2.75 2.75 0 0 1 5.5 0v2.5" />
    {/if}
  {:else if name === "mic"}
    <rect x="6" y="1.75" width="4" height="7" rx="2" />
    <path d="M3.75 7.25a4.25 4.25 0 0 0 8.5 0" />
    <path d="M8 11.5v2.75" />
  {:else if name === "ordered"}
    <path d="M6.5 4.25h6.75M6.5 8h6.75M6.5 11.75h6.75" />
    <path
      d="M2.5 3v2.5M2 3.25 2.5 3M1.9 11.5h1.2M1.9 11.5c0-.5.4-.8.8-.8.8 0 .8 1-.8 1.8h1.2"
    />
  {:else if name === "page"}
    <path
      d="M9 1.83H4.75c-.69 0-1.25.56-1.25 1.25v9.84c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25V5.5Z"
    />
    <path d="M9 1.83V5.5h3.5" />
    <path d="M5.75 8.75h4.5M5.75 11.25h3" />
  {:else if name === "page-link"}
    <!-- Kept in step with `ICON_SVG` in `lib/editor/WikiLink.ts`. -->
    <path
      d="M9 1.83H4.75c-.69 0-1.25.56-1.25 1.25v9.84c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25V5.5Z"
    />
    <path d="M9 1.83V5.5h3.5" />
    <path d="M5.85 9.55h3.6M8.1 8.1l1.45 1.45-1.45 1.45" />
  {:else if name === "plus"}
    <path d="M8 3.5v9M3.5 8h9" />
  {:else if name === "quote"}
    <path
      d="M4 4.25v3.5M4 4.25c-1 0-1.5.7-1.5 1.75M8 4.25v3.5M8 4.25c-1 0-1.5.7-1.5 1.75"
    />
    <path d="M3.5 11.5h9M3.5 8.75h5" />
  {:else if name === "restore"}
    <path d="M2.8 8a5.2 5.2 0 1 0 5.2-5.2 5.6 5.6 0 0 0-3.9 1.6L2.8 5.6" />
    <path d="M2.8 2.8v2.8h2.8" />
  {:else if name === "search"}
    <circle cx="7.25" cy="7.25" r="4.25" />
    <path d="M10.4 10.4 13.5 13.5" />
  {:else if name === "settings"}
    <path
      d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
    />
    <circle cx="12" cy="12" r="3" />
  {:else if name === "sidebar"}
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M6.25 3v10" />
  {:else if name === "table"}
    <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.75" />
    <path d="M2.25 6.25h11.5M2.25 9.75h11.5M6.1 6.25v7M9.9 6.25v7" />
  {:else if name === "text"}
    <path d="M4 3.25h8M8 3.25v9.5M6.25 12.75h3.5" />
  {:else if name === "theme-light"}
    <circle cx="8" cy="8" r="3" />
    <path
      d="M8 1.5v1.3M8 13.2v1.3M2.7 2.7l.9.9M12.4 12.4l.9.9M1.5 8h1.3M13.2 8h1.3M2.7 13.3l.9-.9M12.4 3.6l.9-.9"
    />
  {:else if name === "theme-dark"}
    <path d="M13.2 9.9A5.7 5.7 0 0 1 6.1 2.8a5.7 5.7 0 1 0 7.1 7.1z" />
  {:else if name === "theme-system"}
    <circle cx="8" cy="8" r="5.3" />
    <path d="M8 2.7a5.3 5.3 0 0 1 0 10.6z" fill="currentColor" stroke="none" />
  {:else if name === "todo"}
    <rect x="2.75" y="2.75" width="10.5" height="10.5" rx="2" />
    <path d="M5.75 8l1.5 1.5 3-3.5" />
  {:else if name === "toggle"}
    <path d="M5.5 5l3 3-3 3" />
    <path d="M10.5 12.75h1.75" opacity="0.5" />
  {:else if name === "trash"}
    <path d="M2.75 4.25h10.5" />
    <path d="M6.25 4.25V3c0-.69.56-1.25 1.25-1.25h1c.69 0 1.25.56 1.25 1.25v1.25" />
    <path
      d="m4 4.25.63 8.75c.05.66.6 1.17 1.25 1.17h4.24c.66 0 1.2-.51 1.25-1.17L12 4.25"
    />
    <path d="M6.75 7v4M9.25 7v4" />
  {/if}
</svg>
