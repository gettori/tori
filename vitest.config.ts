import { defineConfig } from "vitest/config";

// Standalone test config (takes precedence over vite.config.ts) so the
// vite-plugin-solid jsdom setup isn't pulled in. The unit tests cover pure,
// DOM-free helpers, so the lightweight node environment is enough.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
