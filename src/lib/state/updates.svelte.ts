import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { message } from "$lib/utils/error";

export interface Available {
  version: string;
  currentVersion: string;
  /** What the release said. Unread until there are real release notes to show. */
  notes: string | null;
}

interface Progress {
  downloaded: number;
  total: number | null;
}

export type UpdateStatus =
  "idle" | "checking" | "available" | "downloading" | "installed";

class UpdateState {
  status = $state<UpdateStatus>("idle");
  available = $state<Available | null>(null);
  progress = $state<Progress | null>(null);

  lastError = $state<string | null>(null);

  checked = $state(false);

  private unlisten: UnlistenFn[] = [];

  get ready(): boolean {
    return isTauri();
  }

  get fraction(): number | null {
    const p = this.progress;
    if (!p?.total) return null;
    return Math.min(1, p.downloaded / p.total);
  }

  async init(): Promise<void> {
    if (!this.ready) return;
    this.unlisten.push(
      await listen<Progress>("update:progress", (event) => {
        this.progress = event.payload;
      }),
    );
    await this.check();
  }

  destroy(): void {
    for (const off of this.unlisten) off();
    this.unlisten = [];
  }

  async check(): Promise<void> {
    if (!this.ready) return;
    if (
      this.status === "checking" ||
      this.status === "downloading" ||
      this.status === "installed"
    )
      return;
    this.status = "checking";
    this.lastError = null;
    try {
      const found = await invoke<Available | null>("update_check");
      this.available = found;
      this.checked = true;
      this.status = found ? "available" : "idle";
    } catch (e) {
      this.available = null;
      this.status = "idle";
      this.lastError = message(e);
    }
  }

  async install(): Promise<void> {
    if (!this.ready || this.status !== "available") return;
    this.status = "downloading";
    this.progress = { downloaded: 0, total: null };
    this.lastError = null;
    try {
      await invoke("update_install");
      this.status = "installed";
    } catch (e) {
      this.status = "available";
      this.lastError = message(e);
    } finally {
      this.progress = null;
    }
  }

  async restart(): Promise<void> {
    if (!this.ready || this.status !== "installed") return;
    await invoke("update_restart").catch((e: unknown) => {
      this.lastError = message(e);
    });
  }
}

export const updates = new UpdateState();
