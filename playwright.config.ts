import { defineConfig, devices } from "@playwright/test";

/* Runs against the built app served by `vite preview`, not the dev server. */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
    // Every spec starts already welcomed; welcome.spec.ts clears this.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: "http://localhost:4173",
          localStorage: [
            {
              name: "set:settings",
              value: JSON.stringify({ app: "set", settings: { welcomedAt: 1 } }),
            },
          ],
        },
      ],
    },
  },
  projects: [
    {
      name: "chromium",
      // Fixed viewport so the virtualization window is deterministic.
      use: { ...devices["Desktop Chrome"], viewport: { width: 1000, height: 800 } },
    },
  ],
  webServer: {
    // Run `pnpm build` first.
    command: "pnpm preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
