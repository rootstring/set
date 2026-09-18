<script lang="ts">
  // Self-contained: shown instead of the app, so nothing the app sets up on mount may be used.
</script>

<main class="notice">
  <div class="mark" aria-hidden="true">Set</div>
  <h1>Set is <span class="nowrap">desktop-only</span> for now</h1>
  <p class="soft">A version for your phone is in the works.</p>
</main>

<style>
  .notice {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    /* Not 100vh: mobile browsers count their own chrome in it. */
    min-height: 100dvh;
    box-sizing: border-box;
    padding: 2rem 1.5rem;
    padding-bottom: max(2rem, env(safe-area-inset-bottom));
    gap: 0.75rem;
    text-align: center;
    text-wrap: balance;
    background-color: var(--bg);
    color: var(--text);
  }

  .mark {
    font-family: var(--font-serif);
    font-size: 1.25rem;
    letter-spacing: 0.02em;
    color: var(--text-subtle);
    margin-bottom: 1.5rem;
  }

  h1 {
    margin: 0;
    font-family: var(--font-serif);
    font-size: 1.5rem;
    font-weight: 500;
    line-height: 1.3;
  }

  /* A hyphen is a break opportunity. */
  .nowrap {
    white-space: nowrap;
  }

  p {
    margin: 0;
    max-width: 28rem;
    color: var(--text-muted);
  }

  .soft {
    color: var(--text-subtle);
    font-size: 0.9375rem;
  }
</style>
