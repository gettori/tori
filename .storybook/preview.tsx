import type { Preview } from "storybook-solidjs-vite";
import {
  DEFAULT_THEME_ID,
  getBundledTheme,
  listSelectableBundled,
} from "../src/theme/bundled";
import { buildRoles } from "../src/theme/roles";
import { applyResolved } from "../src/theme/resolver";

// The same four global sheets the app loads, in the same order (src/App.tsx).
// The order is load-bearing: App.css is deliberately un-layered, so it sits
// above everything in `@layer` and must come last. Swapping any two of these
// changes what wins, and a role value read off <html> will NOT show it, since
// inline props outrank the whole token layer.
import "../src/styles/reset.css";
import "../src/styles/tokens.css";
import "../src/styles/base.css";
import "../src/App.css";
import "./preview.css";

// Palettes come from bundled.ts rather than the src/theme barrel on purpose:
// the barrel re-exports userThemes.ts, which imports @tauri-apps/api/core, and
// the workshop runs in a plain browser with no Tauri host behind it. Bundled
// themes are static JSON, so this half of the theme system works unchanged.
const THEMES = listSelectableBundled();

const preview: Preview = {
  globalTypes: {
    theme: {
      description: "Sway theme",
      toolbar: {
        title: "Theme",
        icon: "paintbrush",
        dynamicTitle: true,
        items: THEMES.map((t) => ({ value: t.id, title: t.label })),
      },
    },
  },
  initialGlobals: { theme: DEFAULT_THEME_ID },
  decorators: [
    (Story, context) => {
      const theme = getBundledTheme(context.globals.theme as string) ?? THEMES[0];
      // Paints through the real resolver, exactly as the app does: the role
      // cssVars land as inline props on <html> and `data-theme` follows the
      // appearance, so the token layer's light/dark block agrees with them.
      // Deliberately not setTheme, which also persists the selection - the
      // workshop must not rewrite which theme the app boots into.
      //
      // Called straight from the decorator body rather than from a
      // `createEffect` as Styleguide does. Styleguide reacts to a signal that
      // changes without a re-render, so it needs one; Storybook re-invokes the
      // decorator on every globals change, so an effect would add no
      // reactivity and only defer the paint until after the story's DOM
      // exists - the flash that index.tsx's synchronous applyCachedTheme()
      // exists to avoid.
      applyResolved(buildRoles(theme.palette), theme.appearance);
      return <Story />;
    },
  ],
  parameters: {
    // The token layer owns the canvas (see preview.css); Storybook's own
    // background switcher would paint over it with a literal color.
    backgrounds: { disable: true },
  },
};

export default preview;
