import { invoke, isTauri } from "@tauri-apps/api/core";

class StartupState {
  enabled = $state(false);

  busy = $state(false);

  get ready(): boolean {
    return isTauri();
  }

  async refresh(): Promise<void> {
    if (!this.ready) return;
    try {
      this.enabled = await invoke<boolean>("autostart_enabled");
    } catch {
      this.enabled = false;
    }
  }

  async set(enabled: boolean): Promise<boolean> {
    if (!this.ready) return false;
    this.busy = true;
    try {
      await invoke("set_autostart", { enabled });
      return true;
    } catch {
      return false;
    } finally {
      await this.refresh();
      this.busy = false;
    }
  }
}

export const startup = new StartupState();
