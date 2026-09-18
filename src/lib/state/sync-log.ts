export type SyncLogFields = [string, string][];

export interface SyncLogEntry {
  at: number;
  level: "info" | "warn" | "error";
  event: string;
  fields: SyncLogFields;
}

export function field(entry: SyncLogEntry, key: string): string | null {
  return entry.fields.find(([k]) => k === key)?.[1] ?? null;
}

function num(entry: SyncLogEntry, key: string): number | null {
  const raw = field(entry, key);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function who(entry: SyncLogEntry): string {
  return field(entry, "name") || `device ${field(entry, "peer") ?? ""}`.trim();
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const REASONS: Record<string, string> = {
  version_mismatch: "the two devices are running different versions of Set",
  unreadable_claim: "the two devices are running different versions of Set",
  not_paired: "it hasn't added this device yet",
  different_notes: "it's syncing a different notes folder",
  wrong_code: "the code was already used or replaced",
  declined: "it wasn't allowed",
  no_answer: "nobody answered the prompt in time",
  throttled: "too many pairing attempts. Try again in a few minutes",
  transport: "the connection dropped",
  scan: "the notes folder couldn't be read",
  apply: "a file couldn't be written",
  baseline: "the sync record couldn't be saved",
};

function why(entry: SyncLogEntry): string | null {
  const code = field(entry, "reason");
  if (code && REASONS[code]) return REASONS[code];
  const error = field(entry, "error");
  return error ? lowerFirst(error) : null;
}

function lowerFirst(text: string): string {
  const [first, second] = [text[0] ?? "", text[1] ?? ""];
  if (first !== first.toUpperCase()) return text;
  if (second && second !== second.toLowerCase()) return text; // an acronym or a name
  return first.toLowerCase() + text.slice(1);
}

function withReason(lead: string, entry: SyncLogEntry): string {
  const reason = why(entry);
  return reason ? `${lead}: ${reason}` : lead;
}

export function describe(entry: SyncLogEntry): string {
  switch (entry.event) {
    case "sync.started": {
      const peers = num(entry, "peers") ?? 0;
      return peers === 0
        ? "Sync started, no devices paired yet"
        : `Sync started with ${plural(peers, "device", "devices")}`;
    }
    case "sync.stopped":
      return "Sync stopped";
    case "sync.start_failed":
      return withReason("Sync couldn't start", entry);
    case "peer.connected":
      return `Connected to ${who(entry)}`;
    case "peer.unreachable":
      return `Couldn't reach ${who(entry)}`;
    case "pair.added":
      return `Added ${who(entry)}`;
    case "pair.accepted":
      return `${who(entry)} paired with this device`;
    case "pair.confirmed":
      return `Paired with ${who(entry)}`;
    case "pair.refused":
      return withReason(`Turned down a pairing attempt from ${who(entry)}`, entry);
    case "pair.rejected":
      return withReason(`${who(entry)} wouldn't pair`, entry);
    case "pair.removed":
      return `Removed ${who(entry)}`;
    case "code.replaced":
      return "Pairing code replaced";
    case "code.used":
      return "Pairing code used up, new one ready";
    case "sync.completed": {
      const here = num(entry, "changed_here") ?? 0;
      const there = num(entry, "changed_there") ?? 0;
      const conflicts = num(entry, "conflicts") ?? 0;
      const moved = [
        here > 0 ? `${plural(here, "change", "changes")} here` : "",
        there > 0 ? `${plural(there, "change", "changes")} there` : "",
      ].filter(Boolean);
      const tail = conflicts > 0 ? `, ${plural(conflicts, "conflict", "conflicts")}` : "";
      return `Synced with ${who(entry)}: ${moved.join(", ") || "nothing to change"}${tail}`;
    }
    // The same round, seen from the device that didn't press the button.
    case "sync.answered": {
      const changed = num(entry, "changed") ?? 0;
      const conflicts = num(entry, "conflicts") ?? 0;
      const tail = conflicts > 0 ? `, ${plural(conflicts, "conflict", "conflicts")}` : "";
      return `${who(entry)} synced with this device: ${plural(changed, "change", "changes")} here${tail}`;
    }
    case "sync.failed":
      return withReason(`Couldn't sync with ${who(entry)}`, entry);
    case "sync.conflict":
      return `${pageName(field(entry, "path") ?? "")} was edited on both devices`;
    case "sync.merged":
      return `Merged edits to ${pageName(field(entry, "path") ?? "")} from both devices`;
    case "sync.too_big": {
      const bytes = num(entry, "bytes");
      const size = bytes === null ? "" : ` (${megabytes(bytes)})`;
      return `${pageName(field(entry, "path") ?? "")}${size} is too large to sync`;
    }
    case "sync.declined":
      return field(entry, "reason") === "no_answer"
        ? `Sync with ${who(entry)} wasn't confirmed in time, so nothing changed`
        : `Sync with ${who(entry)} cancelled at the preview, nothing changed`;
    case "sync.unreadable":
      return `${pageName(field(entry, "path") ?? "")} couldn't be read, so it was left alone on both devices`;
    default:
      return field(entry, "detail") ?? entry.event;
  }
}

function pageName(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.replace(/\.md$/i, "") || path;
}

export function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export interface ReportStatus {
  enabled: boolean;
  running: boolean;
  deviceName: string;
  endpointId: string;
  notesId: string;
  protocolVersion: number;
  lastError: string | null;
  peers: {
    id: string;
    name: string;
    connected: boolean;
    syncing: boolean;
    lastSyncedAt: number | null;
    lastError: string | null;
    pairingPending: boolean;
    tooBig?: { path: string; bytes: number }[];
  }[];
}

export interface ReportInput {
  appVersion: string;
  platform: string;
  status: ReportStatus;
  notesPath?: string | null;
  log: SyncLogEntry[];
  now?: Date;
}

function value(raw: string): string {
  if (raw === "") return '""';
  if (!/[\s"=]/.test(raw)) return raw;
  return `"${raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function pairs(
  entries: [string, string | number | boolean | null | undefined][],
): string {
  return entries
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${value(String(v))}`)
    .join(" ");
}

function stamp(at: number): string {
  return new Date(at).toISOString();
}

export function buildDiagnosticReport(input: ReportInput): string {
  const { appVersion, platform, status, log } = input;
  const now = input.now ?? new Date();
  const out: string[] = [];

  out.push(`Set v${appVersion} sync diagnostic`);
  out.push(
    pairs([
      ["generated", now.toISOString()],
      ["platform", platform],
    ]),
  );
  out.push("");

  out.push(
    `device ${pairs([
      ["name", status.deviceName],
      ["id", status.endpointId],
      ["notes", status.notesId],
      ["protocol", status.protocolVersion],
      ["sync", status.enabled ? "on" : "off"],
      ["state", status.running ? "running" : "stopped"],
      ["notes", input.notesPath ?? null],
      ["error", status.lastError],
    ])}`,
  );

  if (status.peers.length === 0) {
    out.push("peers none");
  }
  for (const peer of status.peers) {
    out.push(
      `peer   ${pairs([
        ["id", peer.id],
        ["name", peer.name],
        ["connected", peer.connected],
        ["syncing", peer.syncing],
        ["pairing_pending", peer.pairingPending],
        ["last_synced", peer.lastSyncedAt === null ? "never" : stamp(peer.lastSyncedAt)],
        ["error", peer.lastError],
      ])}`,
    );
    for (const file of peer.tooBig ?? []) {
      out.push(
        `       ${pairs([
          ["too_big", file.path],
          ["bytes", file.bytes],
        ])}`,
      );
    }
  }

  out.push("");
  out.push(`log ${pairs([["entries", log.length]])} (oldest first)`);
  if (log.length === 0) {
    out.push("(empty)");
  }

  const width = Math.min(
    log.reduce((w, e) => Math.max(w, e.event.length), 0),
    24,
  );
  for (const entry of log) {
    const level = entry.level.toUpperCase().padStart(5);
    const event = entry.event.padEnd(width);
    const fields = entry.fields.map(([k, v]) => `${k}=${value(v)}`).join(" ");
    out.push(
      `${stamp(entry.at)} ${level} ${event}${fields ? ` ${fields}` : ""}`.trimEnd(),
    );
  }

  return out.join("\n");
}
