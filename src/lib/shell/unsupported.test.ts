import { describe, expect, it } from "vitest";
import { isMobileUserAgent } from "./unsupported";

/**
 * Real user agent strings. The last pair matter most: an iPad claiming to be a Mac, and a
 * touchscreen laptop.
 */
const UA = {
  iPhone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  androidFirefox: "Mozilla/5.0 (Android 14; Mobile; rv:121.0) Gecko/121.0 Firefox/121.0",
  androidTablet:
    "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  linux: "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
};

describe("isMobileUserAgent", () => {
  it("gates phones", () => {
    expect(isMobileUserAgent(UA.iPhone, 5)).toBe(true);
    expect(isMobileUserAgent(UA.androidChrome, 5)).toBe(true);
    expect(isMobileUserAgent(UA.androidFirefox, 5)).toBe(true);
  });

  it("gates tablets, which have the same problem", () => {
    expect(isMobileUserAgent(UA.androidTablet, 5)).toBe(true);
  });

  it("gates an iPad despite its Macintosh user agent", () => {
    expect(isMobileUserAgent(UA.mac, 5)).toBe(true);
  });

  it("lets desktops through", () => {
    expect(isMobileUserAgent(UA.mac, 0)).toBe(false);
    expect(isMobileUserAgent(UA.windows, 0)).toBe(false);
    expect(isMobileUserAgent(UA.linux, 0)).toBe(false);
  });

  it("lets a touchscreen laptop through", () => {
    expect(isMobileUserAgent(UA.windows, 10)).toBe(false);
  });
});
