import { describe, expect, it } from "vitest";
import { scrollSpeed } from "./drag-scroll";

/** An area 800 tall: the band is the top and bottom 72 of it. */
const TOP = 100;
const BOTTOM = 900;

describe("scrollSpeed", () => {
  it("is still in the middle of the area", () => {
    expect(scrollSpeed(500, TOP, BOTTOM)).toBe(0);
    expect(scrollSpeed(TOP + 72, TOP, BOTTOM)).toBe(0);
    expect(scrollSpeed(BOTTOM - 72, TOP, BOTTOM)).toBe(0);
  });

  it("goes up near the top and down near the bottom", () => {
    expect(scrollSpeed(TOP + 20, TOP, BOTTOM)).toBeLessThan(0);
    expect(scrollSpeed(BOTTOM - 20, TOP, BOTTOM)).toBeGreaterThan(0);
  });

  it("goes faster the further into the band the pointer is", () => {
    const shallow = scrollSpeed(BOTTOM - 60, TOP, BOTTOM);
    const deep = scrollSpeed(BOTTOM - 10, TOP, BOTTOM);
    expect(deep).toBeGreaterThan(shallow);
    expect(scrollSpeed(TOP + 10, TOP, BOTTOM)).toBe(-deep);
  });

  it("tops out at the edge and stays there past it", () => {
    const edge = scrollSpeed(BOTTOM, TOP, BOTTOM);
    expect(scrollSpeed(BOTTOM + 300, TOP, BOTTOM)).toBe(edge);
    expect(scrollSpeed(TOP - 300, TOP, BOTTOM)).toBe(-edge);
  });

  it("leaves a still middle in an area too short for two full bands", () => {
    expect(scrollSpeed(60, 0, 120)).toBe(0);
    expect(scrollSpeed(5, 0, 120)).toBeLessThan(0);
    expect(scrollSpeed(115, 0, 120)).toBeGreaterThan(0);
  });
});
