---
summary: Storybook runs the Kobalte wrappers on the app's real tokens with no pin, no viteFinal and docgen off
status: current
updated: 2026-11-17
source: "plan \"Storybook 10 workshop with a11y addon and theme toolbar\" (personal/tori, branch `96-storybook`, issue #96, part of #93); `.storybook/main.ts`, `.storybook/preview.tsx`; gettori/tori#96 comment 5259157006; the kitchen sink from plan \"Visual polish pass with a Storybook kitchen sink\" (branch ui-rework), src/dev/KitchenSink.stories.tsx, src/dev/stubHost.ts:9, commits 844ac739 to f3fce4b5"
---

# The Storybook workshop

**Location:** `.storybook/` (key files: `main.ts`, `preview.tsx`, `preview.css`), `src/components/Button/Button.stories.tsx`

Storybook 10 as the component workshop for the design-system wrappers: one component at a time, on the real token layer, with the real theme resolver and an axe panel. It exists beside the in-app `/styleguide` (`src/dev/Styleguide.tsx`), which stays the theme/brand QA surface and was deliberately not ported. Stories colocate with their component (`Button.stories.tsx` next to `Button.tsx`), matching the existing `*.test.tsx` convention.

The interesting content of this component is not the config file, it is four decisions that each look like an omission until you know why.

## Responsibilities

- Render a single component in isolation against the same four global sheets the app loads, in the same order, so what a story shows is what the chrome shows.
- Switch all five bundled palettes from a toolbar, through the real resolver, without persisting the selection.
- Run axe in a real browser, where paint and layout exist.
- It does NOT own theme/brand QA (that is `/styleguide`), does NOT run in CI, and does NOT participate in `pnpm test`. Nothing in the repo's gates depends on it.

## Key files & entry points

- `.storybook/main.ts` - framework selection, stories glob, a11y addon, and the `docgen: false` option.
- `.storybook/preview.tsx` - the four global CSS imports in `src/App.tsx` order, the `theme` toolbar global, and the decorator that paints the palette.
- `.storybook/preview.css` - paints the story canvas from `--canvas-default` / `--fg-default` so a dark story is not judged against Storybook's white default.
- `src/components/Button/Button.stories.tsx` - the first stories: knob-driven `Playground`, plus `Variants`, `Sizes`, `WithIcons`, `Disabled`.

## The four decisions

**1. No pin and no pnpm peer workaround.** #96 was written expecting a fight: `storybook-solidjs-vite` peers `@solidjs/web ^2.0.0-0`, a Solid 2 package this repo does not use. By 10.6.0 that peer is `peerDependenciesMeta.optional: true`, and the framework ships two renderers, choosing at config time with `solidVersion === 2 ? solid-next : solid-legacy`. Detection coerces the declared range (`^1.9.3` to `1.9.3`), so Solid 1.9 lands on `renderer/solid-legacy`, which imports `solid-js/web` and never touches `@solidjs/web`. Verified at the module graph, not from registry metadata: the preview's `project-annotations.js` imports `dist/renderer/solid-legacy.js`. `10.0.13` was the last release whose peers named Solid 1 alone, and pinning to it would have forfeited fixes to buy nothing.

**2. No `viteFinal`.** #96 asked for the app's Vite config to be reused, and it already is: `@storybook/builder-vite`'s `commonConfig` does `loadConfigFromFile` then `mergeConfig(userConfig, sbConfig)`. Writing a merge by hand is worse than writing none, because the framework preset guards the one real hazard itself, adding `vite-plugin-solid` only `if (!await hasVitePlugins(existPlugins, ["solid"]))`. A hand-rolled merge reintroduces the double JSX transform that guard exists to prevent. The app's `server.port: 1420` and `strictPort: true` come along in the merge but never bind, because Storybook runs Vite with `middlewareMode: true` and `appType: "custom"`.

**3. Palettes come from `theme/bundled.ts`, not the `src/theme` barrel.** `src/theme/index.ts` re-exports `userThemes.ts`, which imports `@tauri-apps/api/core`. The workshop is a plain browser page with no Tauri host, so it reads the static-JSON half of the theme system directly: `listSelectableBundled()`, `getBundledTheme()`, then `applyResolved(buildRoles(palette), appearance)`. That is the same call `/styleguide` makes and deliberately not `setTheme`, which also persists the selection, since a workshop must not rewrite which theme the app boots into.

**4. `docgen` is off.** Not a preference. See [[gotcha_storybook_solidjs_vites_docgen_breaks_on_an_export_default_function_component]].

The decorator calls `applyResolved` straight from its body rather than from a `createEffect` as `/styleguide` does. `/styleguide` reacts to a signal that changes without a re-render, so it needs one; Storybook re-invokes the decorator on every globals change, so an effect would add no reactivity and only defer the paint until after the story's DOM exists, which is the flash `src/index.tsx`'s synchronous `applyCachedTheme()` exists to avoid.

## What was measured

Theme switching was verified through the Chrome DevTools Protocol against the live story iframe rather than by eye. Both `tori-dark` and `tori-light` paint the full **110** inline role props on `<html>` (not a partial overwrite, because `paintRoles` iterates the whole `OWNED` set and removes what a palette does not produce), flip `data-theme`, and move the computed body background between `rgb(21,23,28)` and `rgb(255,255,255)`, matching `--canvas-default` in each theme. Inter resolves, which also proves Vite serves `public/` here (builder-vite sets `root` to the project root and never overrides `publicDir`).

axe was run against the live iframes: an icon-only button with no accessible name yields one critical `button-name` violation, while `WithIcons`, which contains an icon-only button **with** `aria-label`, passes with ten checks. The fixture that proved this was deliberately transient and removed; the repo ships no story that intentionally fails axe.

## What it cost the app

Adding the dependency was not free, and the one real cost is worth knowing before the next wrapper ticket adds anything. Storybook pulled `@testing-library/jest-dom` into the tree, which satisfied `vite-plugin-solid`'s optional peer on it and switched on that plugin's own `setupFiles` injection. `@testing-library/jest-dom` is therefore now an explicit devDependency, and not because any test wants its matchers: undeclared, its root link was a hoisting accident that held locally and failed on CI. See [[gotcha_an_added_devdependency_can_switch_on_vite_plugin_solids_jest_dom_injection]].

The check that missed it was this plan's own: it compared `pnpm list vite vite-plugin-solid` before and after, which reports **versions**, and the versions genuinely did not move. What moved was the peer resolution key inside the lockfile. Diff the lockfile's importer entries, not a version list.

## The kitchen sink

`src/dev/KitchenSink.stories.tsx` ("Design/Kitchen sink") is one story with a section per piece of the visual polish pass: motion probes, buttons, overlays, checks, composer, transcript, prompts, selection, lists, sidebar and one diagram per mermaid kind. Every section is checked in tori-dark and tori-light; motion is checked headless against the static build (`storybook-static` served locally, driven over the DevTools Protocol, and in Playwright's WebKit for anything the app's engine paints differently).

- **One host stub for the page.** `mockIPC` replaces the whole host, so two sections each stubbing it would silently unplug the first. `stubHost(handlers)` (`src/dev/stubHost.ts:9`) installs one handler that asks each fixture in turn; a fixture answers the commands it owns and `undefined` otherwise. It also calls `mockWindows("main")` and passes `shouldMockEvents`, which any harness that calls `listen` needs.
- **Harnesses live in `__fixtures__` modules**, exporting their `HostHandler` and a pane (`src/panels/Chat/__fixtures__/` for the composer, transcript and prompts, `src/panels/LeftSidebar/__fixtures__/sidebar.tsx`), so a component's own story and the kitchen sink share one harness. A check 1 exemption moves with its harness.
- **The root is its own scroller** (`position: fixed; inset: 0; overflow-y: auto`): `App.css` locks `html`, `body` and `#root` with `overflow: hidden`, which suits a window and leaves a long story unscrollable. Changing `preview.css` instead would touch every story.

## Connections

- Governed by [[adr_headless_primitives]] - names Storybook as the workshop for the Kobalte wrappers; this implements that clause.
- Depends on [[concept_design_token_system]] - the four-sheet import order and the inline-prop key-ownership contract.
- Depends on [[component_theme_engine]] - `bundled.ts` / `roles.ts` / `resolver.ts`, used directly rather than through the barrel.
- Documents [[component_button]] - the first component with stories.
- Sibling of [[concept_axe_accessibility_gate]] - that gate is the jsdom floor in `pnpm test`; this panel is the browser view, and it sees what jsdom cannot.

## Related

- [[concept_one_shot_entrances]], [[component_glide]], [[component_diagram]]: what the kitchen sink's sections exercise.
- [[gotcha_storybook_solidjs_vites_docgen_breaks_on_an_export_default_function_component]] - why `docgen: false` is mandatory here.
- [[gotcha_a_role_value_cannot_prove_the_css_import_order_is_right]] - why the import order is checked by inversion.
- [[gotcha_storybook_is_outside_the_token_guards_scan]] - `.storybook/` CSS is unguarded.
- [[gotcha_npm_cannot_graft_onto_this_pnpm_tree]] - `pnpm add` only, which is how the deps went in.
