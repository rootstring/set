import { describe as group, expect, test } from "vitest";

import {
  buildDiagnosticReport,
  describe,
  field,
  type ReportStatus,
  type SyncLogEntry,
} from "./sync-log";

const AT = Date.UTC(2026, 7, 27, 19, 29, 19, 346);

function entry(
  event: string,
  fields: [string, string][] = [],
  level: SyncLogEntry["level"] = "info",
): SyncLogEntry {
  return { at: AT, level, event, fields };
}

const PEER: [string, string][] = [
  ["peer", "2463e975"],
  ["name", "MacBook"],
];

group("what the user reads", () => {
  test("names the device rather than its id", () => {
    expect(describe(entry("peer.connected", PEER))).toBe("Connected to MacBook");
    expect(describe(entry("pair.confirmed", PEER))).toBe("Paired with MacBook");
    expect(describe(entry("pair.removed", PEER))).toBe("Removed MacBook");
  });

  test("falls back to the short id when a device has no name yet", () => {
    expect(describe(entry("peer.connected", [["peer", "2463e975"]]))).toBe(
      "Connected to device 2463e975",
    );
  });

  test("turns a refusal code into the sentence it stands for", () => {
    const rejected = entry(
      "pair.rejected",
      [...PEER, ["reason", "version_mismatch"], ["theirs", "1"], ["ours", "2"]],
      "error",
    );
    expect(describe(rejected)).toBe(
      "MacBook wouldn't pair: the two devices are running different versions of Set",
    );
  });

  test("uses the recorded message when the code has no sentence of its own", () => {
    const failed = entry(
      "sync.failed",
      [
        ...PEER,
        ["reason", "peer_error"],
        ["error", "the notes folder hasn't been set yet"],
      ],
      "error",
    );
    expect(describe(failed)).toBe(
      "Couldn't sync with MacBook: the notes folder hasn't been set yet",
    );
  });

  // Field names are the ones `coordinate` in src-tauri/src/sync/mod.rs writes.
  test("counts what a sync changed, on each device", () => {
    const completed = (here: string, there: string, conflicts = "0") =>
      describe(
        entry("sync.completed", [
          ...PEER,
          ["changed_here", here],
          ["changed_there", there],
          ["conflicts", conflicts],
        ]),
      );
    expect(completed("1", "0")).toBe("Synced with MacBook: 1 change here");
    expect(completed("0", "4")).toBe("Synced with MacBook: 4 changes there");
    expect(completed("7", "3", "2")).toBe(
      "Synced with MacBook: 7 changes here, 3 changes there, 2 conflicts",
    );
  });

  test("and says so on the device that was synced with", () => {
    expect(
      describe(entry("sync.answered", [...PEER, ["changed", "2"], ["conflicts", "0"]])),
    ).toBe("MacBook synced with this device: 2 changes here");
  });

  test("names the page a conflict is about, not its path", () => {
    expect(
      describe(entry("sync.conflict", [...PEER, ["path", "Work/Standups.md"]])),
    ).toBe("Standups was edited on both devices");
  });

  test("an event this build has never heard of still says something", () => {
    expect(
      describe(entry("sync failed", [["detail", "Desktop: connection reset"]])),
    ).toBe("Desktop: connection reset");
    expect(describe(entry("peer.teleported", PEER))).toBe("peer.teleported");
  });

  test("says which file couldn't cross, and how big it is", () => {
    expect(
      describe(
        entry(
          "sync.too_big",
          [...PEER, ["path", "Trip/Set-page-assets/video.mp4"], ["bytes", "73741824"]],
          "warn",
        ),
      ),
    ).toBe("video.mp4 (70 MB) is too large to sync");
    expect(describe(entry("sync.merged", [...PEER, ["path", "Work/Standups.md"]]))).toBe(
      "Merged edits to Standups from both devices",
    );
    expect(
      describe(entry("sync.unreadable", [...PEER, ["path", "Work/Locked.md"]], "warn")),
    ).toBe("Locked couldn't be read, so it was left alone on both devices");
    expect(describe(entry("sync.declined", [...PEER, ["reason", "declined"]]))).toBe(
      "Sync with MacBook cancelled at the preview, nothing changed",
    );
    expect(describe(entry("sync.declined", [...PEER, ["reason", "no_answer"]]))).toBe(
      "Sync with MacBook wasn't confirmed in time, so nothing changed",
    );
  });

  test("no user-facing line leaks a code or an id the user can't act on", () => {
    const lines = [
      describe(entry("sync.started", [["peers", "2"]])),
      describe(
        entry("peer.unreachable", [...PEER, ["error", "no route to host"]], "warn"),
      ),
      describe(entry("pair.refused", [...PEER, ["reason", "wrong_code"]], "warn")),
    ];
    for (const line of lines) {
      expect(line).not.toMatch(/_|=|\bpeer\b/);
    }
  });
});

group("what the report says", () => {
  const status: ReportStatus = {
    enabled: true,
    running: true,
    deviceName: "aavsh's PC",
    endpointId: "2f9c1a3b4d5e6f70",
    notesId: "9c4f1b7e-0a2d-4f6b-8e31-5d7a0c9b2e14",
    protocolVersion: 2,
    lastError: null,
    peers: [
      {
        id: "2463e975aa",
        name: "Device 2463e975",
        connected: true,
        syncing: false,
        lastSyncedAt: null,
        lastError: "this device isn't paired with that one",
        pairingPending: true,
      },
    ],
  };

  const report = buildDiagnosticReport({
    appVersion: "0.0.1",
    platform: "macOS",
    status,
    notesPath: "/Users/x/Notes",
    now: new Date(Date.UTC(2026, 7, 27, 19, 29, 42, 135)),
    log: [
      entry("pair.added", [...PEER, ["addrs", "2"]]),
      entry(
        "pair.rejected",
        [...PEER, ["reason", "version_mismatch"], ["error", "different versions of Set"]],
        "error",
      ),
    ],
  });

  test("leads with what the two devices disagree about", () => {
    expect(report).toContain("notes=9c4f1b7e-0a2d-4f6b-8e31-5d7a0c9b2e14");
    expect(report).toContain("protocol=2");
    expect(report).toContain("pairing_pending=true");
  });

  test("keeps every field of every entry, with its machine code", () => {
    expect(report).toContain("reason=version_mismatch");
    expect(report).toContain("addrs=2");
    expect(report).toContain("ERROR pair.rejected");
  });

  test("quotes a value that would otherwise read as two fields", () => {
    expect(report).toContain('error="different versions of Set"');
    expect(report).toContain('name="aavsh\'s PC"');

    expect(report).toContain("peer=2463e975");
  });

  test("says so plainly when there is nothing recorded", () => {
    const empty = buildDiagnosticReport({
      appVersion: "0.0.1",
      platform: "macOS",
      status: { ...status, peers: [] },
      log: [],
    });
    expect(empty).toContain("peers none");
    expect(empty).toContain("(empty)");
  });
});

test("a field that isn't there reads as absent, not as empty", () => {
  expect(field(entry("peer.connected", PEER), "error")).toBeNull();
  expect(field(entry("peer.connected", PEER), "name")).toBe("MacBook");
});
