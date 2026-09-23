import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

// Pure logic under src/lib and packages/ only; no sveltekit() plugin. Storage and editor behaviour
// belongs in e2e/.
export default defineConfig({
  plugins: [svelte()],
  test: {
    include: ["src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL("./src/lib", import.meta.url)),
    },
    conditions: ["browser"],
  },
});
