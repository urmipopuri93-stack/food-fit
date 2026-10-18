import { defineConfig, devices } from "@playwright/test";

// Browser smoke tests. Start the servers first (see chat-api/README.md, "Testing"):
//   fake watsonx :8099 -> chat-api :8001 -> vite :5173
// CHROMIUM_PATH lets you point at a locally installed Chromium if
// `npx playwright install chromium` is not possible.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:5173",
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    launchOptions: process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] }
      : {},
  },
});
