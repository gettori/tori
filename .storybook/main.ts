import type { StorybookConfig } from "storybook-solidjs-vite";

// The component workshop. The in-app `/styleguide` (src/dev/Styleguide.tsx)
// stays the theme/brand QA surface; this is where individual components are
// developed and checked for accessibility, one at a time.
//
// There is deliberately no `viteFinal`. The builder already loads the app's
// vite.config.ts and merges it, and the framework skips adding its own
// vite-plugin-solid when the merged config already has one - so a hand-rolled
// merge here would reintroduce the double JSX transform it exists to avoid.
// The app's `server.port`/`strictPort` come along but are inert: Storybook runs
// Vite in middleware mode, so nothing binds the app's dev port.
//
// The framework picks its renderer from the installed Solid major
// (`solidVersion === 2 ? solid-next : solid-legacy`), so this repo gets the
// Solid 1 renderer without a pin. `@solidjs/web` is an optional peer and is
// deliberately NOT installed; installing it would flip nothing, since the
// selection reads solid-js itself.
// `docgen` is off because the generator is broken for this codebase's export
// style. It appends `<displayName>.__docgenInfo = {...}` to each component
// module, and for `export default function Button()` it emits the displayName
// literally as `default.__docgenInfo`, which is a reserved word in expression
// position: esbuild rejects it and `build-storybook` fails. Every component
// here is an `export default function`, so this is not a one-component
// workaround. Stories declare their own `argTypes`, which is what the props
// table would have been inferred into anyway.
const config: StorybookConfig = {
  framework: {
    name: "storybook-solidjs-vite",
    options: { docgen: false },
  },
  stories: ["../src/**/*.stories.tsx"],
  addons: ["@storybook/addon-a11y"],
};

export default config;
