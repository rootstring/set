<script lang="ts">
  import AppearanceControls from "../settings/AppearanceControls.svelte";
  import PagePreview from "../settings/PagePreview.svelte";
</script>

<section class="ob-step ob-step-wide split">
  <div class="controls">
    <h2 class="ob-title">Make it yours</h2>
    <AppearanceControls />
  </div>
  <aside class="preview-col" aria-label="Preview">
    <PagePreview />
  </aside>
</section>

<style>
  .split {
    display: flex;
    align-items: flex-start;
    gap: 1.75rem;
  }

  .controls {
    flex: 1 1 auto;
    min-width: 0;
  }

  .preview-col {
    --preview-w: 18rem;
    flex: 0 0 var(--preview-w);
    height: min(var(--stage-h), calc(var(--preview-w) * 1.414));
    position: sticky;
    top: 0;
  }

  @media (max-width: 820px) {
    .preview-col {
      display: none;
    }
  }
</style>
