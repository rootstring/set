export interface Oklch {
  l: number;
  c: number;
  h: number;
}

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isHex(value: string): boolean {
  return HEX_RE.test(value);
}

function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(s * 255)));
}

function rgbToOklch([r, g, b]: [number, number, number]): Oklch {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(a, bb);
  return { l: L, c, h: c < 1e-4 ? 0 : ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
}

function oklchToLinearRgb({ l, c, h }: Oklch): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

function oklchToRgb(color: Oklch): [number, number, number] {
  const [r, g, b] = oklchToLinearRgb(color);
  return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(b)];
}

function fitChroma(l: number, h: number, wanted: number): number {
  const fits = (c: number) =>
    oklchToLinearRgb({ l, c, h }).every((v) => v >= -0.0002 && v <= 1.0002);
  if (fits(wanted)) return wanted;
  let lo = 0;
  let hi = wanted;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return +lo.toFixed(4);
}

export function hexToOklch(hex: string): Oklch | null {
  if (!HEX_RE.test(hex)) return null;
  let h = hex.slice(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return rgbToOklch([(n >> 16) & 255, (n >> 8) & 255, n & 255]);
}

export function oklchToHex(color: Oklch): string {
  const [r, g, b] = oklchToRgb(color);
  const hex = (v: number) => v.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export function css({ l, c, h }: Oklch, alpha?: number): string {
  const core = `${+(l * 100).toFixed(2)}% ${+c.toFixed(4)} ${+h.toFixed(1)}`;
  return alpha === undefined ? `oklch(${core})` : `oklch(${core} / ${alpha})`;
}

export function parseOklch(value: string): Oklch | null {
  const m = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value.trim());
  if (!m) return null;
  const [l, c, h] = [Number(m[1]) / 100, Number(m[2]), Number(m[3])];
  if (!Number.isFinite(l) || !Number.isFinite(c) || !Number.isFinite(h)) return null;
  return { l, c, h };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export function adjustAccentForTheme(color: Oklch, dark: boolean): Oklch {
  return dark
    ? { l: clamp(color.l, 0.6, 0.84), c: color.c * 0.92, h: color.h }
    : { l: clamp(color.l, 0.46, 0.7), c: color.c, h: color.h };
}

export function inkForTheme(color: Oklch, dark: boolean): Oklch {
  return dark
    ? { l: clamp(color.l, 0.82, 0.9), c: Math.min(color.c, 0.055), h: color.h }
    : { l: clamp(color.l, 0.25, 0.42), c: Math.min(color.c, 0.09), h: color.h };
}

export function softFrom(color: Oklch, dark: boolean): string {
  return dark
    ? css({ l: 0.3, c: fitChroma(0.3, color.h, Math.min(color.c, 0.085)), h: color.h })
    : css({ l: 0.92, c: fitChroma(0.92, color.h, Math.min(color.c, 0.055)), h: color.h });
}

export function softInkFrom(color: Oklch, dark: boolean): string {
  return dark
    ? css({ l: 0.85, c: fitChroma(0.85, color.h, Math.min(color.c, 0.11)), h: color.h })
    : css({ l: 0.38, c: fitChroma(0.38, color.h, Math.min(color.c, 0.17)), h: color.h });
}

export function onAccentFrom(color: Oklch): string {
  return color.l > 0.8 ? "oklch(23% 0.005 106)" : "oklch(100% 0 0)";
}

export function tintFrom(color: Oklch, alpha: number): string {
  return css(color, alpha);
}
