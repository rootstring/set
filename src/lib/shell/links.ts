import { invoke, isTauri } from "@tauri-apps/api/core";
import { settings } from "$lib/state/settings.svelte";
import { openExternal } from "$lib/utils/open-url";

const FEEDBACK_URL = "https://feedback.writewithset.com";
const DONATE_URL = "https://ko-fi.com/writewithset";
const SOURCE_URL = "https://github.com/rootstring/set";
const DOWNLOAD_URL = "https://writewithset.com?download=true";

/** `platform` values are the form's own; unknown ones are left out. */
export async function feedbackUrl(): Promise<string> {
  const platform = isTauri()
    ? await invoke<string | null>("platform").catch(() => null)
    : "browser";
  const params = new URLSearchParams({ version: settings.appVersion });
  if (platform) params.set("platform", platform);
  return `${FEEDBACK_URL}?${params}`;
}

export async function openFeedback(): Promise<void> {
  await openExternal(await feedbackUrl());
}

export function openDonate(): Promise<void> {
  return openExternal(DONATE_URL);
}

/** AGPL-3.0 §13 asks the hosted build to offer its source. */
export function openSource(): Promise<void> {
  return openExternal(SOURCE_URL);
}

/** The latest desktop builds, offered on the web build where updates would be. */
export function openDownload(): Promise<void> {
  return openExternal(DOWNLOAD_URL);
}
