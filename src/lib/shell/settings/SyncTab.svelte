<script lang="ts">
  import { settings } from "$lib/state/settings.svelte";
  import { sync, type SyncPeer, type TooBigFile } from "$lib/state/sync.svelte";
  import {
    buildDiagnosticReport,
    describe,
    megabytes,
    type SyncLogEntry,
  } from "$lib/state/sync-log";
  import { workspace } from "$lib/state/workspace.svelte";
  import Button from "../Button.svelte";
  import Segmented from "./Segmented.svelte";
  import SyncPreview from "./SyncPreview.svelte";
  import { message } from "$lib/utils/error";
  import { whenLabel, type Opt, type TabContext } from "./shared";

  let { ctx }: { ctx: TabContext } = $props();

  const TOGGLE_OPTS: Opt[] = [
    { value: "on", label: "On" },
    { value: "off", label: "Off" },
  ];

  /** How long the code field says it was just used. */
  const RENEWED_MS = 10_000;

  function copied(set: (v: boolean) => void): void {
    set(true);
    setTimeout(() => set(false), 1600);
  }

  let notesPath = $state("");
  $effect(() => {
    settings.notesFolder; // refresh when it changes
    workspace.notesFolder().then((p) => (notesPath = p));
  });

  let pairingInput = $state("");
  let pairing = $state(false);
  let codeCopied = $state(false);
  let reportCopied = $state(false);

  let renewed = $state(false);
  $effect(() => {
    const paired = sync.lastPaired;
    if (!paired) return;
    const left = RENEWED_MS - (Date.now() - paired.at);
    if (left <= 0) return;
    renewed = true;
    const timer = setTimeout(() => (renewed = false), left);
    return () => clearTimeout(timer);
  });

  let syncLog = $state<SyncLogEntry[]>([]);
  let logExpanded = $state(false);
  const LOG_PREVIEW = 8;

  $effect(() => {
    void sync.status;
    void sync.readLog().then((entries) => (syncLog = entries.reverse()));
  });

  const shownLog = $derived(logExpanded ? syncLog : syncLog.slice(0, LOG_PREVIEW));

  async function toggleSync(on: boolean): Promise<void> {
    try {
      await sync.setEnabled(on, await workspace.notesFolder());
    } catch (e) {
      ctx.flash(`Couldn't turn sync ${on ? "on" : "off"}: ${message(e)}`, "warn");
    }
  }

  async function pairDevice(): Promise<void> {
    const code = pairingInput.trim();
    if (!code) return;
    pairing = true;
    try {
      await sync.pair(code);
      pairingInput = "";
      ctx.flash(
        sync.status.peers.some((p) => p.pairingPending)
          ? "Couldn't reach it yet. It pairs on your next sync."
          : "Paired",
      );
    } catch (e) {
      ctx.flash(`Couldn't pair: ${message(e)}`, "warn");
    } finally {
      pairing = false;
    }
  }

  let unpairEls = $state<Record<string, HTMLButtonElement | undefined>>({});

  function unpairDevice(peer: SyncPeer): void {
    ctx.confirm({
      anchor: unpairEls[peer.id],
      title: `Unpair ${peer.name}?`,
      message: `${peer.name} stops syncing here. Notes stay on both.`,
      confirmLabel: "Unpair",
      danger: true,
      onConfirm: async () => {
        try {
          await sync.unpair(peer.id);
        } catch (e) {
          ctx.flash(`Couldn't unpair: ${message(e)}`, "warn");
        }
      },
    });
  }

  async function regeneratePairingCode(): Promise<void> {
    try {
      await sync.regeneratePairingCode();
      ctx.flash("New code ready. The old one no longer works.");
    } catch (e) {
      ctx.flash(`Couldn't make a new code: ${message(e)}`, "warn");
    }
  }

  async function copyPairingCode(): Promise<void> {
    const code = sync.status.pairingCode;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      copied((v) => (codeCopied = v));
    } catch {
      ctx.flash("Couldn't copy. Select the code instead", "warn");
    }
  }

  let syncing = $state(false);

  // Only while this tab is up can a sync ask; leaving it calls off one that is asking.
  $effect(() => {
    sync.previewShown = true;
    return () => {
      sync.previewShown = false;
      void sync.answerPreview(false);
    };
  });

  let asked = false;
  $effect(() => {
    if (sync.previewRequest) asked = true;
  });

  async function syncNow(): Promise<void> {
    syncing = true;
    asked = false;
    try {
      await sync.syncNow();
      // A sync with nothing to do has nothing to preview.
      const failed = sync.status.peers.some((p) => p.lastError);
      if (!asked && !failed) ctx.flash("Already in sync. Nothing to change.");
    } catch (e) {
      ctx.flash(`Couldn't sync: ${message(e)}`, "warn");
    } finally {
      syncing = false;
    }
  }

  async function clearSyncLog(): Promise<void> {
    try {
      await sync.clearLog();
      syncLog = [];
    } catch {
      ctx.flash("Couldn't clear the log", "warn");
    }
  }

  async function copyReport(): Promise<void> {
    try {
      await navigator.clipboard.writeText(
        buildDiagnosticReport({
          appVersion: settings.appVersion,
          platform: navigator.userAgent,
          status: sync.status,
          notesPath,
          log: [...syncLog].reverse(),
        }),
      );
      copied((v) => (reportCopied = v));
    } catch {
      ctx.flash("Couldn't copy the report", "warn");
    }
  }

  function shortCode(code: string): string {
    return code.length > 30 ? `${code.slice(0, 14)}…${code.slice(-12)}` : code;
  }

  /** Which files never reach that device, since nothing else on screen says. */
  function tooBigLabel(files: TooBigFile[]): string {
    const SHOWN = 3;
    const names = files
      .slice(0, SHOWN)
      .map((f) => `${f.path.slice(f.path.lastIndexOf("/") + 1)} (${megabytes(f.bytes)})`);
    const more = files.length > SHOWN ? `, and ${files.length - SHOWN} more` : "";
    return `Too large to sync: ${names.join(", ")}${more}`;
  }

  function peerState(peer: SyncPeer): string {
    if (peer.syncing) return "Syncing…";
    if (peer.pairingPending) return "Waiting to pair";
    if (peer.connected) return "Connected";
    if (peer.lastSyncedAt) return `Synced ${whenLabel(peer.lastSyncedAt)}`;
    return "Not synced yet";
  }
</script>

{#if sync.previewRequest}
  <!-- In place of the tab: the panel is already a dialog. -->
  {#key sync.previewRequest.id}
    <SyncPreview
      request={sync.previewRequest}
      onAnswer={(go) => void sync.answerPreview(go)}
    />
  {/key}
{/if}
<section class="set-section" hidden={!!sync.previewRequest}>
  <div class="set-section-head">
    <h3 class="set-section-title">Device sync</h3>
    <Segmented
      label="Device sync"
      options={TOGGLE_OPTS}
      value={sync.status.enabled ? "on" : "off"}
      choose={(v) => toggleSync(v === "on")}
    />
  </div>
  <p class="set-hint">
    Sync your notes to your other devices. It only runs when you press Sync now, with Set
    open on both.
  </p>
  {#if sync.status.enabled}
    <div class="sync" data-testid="sync-setup">
      <div class="set-field set-field-stack">
        <span class="set-field-label">This device's code</span>
        <div class="row">
          {#if sync.status.pairingCode}
            <code
              class="chip mono"
              class:renewed
              title={sync.status.pairingCode}
              data-testid="sync-code">{shortCode(sync.status.pairingCode)}</code
            >
            <Button onclick={copyPairingCode}>{codeCopied ? "Copied" : "Copy"}</Button>
            <Button onclick={regeneratePairingCode} disabled={sync.busy}>New code</Button>
          {:else}
            <span class="chip waiting">Starting up…</span>
          {/if}
        </div>
        <p class="set-hint" aria-live="polite">
          {#if renewed && sync.lastPaired}
            {sync.lastPaired.name} used the last code. This one is for your next device.
          {:else}
            One code pairs one device. You'll be asked to allow it here.
          {/if}
        </p>
      </div>
      <div class="set-field set-field-stack">
        <span class="set-field-label">Pair a device</span>
        <div class="row">
          <input
            class="control chip mono"
            type="text"
            placeholder="Paste the code from your other device"
            aria-label="The other device's pairing code"
            bind:value={pairingInput}
            disabled={pairing}
            onkeydown={(e) => e.key === "Enter" && pairDevice()}
          />
          <Button
            variant="primary"
            onclick={pairDevice}
            disabled={sync.busy || !pairingInput.trim()}
          >
            {pairing ? "Waiting" : "Pair"}
          </Button>
        </div>
        {#if pairing}
          <p class="set-hint" aria-live="polite">Click Allow on the other device.</p>
        {/if}
      </div>
      <div class="set-group-head">
        <h4 class="set-group-title">Devices</h4>
        {#if sync.status.peers.length > 0}
          <Button onclick={() => syncNow()} disabled={sync.busy}
            >{syncing ? "Syncing" : "Sync now"}</Button
          >
        {/if}
      </div>
      {#if sync.status.peers.length === 0}
        <p class="empty">No devices yet.</p>
      {:else}
        <ul class="peers" data-testid="sync-peers">
          {#each sync.status.peers as peer (peer.id)}
            <li>
              <div class="peer-line">
                <span
                  class="dot"
                  class:connected={peer.connected}
                  class:syncing={peer.syncing}
                  class:failing={!!peer.lastError}
                ></span>
                <span class="peer-name">{peer.name}</span>
                <span class="peer-state">{peerState(peer)}</span>
                <Button
                  bind:ref={unpairEls[peer.id]}
                  tone="danger"
                  onclick={() => unpairDevice(peer)}>Unpair</Button
                >
              </div>
              {#if peer.lastError}
                <p class="peer-why set-error">{peer.lastError}</p>
              {:else if peer.pairingPending}
                <p class="peer-why">Not reached yet. It pairs on your next sync.</p>
              {/if}
              {#if peer.tooBig.length > 0}
                <p class="peer-why" data-testid="sync-too-big">
                  {tooBigLabel(peer.tooBig)}
                </p>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      <div class="set-group-head">
        <h4 class="set-group-title">Activity</h4>
        <div class="actions">
          <Button onclick={copyReport}>{reportCopied ? "Copied" : "Copy report"}</Button>
          {#if syncLog.length > 0}
            <Button onclick={clearSyncLog}>Clear</Button>
          {/if}
        </div>
      </div>
      {#if syncLog.length === 0}
        <p class="empty">Nothing yet.</p>
      {:else}
        <ul class="log" data-testid="sync-log">
          <!-- Unkeyed on purpose: nothing in an entry is unique, and a duplicate key would take the panel down. -->
          {#each shownLog as entry}
            <li>
              <span class="when">{whenLabel(entry.at)}</span>
              <span
                class="what"
                class:set-error={entry.level === "error"}
                class:warn={entry.level === "warn"}>{describe(entry)}</span
              >
            </li>
          {/each}
        </ul>
        {#if syncLog.length > LOG_PREVIEW}
          <button
            type="button"
            class="control quiet more"
            onclick={() => (logExpanded = !logExpanded)}
          >
            {logExpanded ? "Show less" : `Show all ${syncLog.length}`}
          </button>
        {/if}
        <p class="set-hint">The report never includes your code.</p>
      {/if}
    </div>
  {/if}
</section>

<style>
  .actions {
    display: inline-flex;
    gap: 0.4rem;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.4rem;

    max-width: 34rem;
  }

  .chip {
    flex: 1;
    min-width: 0;
    box-sizing: border-box;
    height: 1.9rem;
    display: flex;
    align-items: center;
    padding: 0 0.6rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 0.78rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition:
      border-color 0.3s ease,
      color 0.3s ease;
  }
  .mono {
    font-family: var(--font-mono);
  }

  code.chip {
    user-select: text;
  }
  /* The code just changed under the user; draw the eye to it. */
  .chip.renewed {
    border-color: var(--accent);
    color: var(--text);
  }
  .waiting {
    color: var(--text-subtle);
  }

  input.chip:hover {
    background: var(--bg-elevated);
    border-color: var(--border);
    color: var(--text);
  }
  input.chip:focus-visible {
    border-color: var(--accent);
    color: var(--text);
  }

  .sync {
    margin-top: 0.9rem;
    padding-top: 0.9rem;
    border-top: 1px solid var(--border);
  }
  .sync .set-field-stack + .set-field-stack {
    margin-top: 0.9rem;
  }

  .empty {
    margin: 0.2rem 0 0;
    font-size: 0.8rem;
    color: var(--text-subtle);
  }

  .peers {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-elevated);
    overflow: hidden;
  }
  .peers li {
    padding: 0.5rem 0.6rem;
  }
  .peers li + li {
    border-top: 1px solid var(--border);
  }
  .peer-line {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    font-size: 0.85rem;
  }
  .peer-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .peer-state {
    font-size: 0.78rem;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .peer-why {
    margin: 0.3rem 0 0 1.05rem;
    font-size: 0.78rem;
    line-height: 1.45;
    color: var(--text-muted);
  }

  .dot {
    flex: none;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--text-subtle);
  }
  .dot.connected {
    background: var(--accent);
  }
  .dot.failing {
    background: var(--danger);
  }

  .dot.syncing {
    background: var(--accent);
    animation: dot-pulse 1.1s ease-in-out infinite;
  }
  @keyframes dot-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.3;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot.syncing {
      animation: none;
    }
    .chip {
      transition: none;
    }
  }

  .log {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .log li {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    font-size: 0.78rem;
    color: var(--text-muted);
    padding: 0.12rem 0;
  }
  .when {
    flex: 0 0 auto;
    min-width: 3.2rem;
    font-variant-numeric: tabular-nums;
    color: var(--text-subtle);
  }
  .what {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .warn {
    color: var(--text);
  }
  .more {
    margin: 0.45rem 0 0 -0.4rem;
    font-size: 0.75rem;
    padding: 0.15rem 0.4rem;
  }
</style>
