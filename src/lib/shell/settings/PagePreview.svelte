<script lang="ts">
</script>

<div class="preview" aria-hidden="true">
  <div class="preview-title">The quick brown fox</div>
  <p class="preview-body">
    Jumps over the lazy dog, then settles in for a long, quiet afternoon of <span
      class="preview-accent">reading</span
    >
    and the occasional <span class="preview-link">link</span>.
  </p>
  <div class="preview-h">A section heading</div>
  <p class="preview-body">
    Density controls the line height and the spacing between blocks.
  </p>
  <span class="preview-pill">Selected</span>
</div>

<style>
  .preview {
    height: min(100%, calc(var(--preview-w) * 1.414));
    aspect-ratio: 1 / 1.414;
    max-width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--border);
    border-radius: 10px;

    background: var(--editor-bg);
    box-shadow: 0 12px 32px oklch(0% 0 0 / 0.22);
    padding: clamp(1rem, 3.5%, 1.75rem);
    font-family: var(--font-body);

    color: var(--text);
    line-height: var(--editor-line-height);

    overflow: hidden;
  }
  .preview-title {
    font-family: var(--font-body);
    font-size: calc(var(--editor-font-size) * 1.875);
    font-weight: 700;
    line-height: 1.2;
    margin-bottom: 0.6rem;
  }
  .preview-h {
    font-size: calc(var(--editor-font-size) * 1.25);
    font-weight: 600;
    line-height: 1.3;
    margin: 0.9rem 0 0.35rem;
  }
  .preview-body {
    margin: var(--block-gap) 0 0;
    font-size: var(--editor-font-size);
  }
  .preview-accent {
    color: var(--accent);
    font-weight: 600;
  }
  /* A link's look, not a link: the preview is a picture of a page, nothing in it goes anywhere. */
  .preview-link {
    color: var(--accent);
    text-decoration: underline;
    text-decoration-color: var(--accent-soft);
    text-underline-offset: 2px;
  }
  .preview-pill {
    display: inline-block;
    margin-top: 0.8rem;
    padding: 0.15rem 0.6rem;
    font-size: 0.75rem;
    border-radius: 999px;
    background: var(--accent);
    color: var(--on-accent);
  }
</style>
