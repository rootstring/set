<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
</script>

<div class="error">
  <p class="message">{page.error?.message ?? "Something went wrong."}</p>
  <button class="control" onclick={() => goto("/")}>Go to your notes</button>
</div>

<style>
  .error {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    height: 100%;
    padding: 1rem;
    text-align: center;
  }

  .message {
    color: var(--text-muted);
  }

  button {
    padding: 0.35rem 0.75rem;
  }
</style>
