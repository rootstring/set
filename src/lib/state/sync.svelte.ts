import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { SyncLogEntry } from "./sync-log";
import type { SyncDiff, SyncPreview } from "./sync-preview";
import { toasts } from "./toasts.svelte";

export type { SyncLogEntry } from "./sync-log";

export interface SyncPeer {
  id: string;
  name: string;
  connected: boolean;
  nearby: boolean;
  syncing: boolean;
  lastSyncedAt: number | null;
  lastError: string | null;
  pairingPending: boolean;

  /** Files the last round with this device wanted and couldn't carry. */
  tooBig: TooBigFile[];
}

export interface NearbyDevice {
  id: string;
  name: string;
  compatible: boolean;
}

export interface TooBigFile {
  path: string;
  bytes: number;
}

export interface SyncStatus {
  enabled: boolean;
  running: boolean;
  deviceName: string;
  endpointId: string;
  notesId: string;
  protocolVersion: number;
  pairingCode: string | null;
  peers: SyncPeer[];
  discoverable: boolean;
  /** ms since the epoch. */
  searchingUntil: number | null;
  nearby: NearbyDevice[];
  lastError: string | null;
}

export interface PairRequest {
  id: number;
  name: string;
  checkDigits?: string;
  /** This device picked the other off its nearby list, so it types the digits in instead. */
  asking?: boolean;
  digitCount?: number;
}

/** Nothing has changed on either device yet. */
export interface PreviewRequest {
  id: number;
  peerId: string;
  peerName: string;
  preview: SyncPreview;
}

interface ChangedEvent {
  changed: number;

  /**
   * Merges go to the activity log; only a conflict, which leaves a second page, interrupts anyone.
   */
  merged: string[];

  conflicts: { path: string; keptAs: string }[];
}

const OFF: SyncStatus = {
  enabled: false,
  running: false,
  deviceName: "",
  endpointId: "",
  notesId: "",
  protocolVersion: 0,
  pairingCode: null,
  peers: [],
  discoverable: false,
  searchingUntil: null,
  nearby: [],
  lastError: null,
};

class SyncState {
  status = $state<SyncStatus>(OFF);

  busy = $state(false);

  pairRequest = $state<PairRequest | null>(null);

  previewRequest = $state<PreviewRequest | null>(null);

  /**
   * With nowhere to show a preview, a sync that asks is called off rather than holding both round
   * locks.
   */
  previewShown = false;

  /** The last device this one let in, which is also when the code changed. */
  lastPaired = $state<{ name: string; at: number } | null>(null);

  private unlisten: UnlistenFn[] = [];
  private onChanged: (() => void | Promise<void>) | null = null;
  private beforeRound: (() => Promise<void>) | null = null;

  get ready(): boolean {
    return isTauri();
  }

  /** `beforeRound` gets what is typed onto disk so the round carries it. */
  async init(
    onChanged: () => void | Promise<void>,
    beforeRound?: () => Promise<void>,
  ): Promise<void> {
    if (!this.ready) return;
    this.onChanged = onChanged;
    this.beforeRound = beforeRound ?? null;

    this.unlisten.push(
      await listen<SyncStatus>("sync:status", (event) => {
        this.status = event.payload;
      }),
    );
    this.unlisten.push(
      await listen<ChangedEvent>("sync:changed", (event) => {
        void this.applyChange(event.payload);
      }),
      await listen<PairRequest>("sync:pair-request", (event) => {
        this.pairRequest = event.payload;
      }),
      await listen<{ id: number }>("sync:pair-request-closed", (event) => {
        if (this.pairRequest?.id === event.payload.id) this.pairRequest = null;
      }),
      await listen<PreviewRequest>("sync:preview", (event) => {
        this.previewRequest = event.payload;
        if (!this.previewShown) void this.answerPreview(false);
      }),
      await listen<{ id: number }>("sync:preview-closed", (event) => {
        if (this.previewRequest?.id === event.payload.id) this.previewRequest = null;
      }),
      await listen<{ name: string; byCode: boolean }>("sync:paired", (event) => {
        // Only a code is used up by pairing; one from the nearby list leaves it as it was.
        if (event.payload.byCode)
          this.lastPaired = { name: event.payload.name, at: Date.now() };
        toasts.done(`Paired with ${event.payload.name}`);
      }),
    );
    // A preview a reloaded window left up has nobody to answer it.
    await invoke("sync_answer_preview", { id: null, go: false }).catch(() => {});
    // Nor is the Sync page that made this device discoverable still open.
    await this.leaveNearby();
    await this.refresh();
  }

  destroy(): void {
    for (const off of this.unlisten) off();
    this.unlisten = [];
    this.onChanged = null;
    this.beforeRound = null;
  }

  /**
   * `sameNotes` false starts a new notes folder, or every note would look deleted to paired
   * devices.
   */
  async useNotesFolder(dir: string, sameNotes = true): Promise<void> {
    if (!this.ready) return;
    try {
      if (!sameNotes) await invoke("sync_forget_notes");
      await invoke("sync_set_notes_dir", { notesDir: dir });

      if (this.status.enabled) {
        await invoke<SyncStatus>("sync_set_enabled", { enabled: true, notesDir: dir });
      }
      await this.refresh();
    } catch {
      // sync is optional; on failure the previous status stands
    }
  }

  async refresh(): Promise<void> {
    if (!this.ready) return;
    try {
      this.status = await invoke<SyncStatus>("sync_status");
    } catch {
      this.status = OFF;
    }
  }

  async setEnabled(enabled: boolean, notesDir: string): Promise<void> {
    await this.run(async () => {
      this.status = await invoke<SyncStatus>("sync_set_enabled", { enabled, notesDir });
    });
  }

  async regeneratePairingCode(): Promise<void> {
    await this.run(async () => {
      this.status = await invoke<SyncStatus>("sync_regenerate_pairing_code");
    });
  }

  async pair(code: string): Promise<void> {
    await this.run(async () => {
      this.status = await invoke<SyncStatus>("sync_pair", { code });
    });
  }

  async setDiscoverable(on: boolean): Promise<void> {
    this.status = await invoke<SyncStatus>("sync_set_discoverable", { on });
  }

  async searchNearby(on: boolean): Promise<void> {
    this.status = await invoke<SyncStatus>("sync_search_nearby", { on });
  }

  /** Both looking and findable, so it doesn't matter which device starts. */
  async openNearby(): Promise<void> {
    await this.setDiscoverable(true);
    await this.searchNearby(true);
  }

  async leaveNearby(): Promise<void> {
    if (!this.ready) return;
    await Promise.allSettled([this.setDiscoverable(false), this.searchNearby(false)]);
  }

  async pairNearby(id: string): Promise<void> {
    await this.run(async () => {
      this.status = await invoke<SyncStatus>("sync_pair_nearby", { id });
    });
  }

  async answerPair(allow: boolean, digits?: string): Promise<void> {
    const request = this.pairRequest;
    this.pairRequest = null;
    if (!request) return;
    try {
      await invoke("sync_answer_pair", { id: request.id, allow, digits: digits ?? null });
    } catch {
      // unanswered, the claim times out on its own
    }
  }

  async unpair(id: string): Promise<void> {
    await this.run(async () => {
      this.status = await invoke<SyncStatus>("sync_unpair", { id });
    });
  }

  /** Includes however long each preview waits for `answerPreview`. */
  async syncNow(): Promise<void> {
    await this.run(async () => {
      await this.beforeRound?.();
      this.status = await invoke<SyncStatus>("sync_now");
    });
  }

  /** Go ahead with the sync on screen, or call it off with nothing changed. */
  async answerPreview(go: boolean): Promise<void> {
    const request = this.previewRequest;
    this.previewRequest = null;
    if (!request) return;
    try {
      await invoke("sync_answer_preview", { id: request.id, go });
    } catch {
      // unanswered, the round calls itself off in time
    }
  }

  /** What the sync on screen does to the text of one note, if it can be shown. */
  async previewDiff(path: string): Promise<SyncDiff | null> {
    const request = this.previewRequest;
    if (!request) return null;
    try {
      return await invoke<SyncDiff | null>("sync_preview_diff", { id: request.id, path });
    } catch {
      return null;
    }
  }

  async readLog(): Promise<SyncLogEntry[]> {
    if (!this.ready) return [];
    try {
      return await invoke<SyncLogEntry[]>("sync_log_read");
    } catch {
      return [];
    }
  }

  async clearLog(): Promise<void> {
    await invoke("sync_log_clear");
  }

  private async run(action: () => Promise<void>): Promise<void> {
    this.busy = true;
    try {
      await action();
    } finally {
      this.busy = false;
    }
  }

  private async applyChange(event: ChangedEvent): Promise<void> {
    await this.onChanged?.();
    for (const conflict of event.conflicts) {
      toasts.error(
        `Sync conflict on "${basename(conflict.path)}". Your version was saved as "${basename(conflict.keptAs)}"`,
      );
    }
  }
}

function basename(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.replace(/\.md$/i, "");
}

export const sync = new SyncState();
