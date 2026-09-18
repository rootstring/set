import { describe, expect, it } from "vitest";
import { formatBytes } from "./bytes";

describe("formatBytes", () => {
  it("counts in the units the OS counts in", () => {
    expect(formatBytes(487_601_967)).toBe("488 MB");
  });

  it("drops the tenths below a gigabyte", () => {
    expect(formatBytes(12_340_000)).toBe("12 MB");
    expect(formatBytes(900_000_000)).toBe("900 MB");
  });

  it("keeps the tenths above a gigabyte, where they're all that moves", () => {
    expect(formatBytes(1_200_000_000)).toBe("1.2 GB");
    expect(formatBytes(2_900_000_000)).toBe("2.9 GB");
  });

  it("steps up through the units", () => {
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1_000)).toBe("1 kB");
    expect(formatBytes(1_000_000)).toBe("1 MB");
  });

  it("says nothing rather than NaN when there's nothing to say", () => {
    expect(formatBytes(0)).toBe("0 MB");
    expect(formatBytes(-1)).toBe("0 MB");
    expect(formatBytes(Number.NaN)).toBe("0 MB");
  });
});
