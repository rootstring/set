import { isTauri } from "@tauri-apps/api/core";

/** Desktop: hand it to the OS, or a link would replace the app. Browser: a new tab. */
export async function openExternal(href: string): Promise<void> {
  if (!isTauri()) {
    window.open(href, "_blank", "noopener,noreferrer");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(href);
}
