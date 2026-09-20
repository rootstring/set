<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";

  import { settings } from "$lib/state/settings.svelte";
  import { startup } from "$lib/state/startup.svelte";
  import { workspace } from "$lib/state/workspace.svelte";
  import Button from "../Button.svelte";
  import DictationTab from "./DictationTab.svelte";
  import Field from "./Field.svelte";
  import Segmented from "./Segmented.svelte";
  import UpdatesSection from "./UpdatesSection.svelte";
  import { whenLabel, type Opt, type TabContext } from "./shared";

  let { ctx }: { ctx: TabContext } = $props();

  const TOGGLE_OPTS: Opt[] = [
    { value: "on", label: "On" },
    { value: "off", label: "Off" },
  ];

  function copied(set: (v: boolean) => void): void {
    set(true);
    setTimeout(() => set(false), 1600);
  }

  let notesPath = $state("");
  $effect(() => {
    settings.notesFolder; // refresh when it changes
    workspace.notesFolder().then((p) => (notesPath = p));
  });

  $effect(() => {
    void startup.refresh();
  });

  async function toggleStartup(on: boolean): Promise<void> {
    if (!(await startup.set(on))) {
      ctx.flash(`Couldn't ${on ? "add" : "remove"} the login item`, "warn");
    }
  }

  let mcpEnabled = $state(false);
  let mcpFile = $state<string | null>(null);
  let mcpBinary = $state<string | null>(null);
  let mcpCopied = $state(false);

  // Context scoping is not offered here, but `set-mcp` honours it, so a grant on file is carried
  // through rather than widened.
  let mcpAllowed = $state<string[] | null>(null);

  let mcpMode = $state("read");

  interface McpEvent {
    at: number;
    tool: string;
    detail: string;
    results: number;
  }
  let mcpActivity = $state<McpEvent[]>([]);

  $effect(() => {
    invoke<{
      enabled: boolean;
      mode: string;
      allowedContexts: string[] | null;
      file: string | null;
      binary: string | null;
    }>("mcp_access")
      .then((state) => {
        mcpEnabled = state.enabled;
        mcpMode = state.mode === "write" ? "write" : "read";
        mcpAllowed = state.allowedContexts;
        mcpFile = state.file;
        mcpBinary = state.binary;
      })
      .catch(() => {});
    void refreshActivity();
  });

  async function refreshActivity(): Promise<void> {
    try {
      mcpActivity = (await invoke<McpEvent[]>("mcp_activity")).reverse();
    } catch {
      mcpActivity = [];
    }
  }

  const mcpPrompt = $derived(
    `I keep my notes in an app called Set. Add its MCP server so you can \
${mcpMode === "write" ? "search, read, and add to" : "search and read"} them:

  name: set
  command: ${mcpBinary ?? "/path/to/set-mcp"}

It runs locally over stdio and takes no arguments.`,
  );

  async function saveMcp(
    enabled: boolean,
    allowed: string[] | null,
    mode: string = mcpMode,
  ): Promise<boolean> {
    try {
      await invoke("set_mcp_access", {
        enabled,
        notesDir: notesPath,
        allowedContexts: allowed,
        mode,
      });
      mcpEnabled = enabled;
      mcpAllowed = allowed;
      mcpMode = mode;
      return true;
    } catch {
      ctx.flash("Couldn't change agent access", "warn");
      return false;
    }
  }

  async function setMcpMode(mode: string): Promise<void> {
    await saveMcp(mcpEnabled, mcpAllowed, mode === "write" ? "write" : "read");
  }

  async function copyMcpPrompt(): Promise<void> {
    try {
      await navigator.clipboard.writeText(mcpPrompt);
      copied((v) => (mcpCopied = v));
    } catch {
      ctx.flash("Couldn't copy. Select the text instead", "warn");
    }
  }

  async function clearActivity(): Promise<void> {
    try {
      await invoke("clear_mcp_activity");
      mcpActivity = [];
    } catch {
      ctx.flash("Couldn't clear the activity log", "warn");
    }
  }

  function count(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
  }

  /** A narrowed read records the context it was held to as `detail`. */
  function narrowing(detail: string): string {
    return detail ? ` in “${detail}”` : "";
  }

  function activityLabel(event: McpEvent): string {
    switch (event.tool) {
      case "search_pages": {
        const held = /^(.*) \(in (.+)\)$/.exec(event.detail);
        const query = held ? held[1] : event.detail;
        return `Searched for “${query}”${narrowing(held ? held[2] : "")}: ${count(event.results, "match", "matches")}`;
      }
      case "get_page":
        return event.results === 0
          ? `Read refused: ${event.detail}`
          : `Read ${event.detail}`;
      case "list_contexts":
        return `Listed ${count(event.results, "context", "contexts")}`;
      case "list_pages":
        return `Listed ${count(event.results, "page", "pages")}${narrowing(event.detail)}`;
      case "create_page":
        return `Created ${event.detail}`;
      case "create_context":
        return `Created the context “${event.detail}”`;
      case "denied":
        return "An agent tried to connect while access was off";
      default:
        return event.tool;
    }
  }
</script>

<UpdatesSection />
<section class="set-section">
  <div class="set-section-head">
    <h3 class="set-section-title">Start at login</h3>
    <Segmented
      label="Start at login"
      options={TOGGLE_OPTS}
      value={startup.enabled ? "on" : "off"}
      choose={(v) => toggleStartup(v === "on")}
    />
  </div>
  <p class="set-hint">Sync and outside edits need Set running.</p>
</section>
<DictationTab {ctx} />
<section class="set-section">
  <div class="set-section-head">
    <h3 class="set-section-title">Agent access</h3>
    <Segmented
      label="Agent access"
      options={TOGGLE_OPTS}
      value={mcpEnabled ? "on" : "off"}
      choose={(v) => saveMcp(v === "on", mcpAllowed)}
    />
  </div>
  <p class="set-hint">Let AI agents reach your notes.</p>
  {#if mcpEnabled}
    <div class="mcp" data-testid="mcp-setup">
      <div class="set-field set-field-stack">
        <span class="set-field-label">Paste this to your agent</span>
        <pre class="snippet"><code>{mcpPrompt}</code></pre>
        <div class="actions">
          <Button onclick={copyMcpPrompt}>{mcpCopied ? "Copied" : "Copy prompt"}</Button>
        </div>
        {#if !mcpBinary}
          <p class="set-hint">
            Swap <code>/path/to/set-mcp</code> for your build.
            <code>cargo build --release --bin set-mcp</code> puts it in
            <code>src-tauri/target/release/</code>.
          </p>
        {/if}
        {#if mcpFile}
          <p class="set-path" title={mcpFile}>{mcpFile}</p>
        {/if}
      </div>
      <Field label="Access mode">
        <Segmented
          label="Access mode"
          options={[
            { value: "read", label: "Read only" },
            { value: "write", label: "Read & add" },
          ]}
          value={mcpMode}
          choose={setMcpMode}
        />
      </Field>
      <p class="set-hint">
        {#if mcpMode === "write"}
          Search, read, and add pages. A new sub-page is linked from its parent. It can't
          otherwise edit or delete.
        {:else}
          Search and read. It can't change anything.
        {/if}
      </p>

      <div class="set-group-head">
        <h4 class="set-group-title">Recent activity</h4>
        {#if mcpActivity.length > 0}
          <Button onclick={clearActivity}>Clear</Button>
        {/if}
      </div>
      {#if mcpActivity.length === 0}
        <p class="empty">Nothing yet.</p>
      {:else}
        <ul class="log" data-testid="mcp-activity">
          <!-- Unkeyed on purpose: two calls in one millisecond would be a duplicate key and take the panel down. -->
          {#each mcpActivity.slice(0, 8) as event}
            <li>
              <span class="when">{whenLabel(event.at)}</span>
              <span class="what">{activityLabel(event)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</section>

<style>
  .actions {
    display: inline-flex;
    gap: 0.4rem;
  }

  .mcp {
    margin-top: 0.9rem;
    padding-top: 0.9rem;
    border-top: 1px solid var(--border);
  }

  .empty {
    margin: 0.2rem 0 0;
    font-size: 0.8rem;
    color: var(--text-subtle);
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

  .snippet {
    margin: 0 0 0.6rem;
    padding: 0.65rem 0.75rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-family: var(--font-mono);
    font-size: 0.72rem;
    line-height: 1.5;
    color: var(--text);

    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }
</style>
