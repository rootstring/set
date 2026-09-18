const UNITS = ["B", "kB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const decimals = unit >= 3 && value < 100 ? 1 : 0;
  return `${value.toFixed(decimals)} ${UNITS[unit]}`;
}
