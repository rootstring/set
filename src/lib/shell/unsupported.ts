import { isTauri } from "@tauri-apps/api/core";

/** `?desktop` bypasses the gate, so the mobile build can be worked on from a phone. */
const OVERRIDE = "desktop";

/** `isTauri()` first: the desktop app is a webview too. Safe before the store is up. */
export function isUnsupportedPlatform(): boolean {
  if (isTauri()) return false;
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  if (new URLSearchParams(window.location.search).has(OVERRIDE)) return false;
  return isMobileUserAgent(navigator.userAgent, navigator.maxTouchPoints);
}

/**
 * The decision itself, split out from the globals it reads so it can be tested
 * against real user agent strings rather than a mocked `navigator`.
 */
export function isMobileUserAgent(ua: string, maxTouchPoints: number): boolean {
  // iPadOS 13+ reports a Macintosh user agent; a Mac reports 0 touch points.
  if (/Macintosh/.test(ua) && maxTouchPoints > 1) return true;

  // Not a viewport or `pointer: coarse` test: a narrow window and a touchscreen laptop are both
  // fine.
  return /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|BlackBerry|Opera Mini|IEMobile|webOS|Windows Phone/i.test(
    ua,
  );
}
