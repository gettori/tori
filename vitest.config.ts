import { defineConfig } from "vite-plus";
import solid from "vite-plugin-solid";

// Standalone test config (takes precedence over vite.config.ts), split into two
// projects because the two kinds of test want opposite things.
//
//   * **unit** (`*.test.ts`) - the pure, DOM-free helpers. Node environment, no
//     JSX transform, no jsdom to construct. This is the bulk of the suite and it
//     stays fast; nothing here should ever need a document.
//   * **dom** (`*.test.tsx`) - components actually mounted, through
//     `@solidjs/testing-library`. Needs jsdom and needs `vite-plugin-solid`,
//     since Solid's JSX compiles to reactive DOM calls rather than to a
//     runtime `h()` a plain esbuild transform could produce.
//
// Splitting on the file extension rather than on a directory keeps a component's
// mounted test next to its unit test, and makes which environment a file gets a
// property of the file rather than of where somebody put it.

// Resolve solid-js to its browser build. The default node condition pulls in
// solid's server build, whose Icon module throws a "client-only API" error at
// import time, which would break any test that imports a lucide-solid icon (e.g.
// the icon registry). Externalized node_modules bypass Vite's resolve conditions
// and get the node build anyway, so they are inlined too.
//
// Both projects need this, and a project does not inherit the root's copy, so it
// is defined once here and spread into each rather than written three times.
const solidResolve = {
  resolve: { conditions: ["browser", "development"] },
  ssr: { resolve: { conditions: ["browser", "development"] } },
};
// Patterns, not bare names: a bare "solid-js" leaves `solid-js/web` externalized,
// which loads a *second* copy of Solid ("You appear to have multiple instances of
// Solid"). The two copies do not share a reactive graph, so a `<Portal>` created
// by one is not disposed when the other's root is - and a portalled dropdown
// would survive `cleanup` into the next test, which is precisely what
// `src/test/domSetup.ts` exists to prevent.
//
// **`@solidjs/testing-library` has to be listed separately**, and this is the
// trap: its path reads `@solidjs`, with no hyphen, so `/solid-js/` never matched
// it. Left externalized, it imported its own copy of Solid, and `render` opened
// a root in a reactive graph the components under test were not in: every
// component ran as an orphan ("computations created outside a `createRoot`"),
// `cleanup` disposed nothing of theirs, and the DOM only appeared to clear
// because the library removes its own container by hand. Portals, which hang off
// `document.body` instead, then piled up across the whole file.
//
// `@kobalte/core` is deliberately *not* on this list. It looks like it belongs
// - its `solid` export is untransformed `.jsx`, and the `default` export Node
// would otherwise pick resolves `solid-js/web` itself - but vitest 4 no longer
// externalizes dependencies by default, so Vite transforms it either way. The
// entry was added, measured against `src/lib/dialog.test.tsx`, and removed
// again: with it gone the dialog still mounts, still portals, and still gets
// cleaned up between tests. If a future vitest brings the old default back,
// that test is what will say so.
const inlineSolid = {
  deps: { inline: [/lucide-solid/, /solid-js/, /@solidjs\/testing-library/] },
};

export default defineConfig({
  test: {
    projects: [
      {
        ...solidResolve,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
          server: inlineSolid,
        },
      },
      {
        ...solidResolve,
        plugins: [solid()],
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          // `@testing-library/jest-dom` is a devDependency for one reason, and
          // it is not that any test uses its matchers. vite-plugin-solid has an
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
          setupFiles: ["src/test/domSetup.ts"],
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
