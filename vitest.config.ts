import { defineConfig } from "vite-plus";
import solid from "@solidjs/vite-plugin";

// Standalone test config (takes precedence over vite.config.ts), split into two
// projects because the two kinds of test want opposite things.
//
//   * **unit** (`*.test.ts`) - the pure, DOM-free helpers. Node environment, no
//     JSX transform, no jsdom to construct. This is the bulk of the suite and it
//     stays fast; nothing here should ever need a document.
//   * **dom** (`*.test.tsx`) - components actually mounted, through
//     `src/test/harness.ts`. Needs jsdom and needs `@solidjs/vite-plugin`,
//     since Solid's JSX compiles to reactive DOM calls rather than to a
//     runtime `h()` a plain esbuild transform could produce.
//
// Splitting on the file extension rather than on a directory keeps a component's
// mounted test next to its unit test, and makes which environment a file gets a
// property of the file rather than of where somebody put it.

// Resolve solid-js to its browser build: the default node condition pulls in
// its server build, which cannot render a component. Both projects need this,
// and a project does not inherit the root's copy.
const solidResolve = {
  resolve: { conditions: ["browser", "development"] },
  ssr: { resolve: { conditions: ["browser", "development"] } },
};
// Patterns, not bare names: a bare "solid-js" leaves `@solidjs/web` externalized,
// loading a second Solid whose reactive graph is separate, so a portalled
// dropdown would survive `cleanup` into the next test.
const inlineSolid = {
  deps: { inline: [/solid-js/, /@solidjs\//] },
};

export default defineConfig({
  test: {
    projects: [
      {
        ...solidResolve,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts", "extension/src/**/*.test.ts", "mobile/src/**/*.test.ts"],
          server: inlineSolid,
        },
      },
      {
        ...solidResolve,
        plugins: [solid()],
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/**/*.test.tsx", "mobile/src/**/*.test.tsx"],
          // `@testing-library/jest-dom` is a devDependency for one reason, and
          // it is not that any test uses its matchers. @solidjs/vite-plugin has an
          // optional peer on it, and when that peer resolves the plugin appends
          // `@testing-library/jest-dom/vitest` to setupFiles by itself. Adding
          // Storybook pulled jest-dom into the tree, which satisfied the peer
          // and switched that injection on. Undeclared, whether the package is
          // linked at the project root is a hoisting accident: it was on macOS
          // and was not on CI, where all 103 dom files then failed to collect
          // with `Cannot find module .../@testing-library/jest-dom/vitest` and
          // `setup 0ms`, so this file never ran either. Declaring it makes the
          // link deterministic. Note the plugin's entry is *appended* to this
          // array rather than replacing it, so both run.
          // Hooks unwind in reverse, so the tally is taken after `cleanup` has run.
          setupFiles: ["src/test/solidDiagnostics.ts", "src/test/domSetup.ts"],
          // Vitest's default is 5s, and the heaviest axe scans (the icon grid in
          // `ProjectIconDialog`, the one in `SpaceDialog`) measure ~5s on their
          // own under a full run's parallel load - fast in isolation, over the
          // line when every worker is running axe at once. Adding two test files
          // in #106 was enough to tip them, which makes 5s a cliff the suite
          // happened to be standing on rather than a limit anything chose. The
          // scans are genuinely that expensive; the timeout is what was wrong.
          testTimeout: 20_000,
          server: inlineSolid,
        },
      },
    ],
  },
});
