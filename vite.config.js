import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [sveltekit()],

  // Do not obscure rust errors.
  clearScreen: false,
  // Tauri expects a fixed port.
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    // The Tauri webview fires its whole preload graph at once and can request a component's style
    // chunk before it is compiled, so Vite serves raw .svelte source as CSS. Warming the graph
    // closes the race.
    warmup: {
      clientFiles: ["./src/**/*.svelte"],
    },
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
