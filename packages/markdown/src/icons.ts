/** Icons shared by the editor's node views and the published page, so both draw the same thing. */

const svg = (body: string, stroke = "1.4") =>
  '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" ' +
  `stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  body +
  "</svg>";

/** A child page. */
export const PAGE_ICON = svg(
  '<path d="M9 1.83H4.75c-.69 0-1.25.56-1.25 1.25v9.84c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25V5.5Z"/>' +
    '<path d="M9 1.83V5.5h3.5"/><path d="M5.75 8.75h4.5M5.75 11.25h3"/>',
);

/** A `[[wikilink]]`: the page, with an arrow. */
export const WIKI_LINK_ICON = svg(
  '<path d="M9 1.83H4.75c-.69 0-1.25.56-1.25 1.25v9.84c0 .69.56 1.25 1.25 1.25h6.5' +
    'c.69 0 1.25-.56 1.25-1.25V5.5Z"/><path d="M9 1.83V5.5h3.5"/>' +
    '<path d="M5.85 9.55h3.6M8.1 8.1l1.45 1.45-1.45 1.45"/>',
);

export const CALENDAR_ICON = svg(
  '<rect x="2.25" y="3" width="11.5" height="10.5" rx="1.75"/>' +
    '<path d="M5.25 1.75V4.25M10.75 1.75V4.25M2.25 6.5h11.5"/>',
);

/** GitHub's five alert kinds; others (Obsidian) are kept and drawn as a note. */
export const CALLOUT_KINDS = ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"] as const;

export const CALLOUT_ICONS: Record<string, string> = {
  note: svg('<circle cx="8" cy="8" r="5.75"/><path d="M8 7.25v3.5M8 5.25h.01"/>'),
  tip: svg(
    '<path d="M6 12.25h4M6.75 14h2.5"/><path d="M8 2a4 4 0 0 0-2.4 7.2c.4.3.65.75.65 1.25v.3h3.5v-.3c0-.5.25-.95.65-1.25A4 4 0 0 0 8 2Z"/>',
  ),
  important: svg(
    '<path d="M2.75 3.25h10.5v7.5H8.5l-3 2.5v-2.5H2.75z"/><path d="M8 5v2.75M8 9.25h.01"/>',
  ),
  warning: svg('<path d="M8 2.25 14 13H2z"/><path d="M8 6.5v3M8 11.25h.01"/>'),
  caution: svg(
    '<path d="M5.5 2h5L14 5.5v5L10.5 14h-5L2 10.5v-5z"/><path d="M8 5v3.5M8 10.75h.01"/>',
  ),
};

/** A callout's header when it has no title of its own: `WARNING` → `Warning`. */
export const calloutLabel = (kind: string) =>
  kind.charAt(0).toUpperCase() + kind.slice(1).toLowerCase();
