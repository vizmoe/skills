import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/visual",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60000,
  snapshotPathTemplate: "{testDir}/../baselines/{arg}{ext}",
  updateSnapshots: "none",
  use: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
  },
  expect: {
    toHaveScreenshot: {
      maxDiffPixels: 0,
      threshold: 0,
      animations: "disabled",
    },
  },
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "dist/visual-report" }],
  ],
});
