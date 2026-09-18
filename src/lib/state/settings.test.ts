import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The class is private; each case seeds storage and re-imports for a fresh singleton. */
async function loadSettings(stored: Record<string, unknown>) {
  const raw = JSON.stringify({ app: "set", version: "0.0.0", settings: stored });
  const store = new Map([["set:settings", raw]]);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.resetModules();
  return await import("./settings.svelte");
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe("settings loaded from storage", () => {
  // Settings written before the remembered-colour fields existed: the swatch showed as in
  // use with nothing to name, and reading its title threw on the missing colour.
  it("remembers a custom accent that arrives without one", async () => {
    const { settings, asHex } = await loadSettings({
      accent: { custom: "oklch(60% 0.15 120)" },
    });
    expect(settings.isCustomAccent).toBe(true);
    expect(settings.customAccent).toBe("oklch(60% 0.15 120)");
    expect(asHex(settings.customAccent!)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("remembers a custom tint that arrives without one", async () => {
    const { settings } = await loadSettings({ surfaceTint: "oklch(92% 0.03 250)" });
    expect(settings.isCustomTint).toBe(true);
    expect(settings.customTint).toBe("oklch(92% 0.03 250)");
  });

  it("remembers a custom font colour that arrives without one", async () => {
    const { settings } = await loadSettings({
      fontColor: { custom: "oklch(40% 0.1 300)" },
    });
    expect(settings.isCustomFontColor).toBe(true);
    expect(settings.customFontColor).toBe("oklch(40% 0.1 300)");
  });

  it("keeps a preset tint out of the custom slot", async () => {
    const { settings, SURFACE_TINTS } = await loadSettings({
      surfaceTint: SURFACE_TINTS_COLOR,
    });
    expect(SURFACE_TINTS.some((t) => t.color === settings.surfaceTint)).toBe(true);
    expect(settings.isCustomTint).toBe(false);
    expect(settings.customTint).toBe(null);
  });

  it("ignores an accent that is not a palette id or a colour", async () => {
    for (const accent of [{}, { custom: null }, { custom: "nonsense" }, 42, []]) {
      const { settings } = await loadSettings({ accent });
      expect(settings.accent).toBe("blue");
      expect(settings.accentPickerValue).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("ignores a font colour that is not a palette id or a colour", async () => {
    const { settings } = await loadSettings({ fontColor: { custom: 7 } });
    expect(settings.fontColor).toBe(null);
    expect(settings.fontColorValue).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("keeps an explicit null font colour", async () => {
    const { settings } = await loadSettings({ fontColor: null });
    expect(settings.fontColor).toBe(null);
  });
});

/** The blue preset's light value, the first entry of `SURFACE_TINTS`. */
const SURFACE_TINTS_COLOR = "oklch(52% 0.21 266)";
