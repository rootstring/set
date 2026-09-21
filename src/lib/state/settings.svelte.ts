import { isTauri } from "@tauri-apps/api/core";
import { readLocalJson, writeLocalJson } from "$lib/utils/local-store";
import { version as APP_VERSION } from "../../../package.json";
import {
  type Oklch,
  isHex,
  hexToOklch,
  oklchToHex,
  parseOklch,
  css,
  adjustAccentForTheme,
  inkForTheme,
  softFrom,
  softInkFrom,
  onAccentFrom,
  tintFrom,
} from "./color";

export type Theme = "system" | "light" | "dark";
export type Density = "comfortable" | "compact";

export type FontSize = number;
export type ReadingWidth = "normal" | "wide";
export type BodyFont = "sans" | "system" | "serif" | "mono";

export type DictationLanguage = string;

export const DICTATION_LANGUAGES: { id: DictationLanguage; label: string }[] = [
  { id: "auto", label: "Detect automatically" },
  { id: "en", label: "English" },
  { id: "es", label: "Spanish" },
  { id: "fr", label: "French" },
  { id: "de", label: "German" },
  { id: "it", label: "Italian" },
  { id: "pt", label: "Portuguese" },
  { id: "nl", label: "Dutch" },
  { id: "pl", label: "Polish" },
  { id: "ru", label: "Russian" },
  { id: "ja", label: "Japanese" },
  { id: "ko", label: "Korean" },
  { id: "zh", label: "Chinese" },
  { id: "hi", label: "Hindi" },
  { id: "ar", label: "Arabic" },
  { id: "tr", label: "Turkish" },
];

export type AccentId =
  "blue" | "graphite" | "red" | "amber" | "green" | "teal" | "purple" | "pink";
export type Accent = AccentId | { custom: string };

export type FontColor = Accent | null;

export type Shortcut = string;

export type BindingId =
  | "newPage"
  | "newChildPage"
  | "quickSwitcher"
  | "prevSibling"
  | "nextSibling"
  | "navBack"
  | "navForward"
  | "chroot"
  | "sidebar"
  | "focusMode"
  | "toggleTheme"
  | "lock"
  | "dictate"
  | "trashPage"
  | "openTrash";

export const BINDINGS: { id: BindingId; label: string }[] = [
  { id: "newPage", label: "New page" },
  { id: "newChildPage", label: "New sub-page" },
  { id: "quickSwitcher", label: "Quick switcher" },
  { id: "prevSibling", label: "Previous sibling page" },
  { id: "nextSibling", label: "Next sibling page" },
  { id: "navBack", label: "Back" },
  { id: "navForward", label: "Forward" },
  { id: "chroot", label: "Chroot / Un-chroot" },
  { id: "sidebar", label: "Toggle sidebar" },
  { id: "focusMode", label: "Focus mode" },
  { id: "toggleTheme", label: "Toggle light / dark" },
  { id: "lock", label: "Lock / Unlock page" },
  { id: "dictate", label: "Dictate" },
  { id: "trashPage", label: "Move page to Trash" },
  { id: "openTrash", label: "Open Trash" },
];

const SHORTCUT_FIELDS = {
  newPage: "newPageShortcut",
  newChildPage: "newChildPageShortcut",
  quickSwitcher: "quickSwitcherShortcut",
  prevSibling: "prevSiblingShortcut",
  nextSibling: "nextSiblingShortcut",
  navBack: "navBackShortcut",
  navForward: "navForwardShortcut",
  chroot: "chrootShortcut",
  sidebar: "sidebarShortcut",
  focusMode: "focusModeShortcut",
  toggleTheme: "toggleThemeShortcut",
  lock: "lockShortcut",
  dictate: "dictateShortcut",
  trashPage: "trashPageShortcut",
  openTrash: "openTrashShortcut",
} as const satisfies Record<BindingId, keyof SettingsData>;

export function tauriAccelerator(shortcut: Shortcut): string | null {
  if (!shortcut) return null;
  return shortcut
    .split("+")
    .map((part) =>
      part === "Mod"
        ? "CmdOrCtrl"
        : part.startsWith("Key")
          ? part.slice(3)
          : part.startsWith("Digit")
            ? part.slice(5)
            : part,
    )
    .join("+");
}

interface SettingsData {
  theme: Theme;
  accent: Accent;
  density: Density;
  fontSize: FontSize;
  readingWidth: ReadingWidth;
  bodyFont: BodyFont;
  dragHandle: boolean;
  slashMenu: boolean;
  dateMention: boolean;
  confirmDelete: boolean;
  surfaceTint: string | null;
  fontColor: FontColor;
  /** The last colour each picker was given, kept for when a preset has replaced it. */
  customAccent: string | null;
  customTint: string | null;
  customFontColor: string | null;
  sidebarShortcut: Shortcut;
  newPageShortcut: Shortcut;
  newChildPageShortcut: Shortcut;
  quickSwitcherShortcut: Shortcut;
  prevSiblingShortcut: Shortcut;
  nextSiblingShortcut: Shortcut;
  navBackShortcut: Shortcut;
  navForwardShortcut: Shortcut;
  chrootShortcut: Shortcut;
  focusModeShortcut: Shortcut;
  toggleThemeShortcut: Shortcut;
  lockShortcut: Shortcut;
  dictateShortcut: Shortcut;
  trashPageShortcut: Shortcut;
  openTrashShortcut: Shortcut;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  contextOrder: string[];
  notesFolder: string | null;
  dictationLanguage: DictationLanguage;
  onboardedAt: number | null;
  welcomedAt: number | null;
}

const STORAGE_KEY = "set:settings";

interface SettingsFile {
  app: "set";
  version: string;
  settings: SettingsData;
}

function extractSettings(parsed: unknown): Partial<SettingsData> {
  if (parsed && typeof parsed === "object") {
    const settings = (parsed as Record<string, unknown>).settings;
    if (settings && typeof settings === "object") {
      return settings as Partial<SettingsData>;
    }
  }
  return {};
}

export const ACCENTS: { id: AccentId; label: string; light: string; dark: string }[] = [
  {
    id: "blue",
    label: "Blue",
    light: "oklch(52% 0.21 266)",
    dark: "oklch(64% 0.17 264)",
  },
  {
    id: "graphite",
    label: "Graphite",
    light: "oklch(44% 0.006 265)",
    dark: "oklch(64% 0.006 265)",
  },
  {
    id: "red",
    label: "Red",
    light: "oklch(57% 0.203 33)",
    dark: "oklch(62% 0.2 33)",
  },
  {
    id: "amber",
    label: "Amber",
    light: "oklch(64% 0.13 70)",
    dark: "oklch(66% 0.13 74)",
  },
  {
    id: "green",
    label: "Green",
    light: "oklch(56% 0.125 158)",
    dark: "oklch(64% 0.14 159)",
  },
  {
    id: "teal",
    label: "Teal",
    light: "oklch(58% 0.1 215)",
    dark: "oklch(64% 0.11 214)",
  },
  {
    id: "purple",
    label: "Purple",
    light: "oklch(50% 0.21 300)",
    dark: "oklch(62% 0.19 300)",
  },
  {
    id: "pink",
    label: "Pink",
    light: "oklch(57% 0.21 345)",
    dark: "oklch(64% 0.2 345)",
  },
];

export const SURFACE_TINTS: { id: string; label: string; color: string }[] = ACCENTS.map(
  (a) => ({ id: a.id, label: a.label, color: a.light }),
);

export const FONT_SIZE_STOPS = [12, 13, 14, 15, 16, 17, 18, 20, 22, 24];

function normalizeFontSize(value: unknown): FontSize | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return FONT_SIZE_STOPS.reduce((best, stop) =>
    Math.abs(stop - value) < Math.abs(best - value) ? stop : best,
  );
}

function fontSizeVar(px: FontSize): string | null {
  if (px === DEFAULTS.fontSize) return null;
  return `${px / 16}rem`;
}

const READING_WIDTHS: Record<ReadingWidth, string | null> = {
  normal: null,
  wide: "50rem",
};
const BODY_FONTS: Record<BodyFont, string | null> = {
  sans: null,
  system: "var(--font-system)",
  serif: "var(--font-serif)",
  mono: "var(--font-mono)",
};
const DENSITIES: Record<Density, { lineHeight: string | null; blockGap: string | null }> =
  {
    comfortable: { lineHeight: null, blockGap: null },
    compact: { lineHeight: "1.45", blockGap: "0.2rem" },
  };

function defaultNewPageShortcut(): Shortcut {
  return isTauri() ? "Mod+KeyN" : "Mod+Alt+KeyN";
}

/** A browser keeps ⌘, for itself; the desktop app answers to both. */
export const SETTINGS_SHORTCUT: Shortcut = isTauri() ? "Mod+Comma" : "Mod+Shift+Comma";

/** The modifiers ahead of a context's number: browsers keep ⌘1–9 for their own tabs. */
export const CONTEXT_SHORTCUT_MODS = isTauri() ? "Mod" : "Mod+Alt";

/** The shortcut that switches to the `n`th context (1–9). */
export function contextShortcut(n: number): Shortcut {
  return `${CONTEXT_SHORTCUT_MODS}+Digit${n}`;
}

function defaultNewChildPageShortcut(): Shortcut {
  return isTauri() ? "Mod+Shift+KeyN" : "Mod+Alt+Shift+KeyN";
}

export const SIDEBAR_WIDTH_DEFAULT = 264;
export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 420;

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)));
}

const DEFAULTS: SettingsData = {
  theme: "system",
  accent: "blue",
  density: "comfortable",
  fontSize: 16,
  readingWidth: "normal",
  bodyFont: "sans",
  dragHandle: true,
  slashMenu: true,
  dateMention: true,
  confirmDelete: true,
  surfaceTint: null,
  fontColor: null,
  customAccent: null,
  customTint: null,
  customFontColor: null,
  sidebarShortcut: "Mod+Backslash",
  newPageShortcut: defaultNewPageShortcut(),
  quickSwitcherShortcut: "Mod+KeyK",
  chrootShortcut: "Mod+Shift+Period",
  newChildPageShortcut: defaultNewChildPageShortcut(),
  prevSiblingShortcut: "Mod+Alt+ArrowUp",
  nextSiblingShortcut: "Mod+Alt+ArrowDown",
  navBackShortcut: "Mod+BracketLeft",
  navForwardShortcut: "Mod+BracketRight",
  focusModeShortcut: "Mod+Shift+KeyF",
  toggleThemeShortcut: "Mod+Alt+KeyA",
  lockShortcut: "Mod+Shift+KeyL",
  dictateShortcut: "Mod+Shift+KeyD",
  trashPageShortcut: "Mod+Shift+Backspace",
  openTrashShortcut: "Mod+Shift+KeyY",
  sidebarCollapsed: false,
  sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
  contextOrder: [],
  notesFolder: null,
  dictationLanguage: "auto",
  onboardedAt: null,
  welcomedAt: null,
};

/** `undefined` for a value this build has no meaning for, which is then left alone. */
type Accept = {
  [K in keyof SettingsData]: (value: unknown) => SettingsData[K] | undefined;
};

const asBool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
const asString = <T extends string>(v: unknown) =>
  typeof v === "string" ? (v as T) : undefined;
/** For the fields where the empty string names nothing — a theme, a font. */
const asNamed = <T extends string>(v: unknown) => (v ? asString<T>(v) : undefined);
const asColor = (v: unknown) => (typeof v === "string" && toOklch(v) ? v : undefined);
/** An accent is a palette id or a `{ custom }` wrapper; anything else is not ours to read. */
const asAccent = (v: unknown): Accent | undefined => {
  if (typeof v === "string") return v ? (v as Accent) : undefined;
  if (typeof v !== "object" || v === null) return undefined;
  const picked = asColor((v as { custom?: unknown }).custom);
  return picked === undefined ? undefined : { custom: picked };
};
/** Present but null is a real value for these — "no tint", "no colour of its own". */
const orNull =
  <T>(read: (v: unknown) => T | undefined) =>
  (v: unknown): T | null | undefined =>
    v === null ? null : read(v);

const ACCEPT: Accept = {
  theme: asNamed<Theme>,
  accent: asAccent,
  density: asNamed<Density>,
  fontSize: (v) => normalizeFontSize(v) ?? undefined,
  // An unknown width falls back to the default rather than setting the column to nothing.
  readingWidth: (v) =>
    typeof v === "string" && v in READING_WIDTHS ? (v as ReadingWidth) : undefined,
  bodyFont: asNamed<BodyFont>,
  dragHandle: asBool,
  slashMenu: asBool,
  dateMention: asBool,
  confirmDelete: asBool,
  surfaceTint: orNull(asColor),
  fontColor: orNull(asAccent),
  customAccent: orNull(asColor),
  customTint: orNull(asColor),
  customFontColor: orNull(asColor),
  sidebarShortcut: asString<Shortcut>,
  newPageShortcut: asString<Shortcut>,
  newChildPageShortcut: asString<Shortcut>,
  quickSwitcherShortcut: asString<Shortcut>,
  prevSiblingShortcut: asString<Shortcut>,
  nextSiblingShortcut: asString<Shortcut>,
  navBackShortcut: asString<Shortcut>,
  navForwardShortcut: asString<Shortcut>,
  chrootShortcut: asString<Shortcut>,
  focusModeShortcut: asString<Shortcut>,
  toggleThemeShortcut: asString<Shortcut>,
  lockShortcut: asString<Shortcut>,
  dictateShortcut: asString<Shortcut>,
  trashPageShortcut: asString<Shortcut>,
  openTrashShortcut: asString<Shortcut>,
  sidebarCollapsed: asBool,
  sidebarWidth: (v) =>
    typeof v === "number" && Number.isFinite(v) ? clampSidebarWidth(v) : undefined,
  contextOrder: (v) =>
    Array.isArray(v) ? v.filter((n): n is string => typeof n === "string") : undefined,
  notesFolder: orNull(asString<string>),
  dictationLanguage: asNamed<DictationLanguage>,
  onboardedAt: orNull((v) => (typeof v === "number" ? v : undefined)),
  welcomedAt: orNull((v) => (typeof v === "number" ? v : undefined)),
};

const SETTINGS_KEYS = Object.keys(ACCEPT) as (keyof SettingsData)[];

function defaultShortcutFor(id: BindingId): Shortcut {
  if (id === "newPage") return defaultNewPageShortcut();
  if (id === "newChildPage") return defaultNewChildPageShortcut();
  return DEFAULTS[SHORTCUT_FIELDS[id]];
}

const SETTINGS_FILE = "settings.json";

function accentFor(accent: Accent, dark: boolean): Oklch | null {
  if (accent === "blue") return null; // token default, no override
  if (typeof accent === "string") {
    const a = ACCENTS.find((x) => x.id === accent);
    return a ? parseOklch(dark ? a.dark : a.light) : null;
  }
  const picked = toOklch(accent.custom);
  return picked ? adjustAccentForTheme(picked, dark) : null;
}

function paletteColor(id: AccentId, dark: boolean): Oklch {
  const a = ACCENTS.find((x) => x.id === id) ?? ACCENTS[0];
  return parseOklch(dark ? a.dark : a.light) ?? { l: 0.6, c: 0, h: 0 };
}

function normalizeCustom(value: Accent): Accent {
  if (typeof value === "string") return value;
  const color = toOklch(value.custom);
  return color ? { custom: css(color) } : value;
}

function toOklch(value: string): Oklch | null {
  return parseOklch(value) ?? (isHex(value) ? hexToOklch(value) : null);
}

function fontInkFor(fc: FontColor, dark: boolean): Oklch | null {
  if (fc === null) return null;
  const picked =
    typeof fc === "string" ? (toOklch(fc) ?? paletteColor(fc, dark)) : toOklch(fc.custom);
  return picked ? inkForTheme(picked, dark) : null;
}

const DEFAULT_TEXT: Record<"light" | "dark", string> = {
  light: "oklch(23% 0.005 106)",
  dark: "oklch(94% 0.002 106)",
};

function setVar(root: HTMLElement, name: string, value: string | null): void {
  if (value === null) root.style.removeProperty(name);
  else root.style.setProperty(name, value);
}

function applyAccent(root: HTMLElement, accent: Accent, dark: boolean): void {
  const color = accentFor(accent, dark);
  if (!color) {
    setVar(root, "--accent", null);
    setVar(root, "--accent-soft", null);
    setVar(root, "--accent-ink", null);
    setVar(root, "--on-accent", null);
    return;
  }
  setVar(root, "--accent", css(color));
  setVar(root, "--accent-soft", softFrom(color, dark));
  setVar(root, "--accent-ink", softInkFrom(color, dark));
  setVar(root, "--on-accent", onAccentFrom(color));
}

function applyFontColor(root: HTMLElement, fc: FontColor, dark: boolean): void {
  const ink = fontInkFor(fc, dark);
  const value = ink && css(ink);
  const step = (pct: number) =>
    value === null ? null : `color-mix(in oklab, ${value} ${pct}%, var(--bg))`;
  setVar(root, "--text", value);
  setVar(root, "--text-muted", step(62));
  setVar(root, "--text-subtle", step(40));
}

function applyTint(
  root: HTMLElement,
  name: string,
  tint: string | null,
  alpha: number,
): void {
  const color = tint ? toOklch(tint) : null;
  setVar(root, name, color ? tintFrom(color, alpha) : null);
}

const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

export const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent);

/**
 * Linux runs frameless (see `lib.rs`), so the app draws its own window buttons and carries the
 * menu's shortcuts.
 */
export const IS_LINUX =
  typeof navigator !== "undefined" &&
  /Linux|X11/.test(navigator.platform || navigator.userAgent) &&
  !/Android/.test(navigator.userAgent);

/**
 * Windows keeps its native title bar, so `WindowNav.svelte` gets the slim bar Linux draws, minus
 * the buttons.
 */
export const IS_WINDOWS =
  typeof navigator !== "undefined" &&
  /Win/.test(navigator.platform || navigator.userAgent);

export function shortcutFromEvent(e: KeyboardEvent): Shortcut | null {
  if (MODIFIER_CODES.has(e.code)) return null;
  if (!(e.metaKey || e.ctrlKey || e.altKey)) return null;
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("Mod");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(e.code);
  return parts.join("+");
}

export function matchesShortcut(e: KeyboardEvent, shortcut: Shortcut): boolean {
  return shortcut !== "" && shortcutFromEvent(e) === shortcut;
}

function keyLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  const map: Record<string, string> = {
    Backslash: "\\",
    Slash: "/",
    Period: ".",
    Comma: ",",
    Semicolon: ";",
    Quote: "'",
    BracketLeft: "[",
    BracketRight: "]",
    Minus: "-",
    Equal: "=",
    Backquote: "`",
    Space: "Space",
    Backspace: "⌫",
    Delete: "⌦",
    Enter: "↵",
    Tab: "⇥",
    Escape: "Esc",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
  };
  return map[code] ?? code;
}

/** Empty when the binding has been cleared. */
export function shortcutHint(shortcut: Shortcut): string {
  return shortcut ? ` (${formatShortcut(shortcut)})` : "";
}

export function formatShortcut(shortcut: Shortcut): string {
  if (!shortcut) return "";
  const label = (p: string) =>
    p === "Mod"
      ? IS_MAC
        ? "⌘"
        : "Ctrl"
      : p === "Alt"
        ? IS_MAC
          ? "⌥"
          : "Alt"
        : p === "Shift"
          ? IS_MAC
            ? "⇧"
            : "Shift"
          : keyLabel(p);
  return shortcut
    .split("+")
    .map(label)
    .join(IS_MAC ? "" : "+");
}

class Settings {
  theme = $state<Theme>(DEFAULTS.theme);
  accent = $state<Accent>(DEFAULTS.accent);
  density = $state<Density>(DEFAULTS.density);
  fontSize = $state<FontSize>(DEFAULTS.fontSize);
  readingWidth = $state<ReadingWidth>(DEFAULTS.readingWidth);
  bodyFont = $state<BodyFont>(DEFAULTS.bodyFont);
  dragHandle = $state<boolean>(DEFAULTS.dragHandle);
  slashMenu = $state<boolean>(DEFAULTS.slashMenu);
  dateMention = $state<boolean>(DEFAULTS.dateMention);
  confirmDelete = $state<boolean>(DEFAULTS.confirmDelete);
  surfaceTint = $state<string | null>(DEFAULTS.surfaceTint);
  fontColor = $state<FontColor>(DEFAULTS.fontColor);
  customAccent = $state<string | null>(DEFAULTS.customAccent);
  customTint = $state<string | null>(DEFAULTS.customTint);
  customFontColor = $state<string | null>(DEFAULTS.customFontColor);
  sidebarShortcut = $state<Shortcut>(DEFAULTS.sidebarShortcut);
  newPageShortcut = $state<Shortcut>(DEFAULTS.newPageShortcut);

  private newPageChosen = false;
  newChildPageShortcut = $state<Shortcut>(DEFAULTS.newChildPageShortcut);
  private newChildPageChosen = false;
  quickSwitcherShortcut = $state<Shortcut>(DEFAULTS.quickSwitcherShortcut);
  prevSiblingShortcut = $state<Shortcut>(DEFAULTS.prevSiblingShortcut);
  nextSiblingShortcut = $state<Shortcut>(DEFAULTS.nextSiblingShortcut);
  navBackShortcut = $state<Shortcut>(DEFAULTS.navBackShortcut);
  navForwardShortcut = $state<Shortcut>(DEFAULTS.navForwardShortcut);
  chrootShortcut = $state<Shortcut>(DEFAULTS.chrootShortcut);
  focusModeShortcut = $state<Shortcut>(DEFAULTS.focusModeShortcut);
  toggleThemeShortcut = $state<Shortcut>(DEFAULTS.toggleThemeShortcut);
  lockShortcut = $state<Shortcut>(DEFAULTS.lockShortcut);
  dictateShortcut = $state<Shortcut>(DEFAULTS.dictateShortcut);
  trashPageShortcut = $state<Shortcut>(DEFAULTS.trashPageShortcut);
  openTrashShortcut = $state<Shortcut>(DEFAULTS.openTrashShortcut);
  sidebarCollapsed = $state<boolean>(DEFAULTS.sidebarCollapsed);
  sidebarWidth = $state<number>(DEFAULTS.sidebarWidth);
  contextOrder = $state<string[]>([...DEFAULTS.contextOrder]);
  notesFolder = $state<string | null>(DEFAULTS.notesFolder);
  dictationLanguage = $state<DictationLanguage>(DEFAULTS.dictationLanguage);
  onboardedAt = $state<number | null>(DEFAULTS.onboardedAt);
  welcomedAt = $state<number | null>(DEFAULTS.welcomedAt);

  settled = $state(false);

  private systemDark = $state(false);

  private hadLocal = false;

  constructor() {
    this.hadLocal = this.load();
  }

  get isDarkTheme(): boolean {
    if (this.theme === "dark") return true;
    if (this.theme === "light") return false;
    return this.systemDark;
  }

  init(): void {
    if (!this.newPageChosen) this.newPageShortcut = defaultNewPageShortcut();
    if (!this.newChildPageChosen) {
      this.newChildPageShortcut = defaultNewChildPageShortcut();
    }
    this.watchSystemTheme();
    this.apply();

    if (!this.hadLocal && isTauri()) {
      void this.loadConfigFile().finally(() => this.settle());
    } else {
      this.settle();
    }
  }

  private settle(): void {
    this.settled = true;
  }

  private watchSystemTheme(): void {
    if (typeof matchMedia === "undefined") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    this.systemDark = mq.matches;
    mq.addEventListener("change", (e) => {
      this.systemDark = e.matches;
      if (this.theme === "system") this.apply();
    });
  }

  private load(): boolean {
    const raw = readLocalJson(STORAGE_KEY);
    if (raw === undefined) return false;
    try {
      this.assign(extractSettings(raw));
      return true;
    } catch {
      return false;
    }
  }

  private async loadConfigFile(): Promise<void> {
    try {
      const { exists, readTextFile, BaseDirectory } =
        await import("@tauri-apps/plugin-fs");
      if (!(await exists(SETTINGS_FILE, { baseDir: BaseDirectory.AppConfig }))) return;
      const text = await readTextFile(SETTINGS_FILE, {
        baseDir: BaseDirectory.AppConfig,
      });
      this.assign(extractSettings(JSON.parse(text)));
      this.apply();
      this.persist(); // seed localStorage from the file
    } catch {
      // no config file yet, or it is unreadable; the localStorage copy stands
    }
  }

  private async writeConfigFile(): Promise<void> {
    try {
      const { mkdir, writeTextFile, BaseDirectory } =
        await import("@tauri-apps/plugin-fs");
      await mkdir("", { baseDir: BaseDirectory.AppConfig, recursive: true });
      await writeTextFile(SETTINGS_FILE, this.toExportJSON(), {
        baseDir: BaseDirectory.AppConfig,
      });
    } catch {
      // the file is a mirror for other installs to read; localStorage is the source
    }
  }

  /** Driven by `ACCEPT` so a new setting is one entry. */
  private assign(d: Partial<SettingsData>): void {
    for (const key of SETTINGS_KEYS) {
      const value = ACCEPT[key](d[key]);
      if (value === undefined) continue;
      (this as Record<string, unknown>)[key] = value;
      if (key === "newPageShortcut") this.newPageChosen = true;
      if (key === "newChildPageShortcut") this.newChildPageChosen = true;
    }
    this.rememberCustoms();
  }

  /**
   * The setters keep each remembered custom colour beside the one in use; stored settings
   * can arrive without it (written by an older build, hand-edited, or dropped as invalid),
   * and a swatch that is in use with nothing remembered has no colour to name.
   */
  private rememberCustoms(): void {
    if (typeof this.accent === "object") this.customAccent = this.accent.custom;
    if (this.isCustomTint) this.customTint = this.surfaceTint;
    if (this.fontColor !== null && typeof this.fontColor === "object") {
      this.customFontColor = this.fontColor.custom;
    }
  }

  private data(): SettingsData {
    const out: Partial<SettingsData> = {};
    for (const key of SETTINGS_KEYS) {
      (out as Record<string, unknown>)[key] = this[key];
    }
    return out as SettingsData;
  }

  private persist(): void {
    const file: SettingsFile = {
      app: "set",
      version: APP_VERSION,
      settings: this.data(),
    };
    writeLocalJson(STORAGE_KEY, file);

    if (isTauri()) void this.writeConfigFile();
  }

  get appVersion(): string {
    return APP_VERSION;
  }

  toExportJSON(): string {
    const file: SettingsFile = {
      app: "set",
      version: APP_VERSION,
      settings: this.data(),
    };
    return JSON.stringify(file, null, 2);
  }

  importFromJSON(text: string): boolean {
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || parsed.app !== "set") {
        return false; // not Set's settings file
      }
      this.assign(extractSettings(parsed));
      this.commit();
      return true;
    } catch {
      return false;
    }
  }

  apply(): void {
    if (typeof document === "undefined") return;
    const root = document.documentElement;

    if (this.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", this.theme);

    applyAccent(root, this.accent, this.isDarkTheme);

    setVar(root, "--editor-font-size", fontSizeVar(this.fontSize));
    setVar(root, "--reading-width", READING_WIDTHS[this.readingWidth]);
    setVar(root, "--font-body", BODY_FONTS[this.bodyFont]);
    setVar(root, "--sidebar-width", `${this.sidebarWidth}px`);

    const density = DENSITIES[this.density];
    setVar(root, "--editor-line-height", density.lineHeight);
    setVar(root, "--block-gap", density.blockGap);

    if (this.dragHandle) root.removeAttribute("data-drag-handle");
    else root.setAttribute("data-drag-handle", "off");

    applyTint(root, "--surface-tint", this.surfaceTint, 0.16);
    applyTint(root, "--editor-tint", this.surfaceTint, 0.06);

    setVar(root, "--danger-tint", this.surfaceTint);
    setVar(root, "--warning-tint", this.surfaceTint);

    applyFontColor(root, this.fontColor, this.isDarkTheme);
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.commit();
  }
  setAccent(accent: Accent): void {
    this.accent = normalizeCustom(accent);
    if (typeof this.accent === "object") this.customAccent = this.accent.custom;
    this.commit();
  }
  setDensity(density: Density): void {
    this.density = density;
    this.commit();
  }

  setFontSize(fontSize: FontSize): void {
    this.fontSize = normalizeFontSize(fontSize) ?? DEFAULTS.fontSize;
    this.commit();
  }
  setReadingWidth(readingWidth: ReadingWidth): void {
    this.readingWidth = readingWidth;
    this.commit();
  }
  setBodyFont(bodyFont: BodyFont): void {
    this.bodyFont = bodyFont;
    this.commit();
  }
  setDragHandle(on: boolean): void {
    this.dragHandle = on;
    this.commit();
  }
  setSlashMenu(on: boolean): void {
    this.slashMenu = on;
    this.commit();
  }
  setDateMention(on: boolean): void {
    this.dateMention = on;
    this.commit();
  }
  setConfirmDelete(on: boolean): void {
    this.confirmDelete = on;
    this.commit();
  }

  setSurfaceTint(tint: string | null): void {
    const color = tint === null ? null : toOklch(tint);
    this.surfaceTint = color ? css(color) : null;
    if (this.isCustomTint) this.customTint = this.surfaceTint;
    this.commit();
  }

  setFontColor(color: FontColor): void {
    this.fontColor = color === null ? null : normalizeCustom(color);
    if (this.fontColor && typeof this.fontColor === "object") {
      this.customFontColor = this.fontColor.custom;
    }
    this.commit();
  }

  setSidebarCollapsed(collapsed: boolean): void {
    this.sidebarCollapsed = collapsed;
    this.commit();
  }

  setSidebarWidth(width: number): void {
    this.sidebarWidth = clampSidebarWidth(width);
    this.commit();
  }

  setContextOrder(names: string[]): void {
    this.contextOrder = [...names];
    this.commit();
  }

  orderContexts<T extends { name: string }>(contexts: T[]): T[] {
    const rank = new Map(this.contextOrder.map((name, i) => [name, i]));
    return [...contexts].sort((a, b) => {
      const ra = rank.get(a.name) ?? Infinity;
      const rb = rank.get(b.name) ?? Infinity;
      return ra === rb ? a.name.localeCompare(b.name) : ra - rb;
    });
  }

  setNotesFolder(path: string | null): void {
    this.notesFolder = path;
    this.commit();
  }

  setDictationLanguage(language: DictationLanguage): void {
    this.dictationLanguage = language;
    this.commit();
  }

  completeOnboarding(): void {
    if (this.onboardedAt !== null) return;
    this.onboardedAt = Date.now();
    this.commit();
  }

  completeWelcome(): void {
    if (this.welcomedAt !== null) return;
    this.welcomedAt = Date.now();
    this.commit();
  }

  shortcut(id: BindingId): Shortcut {
    return this[SHORTCUT_FIELDS[id]];
  }

  setShortcut(id: BindingId, shortcut: Shortcut): void {
    if (shortcut) {
      for (const other of BINDINGS) {
        if (other.id !== id && this.shortcut(other.id) === shortcut) {
          this.assignShortcut(other.id, "");
        }
      }
    }
    this.assignShortcut(id, shortcut);
    this.commit();
  }

  private assignShortcut(id: BindingId, shortcut: Shortcut): void {
    this[SHORTCUT_FIELDS[id]] = shortcut;
  }

  resetAppearance(): void {
    this.theme = DEFAULTS.theme;
    this.accent = DEFAULTS.accent;
    this.density = DEFAULTS.density;
    this.surfaceTint = DEFAULTS.surfaceTint;
    this.fontColor = DEFAULTS.fontColor;
    // A reset puts the look back, not the pickers' memory.
    this.commit();
  }

  resetEditor(): void {
    this.fontSize = DEFAULTS.fontSize;
    this.readingWidth = DEFAULTS.readingWidth;
    this.bodyFont = DEFAULTS.bodyFont;
    this.dragHandle = DEFAULTS.dragHandle;
    this.slashMenu = DEFAULTS.slashMenu;
    this.dateMention = DEFAULTS.dateMention;
    this.confirmDelete = DEFAULTS.confirmDelete;
    this.commit();
  }

  resetShortcuts(): void {
    for (const binding of BINDINGS) {
      this.assignShortcut(binding.id, defaultShortcutFor(binding.id));
    }
    this.commit();
  }

  get isCustomAccent(): boolean {
    return typeof this.accent === "object";
  }

  get isCustomTint(): boolean {
    return (
      this.surfaceTint !== null &&
      !SURFACE_TINTS.some((t) => t.color === this.surfaceTint)
    );
  }

  get accentColor(): string {
    if (typeof this.accent === "object") {
      return toOklch(this.accent.custom) ? this.accent.custom : DEFAULT_ACCENT;
    }
    const a = ACCENTS.find((x) => x.id === this.accent);
    return a ? (this.isDarkTheme ? a.dark : a.light) : DEFAULT_ACCENT;
  }

  get accentPickerValue(): string {
    return asHex(this.accentColor, DEFAULT_ACCENT);
  }

  get tintPickerValue(): string {
    return asHex(this.surfaceTint ?? "", ACCENTS[1].light);
  }

  get isCustomFontColor(): boolean {
    return typeof this.fontColor === "object" && this.fontColor !== null;
  }

  get fontColorValue(): string {
    const picked =
      this.fontColor && typeof this.fontColor === "object"
        ? this.fontColor.custom
        : typeof this.fontColor === "string"
          ? css(paletteColor(this.fontColor, this.isDarkTheme))
          : this.defaultTextColor;
    return asHex(picked, this.defaultTextColor);
  }

  get defaultTextColor(): string {
    return DEFAULT_TEXT[this.isDarkTheme ? "dark" : "light"];
  }

  fontInk(color: FontColor): string {
    const ink = fontInkFor(color, this.isDarkTheme);
    return ink ? css(ink) : this.defaultTextColor;
  }

  private commit(): void {
    this.persist();
    this.apply();
  }
}

const DEFAULT_ACCENT = "oklch(52% 0.21 266)";

export function asHex(value: string, fallback = "#000000"): string {
  return oklchToHex(toOklch(value) ?? toOklch(fallback) ?? { l: 0, c: 0, h: 0 });
}

export const settings = new Settings();
