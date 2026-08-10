import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const directory = path.dirname(fileURLToPath(import.meta.url));
const evidence = path.resolve(directory, "../../.artifacts/evidence");

export default defineConfig({
  testDir: "./e2e",
  outputDir: path.join(evidence, "results"),
  fullyParallel: false,
  retries: 0,
  reporter: [
    ["list"],
    ["json", { outputFile: path.join(evidence, "results.json") }],
    ["html", { outputFolder: path.join(evidence, "report"), open: "never" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:6006",
    video: "on",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "tablet",
      use: { ...devices["Desktop Chrome"], viewport: { width: 900, height: 1024 } },
    },
    { name: "mobile", use: { ...devices["iPhone 13"], browserName: "chromium" } },
  ],
  webServer: {
    command: "pnpm storybook",
    cwd: directory,
    url: "http://127.0.0.1:6006/iframe.html",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
