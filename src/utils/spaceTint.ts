// A space's colour: the hue of the window's background wash.
//
// The shell paints one soft radial gradient anchored off the top-left corner
// (see `.app` in App.css). Its geometry and its strength belong to the theme;
// only the HUE belongs to the space, so switching workspace re-tints the whole
// window without changing how strong the wash reads on a dark or a light
// canvas. That split is why this module deals in opaque colours and never in
// alpha: `App.css` mixes the strength in.
//
// The values below are DATA, not palette. A space's colour is a user's choice
// stored in `sway.toml` beside its name and icon, exactly like its icon name,
// and it must render identically in every theme - a swatch that changed
// meaning when you switched theme would make the setting meaningless. That is
// why this file is allowlisted in `scripts/check-tokens.mjs` rather than
// pushed into the token layer.

/** One swatch: the key stored in `sway.toml` and the hue it paints. */
export interface SpaceColor {
  /** The name stored in `[[space]].color` and used by `resolveColor`. */
  name: string;
  hex: string;
}

// Twelve hues at a similar lightness and saturation, spread around the wheel so
// two adjacent spaces never read as the same wash, and none of them turns muddy
// at the low opacities the shell mixes them down to. Amber is first because it
// is the brand hue and so the one the app has always washed with.
export const SPACE_COLORS: SpaceColor[] = [
  { name: "Amber", hex: "#d9a468" },
  { name: "Coral", hex: "#e08a6a" },
  { name: "Rose", hex: "#e0808f" },
  { name: "Magenta", hex: "#d98ad4" },
  { name: "Violet", hex: "#ab8ae6" },
  { name: "Indigo", hex: "#8a9ae6" },
  { name: "Sky", hex: "#6fb0e0" },
  { name: "Teal", hex: "#63c1c1" },
  { name: "Emerald", hex: "#6fc59a" },
  { name: "Lime", hex: "#a8cc7a" },
  { name: "Gold", hex: "#d9c168" },
  { name: "Slate", hex: "#93a1b5" },
];

const BY_NAME: Map<string, string> = new Map(SPACE_COLORS.map((c) => [c.name, c.hex]));

/** Resolve a stored swatch name to its hue, or `undefined` when the key is
 *  unknown or blank so the caller can fall back to the derived one. */
export function resolveColor(name: string | undefined | null): string | undefined {
  if (!name) return undefined;
  return BY_NAME.get(name);
}

/** The hue a space gets when nobody picked one: a stable choice from the set,
 *  hashed on the space's name. Every space therefore looks distinct from the
 *  moment it appears, and choosing a colour is an override rather than a
 *  prerequisite. Deliberately the same trick as the derived project glyph - it
 *  reads as arbitrary, but a genuinely random pick would re-tint the window on
 *  every render. */
export function fallbackColor(seed: string): string {
  // FNV-1a over the seed's UTF-16 units; `>>> 0` keeps every step unsigned.
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return SPACE_COLORS[h % SPACE_COLORS.length].hex;
}

/** The hue for a space: what it chose, else what its name derives to. */
export function spaceHue(name: string, color: string | undefined | null): string {
  return resolveColor(color) ?? fallbackColor(name);
}

/** A hex as the bare space-separated channel triple CSS composes an alpha with:
 *  `rgb(var(--x) / 10%)`. The shell and the space tiles both need a wash of the
 *  hue rather than the hue itself, and an alpha cannot be varied once it is
 *  baked into a colour. (`color-mix()` would express the same thing, but fed
 *  from a `var()` it resolves too late in some engines and the declaration is
 *  dropped whole - taking the rest of the shorthand with it. A substituted
 *  triple is an ordinary `rgb()` by the time anything parses it.) */
export function rgbTriple(hex: string): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/** `spaceHue` as a channel triple, which is what every consumer actually sets. */
export function spaceHueRgb(name: string, color: string | undefined | null): string {
  return rgbTriple(spaceHue(name, color));
}

/** The one inline custom property this module owns on `<html>`.
 *
 *  `<html>` has several writers (the theme resolver owns the role variables,
 *  the settings store owns `--ui-*` and `--editor-font-*`) and the contract
 *  between them is that each only ever touches its OWN keys and never clears
 *  the element's style wholesale - inline props outrank
 *  `:root[data-theme="light"]`, so a blanket write silently destroys another
 *  writer's values. This is the fourth owner, and it owns exactly this key. */
const TINT_PROP = "--space-tint-rgb";

/** Paint the window's wash in `hue` (a hex), or hand the key back to the token
 *  layer when there is no active space at all (first run). Removing the property
 *  rather than writing a default is what lets `App.css`'s `--shell-glow-rgb`
 *  fall through, so the theme keeps the last word on an untinted window. */
export function applySpaceTint(hue: string | null, target?: { style: CSSStyleDeclaration }) {
  const el = target ?? (typeof document === "undefined" ? null : document.documentElement);
  if (!el) return;
  if (hue) el.style.setProperty(TINT_PROP, rgbTriple(hue));
  else el.style.removeProperty(TINT_PROP);
}
