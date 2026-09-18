import { describe, expect, it } from "vitest";

import { normalizeUrl } from "./url";

describe("normalizeUrl", () => {
  it("keeps a URL that already says what it is", () => {
    expect(normalizeUrl("https://example.com/download")).toBe(
      "https://example.com/download",
    );
    expect(normalizeUrl("http://localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeUrl("mailto:hi@example.com")).toBe("mailto:hi@example.com");
  });

  it("gives a bare host the scheme every browser bar gives it", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com");
    expect(normalizeUrl("example.com/a/b?c=d")).toBe("https://example.com/a/b?c=d");
  });

  it("trims what was pasted with it", () => {
    expect(normalizeUrl("  https://example.com  ")).toBe("https://example.com");
  });

  it("refuses the schemes that would make a note a program", () => {
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("JavaScript:alert(1)")).toBeNull();
    expect(normalizeUrl("data:text/html;base64,PHN2Zz4=")).toBeNull();
    expect(normalizeUrl("file:///etc/passwd")).toBeNull();
  });

  it("refuses what isn't a link at all", () => {
    expect(normalizeUrl("")).toBeNull();
    expect(normalizeUrl("   ")).toBeNull();
    expect(normalizeUrl("read the docs")).toBeNull();
    expect(normalizeUrl("just-a-word")).toBeNull();
  });
});
