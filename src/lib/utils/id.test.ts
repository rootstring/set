import { describe, expect, it } from "vitest";
import { deriveId } from "./id";

describe("deriveId", () => {
  // Same seeds and ids as `page_id.rs`: app and sync must pick the same repaired id.
  it("gives the id sync gives", async () => {
    expect(await deriveId("abc/Set/A.md")).toBe("4q1xfzmhq1");
    expect(await deriveId("p1/Work/Café.md")).toBe("p7d4x7kk4n");
    expect(await deriveId("")).toBe("3g42rwwmtv");
  });
});
