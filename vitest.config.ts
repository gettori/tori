import { defineConfig } from "vitest/config";

// Standalone test config (takes precedence over vite.config.ts) so the
// vite-plugin-solid jsdom setup isn't pulled in. The unit tests cover pure,
// DOM-free helpers, so the lightweight node environment is enough.
export default defineConfig({
  // Resolve solid-js to its browser build. The default node condition pulls in
  // solid's server build, whose Icon module throws a "client-only API" error at
  // import time, which would break any test that imports a lucide-solid icon
  // (e.g. the icon registry). We never render here, just import the components.
  resolve: {
    conditions: ["browser", "development"],
  },
  ssr: {
    resolve: {
      conditions: ["browser", "development"],
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Externalized node_modules bypass Vite's resolve conditions and get the
    // node (server) build of solid-js; inline them so the browser build is used.
    server: {
      deps: {
        inline: ["lucide-solid", "solid-js"],
      },
    },
  },
});
