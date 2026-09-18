/**
 * A note is a plain file anything can write; `javascript:` and `data:` would turn one into a
 * program.
 */

/** Schemes a link in a note may carry. */
const SCHEMES = ["http:", "https:", "mailto:", "tel:", "ftp:"];

/** No scheme gets `https://`, as a browser bar does. Null is what disables the dialog's button. */
export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (!scheme) {
    // Not a URL at all — no dot to make a host, and no path to hang off one.
    if (!/^[^/]+\.[^/.]/.test(trimmed)) return null;
    return `https://${trimmed}`;
  }
  return SCHEMES.includes(scheme[1].toLowerCase() + ":") ? trimmed : null;
}
