import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { formatBytes } from "$lib/utils/bytes";
import { message } from "$lib/utils/error";

import { settings } from "./settings.svelte";
import { toasts } from "./toasts.svelte";

export { formatBytes };

export type DictationPhase = "idle" | "downloading" | "recording" | "transcribing";

export interface DictationStatus {
  available: boolean;
  phase: DictationPhase;
  modelInstalled: boolean;
  modelPath: string | null;
  modelBytes: number;
  modelMemoryBytes: number;
  modelLabel: string;
  modelParameters: string;
  downloaded: number;
  lastError: string | null;
}

const OFF: DictationStatus = {
  available: false,
  phase: "idle",
  modelInstalled: false,
  modelPath: null,
  modelBytes: 0,
  modelMemoryBytes: 0,
  modelLabel: "Whisper small",
  modelParameters: "244M",
  downloaded: 0,
  lastError: null,
};

class DictationState {
  status = $state<DictationStatus>(OFF);

  level = $state(0);

  promptOpen = $state(false);

  private unlisten: UnlistenFn[] = [];
  private onText: ((text: string) => void) | null = null;

  get ready(): boolean {
    return isTauri();
  }

  get offered(): boolean {
    return this.ready && this.status.available;
  }

  get recording(): boolean {
    return this.status.phase === "recording";
  }

  get busy(): boolean {
    return this.status.phase !== "idle";
  }

  get downloadProgress(): number {
    const { downloaded, modelBytes } = this.status;
    if (!modelBytes) return 0;
    return Math.min(1, downloaded / modelBytes);
  }

  async init(onText: (text: string) => void): Promise<void> {
    if (!this.ready) return;
    this.onText = onText;

    this.unlisten.push(
      await listen<DictationStatus>("dictation:status", (event) => {
        this.status = event.payload;

        if (this.status.phase !== "recording") this.level = 0;
        if (this.status.lastError) toasts.error(this.status.lastError, "dictation");
      }),
    );
    this.unlisten.push(
      await listen<number>("dictation:level", (event) => {
        this.level = event.payload;
      }),
    );
    this.unlisten.push(
      await listen<{ text: string }>("dictation:text", (event) => {
        const text = event.payload.text.trim();
        if (text) this.onText?.(text);
      }),
    );

    this.unlisten.push(
      await listen("dictation:limit", () => {
        if (this.recording) void this.stop();
      }),
    );

    await this.refresh();
  }

  destroy(): void {
    for (const off of this.unlisten) off();
    this.unlisten = [];
    this.onText = null;
  }

  async refresh(): Promise<void> {
    if (!this.ready) return;
    try {
      this.status = await invoke<DictationStatus>("dictation_status");
    } catch {
      this.status = OFF;
    }
  }

  async begin(): Promise<void> {
    if (!this.offered) return;
    if (this.recording) {
      await this.stop();
      return;
    }

    if (this.busy) return;
    await this.refresh();
    if (!this.status.modelInstalled) {
      this.promptOpen = true;
      return;
    }
    await this.start();
  }

  async downloadModel(): Promise<void> {
    if (!this.ready) return;
    try {
      await invoke("dictation_download_model");
    } catch (e) {
      toasts.error(`Couldn't start the download: ${message(e)}`, "dictation");
    }
  }

  async cancelDownload(): Promise<void> {
    if (!this.ready) return;
    await invoke("dictation_cancel_download").catch(() => {});
    await this.refresh();
  }

  async deleteModel(): Promise<void> {
    if (!this.ready) return;
    try {
      await invoke("dictation_delete_model");
    } catch (e) {
      toasts.error(`Couldn't delete the model: ${message(e)}`, "dictation");
    }
    await this.refresh();
  }

  async start(): Promise<boolean> {
    if (!this.ready) return false;
    try {
      await invoke("dictation_start");
      await this.refresh();
      return true;
    } catch (e) {
      toasts.error(message(e), "dictation");
      await this.refresh();
      return false;
    }
  }

  async stop(): Promise<void> {
    if (!this.ready) return;
    const chosen = settings.dictationLanguage;
    try {
      await invoke("dictation_stop", {
        language: chosen && chosen !== "auto" ? chosen : null,
      });
    } catch (e) {
      toasts.error(message(e), "dictation");
    }
    await this.refresh();
  }

  async cancel(): Promise<void> {
    if (!this.ready) return;
    await invoke("dictation_cancel").catch(() => {});
    await this.refresh();
  }
}

export const dictation = new DictationState();
