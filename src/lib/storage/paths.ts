export const ASSETS_DIR = "Set-page-assets";

export const TRASH_DIR = "Set-Trash";

/** Reserved at every level, so no reader has to remember where they are special. */
export function isReserved(base: string): boolean {
  const lower = base.toLowerCase();
  return lower === ASSETS_DIR.toLowerCase() || lower === TRASH_DIR.toLowerCase();
}

export const DEFAULT_CONTEXT = "Set";

export function contextOf(rel: string): string {
  const i = rel.indexOf("/");
  return i === -1 ? DEFAULT_CONTEXT : rel.slice(0, i);
}

/** A context's own trash: the pages deleted out of it, inside it. */
export function trashOf(context: string): string {
  return joinRel(context, TRASH_DIR);
}

export function sanitizeContextName(name: string): string | null {
  const cleaned = name
    .trim()
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 60)
    .trim();

  if (!/[\p{L}\p{N}]/u.test(cleaned)) return null;
  return isReserved(cleaned) ? null : cleaned;
}

export function stripMd(rel: string): string {
  return rel.replace(/\.md$/i, "");
}

export function baseName(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? rel : rel.slice(i + 1);
}

export function dirOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
}

export function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function sanitizeTitle(title: string): string {
  const cleaned = title
    .trim()
    .replace(/[/\\:*?"<>| -]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\.+$/, "")
    .slice(0, 120)
    .trim();
  return cleaned || "Untitled";
}

export function assetRef(base: string, fileName: string): string {
  return `${base}/${ASSETS_DIR}/${fileName}`;
}

export function assetFileName(ref: string): string | null {
  const parts = ref.split("/");

  if (parts.length < 2 || parts[parts.length - 2] !== ASSETS_DIR) return null;
  const name = parts[parts.length - 1];

  if (!name || name === "." || name === "..") return null;
  return name;
}

export function normalizeAssetRefs(markdown: string, base: string): string {
  if (!markdown.includes(ASSETS_DIR)) return markdown;

  const restamp = (ref: string): string | null => {
    const name = assetFileName(ref);
    if (!name) return null;
    const wanted = assetRef(base, name);
    return wanted === ref ? null : wanted;
  };

  let out = markdown.replace(/\]\(\s*(<[^>\n]*>|[^)\s]+)/g, (whole, raw: string) => {
    const angled = raw.startsWith("<") && raw.endsWith(">");
    const next = restamp(angled ? raw.slice(1, -1) : raw);
    return next === null ? whole : `](${formatTarget(next)}`;
  });

  out = out.replace(
    /(<img\b[^>]*?\bsrc=")([^"]*)(")/gi,
    (whole, open: string, raw: string, close: string) => {
      const next = restamp(raw);
      return next === null ? whole : `${open}${next}${close}`;
    },
  );

  return out;
}

export function findAssetRefs(markdown: string): string[] {
  if (!markdown.includes(ASSETS_DIR)) return [];
  const names = new Set<string>();
  const collect = (raw: string) => {
    const name = assetFileName(raw);
    if (name) names.add(name);
  };
  for (const m of markdown.matchAll(/\]\(\s*(<[^>\n]*>|[^)\s]+)/g)) {
    const raw = m[1];
    collect(raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw);
  }
  for (const m of markdown.matchAll(/<img\b[^>]*?\bsrc="([^"]*)"/gi)) {
    collect(m[1]);
  }
  return [...names];
}

export function isDisplayableUrl(ref: string): boolean {
  return /^(https?|data):/i.test(ref);
}

export function formatTarget(ref: string): string {
  return /[()\s]/.test(ref) ? `<${ref}>` : ref;
}
