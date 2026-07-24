// The one door a palette passes through before anything paints it.
//
// Two stages, in this order:
//
//   1. STRUCTURAL (schema.ts). Does it name every key, and is every value a hex
//      colour? Rust checks the same thing on the way in (themes.rs), but a
//      bundled palette never goes through Rust, so this is where the two paths
//      become one.
//   2. LEGIBILITY (contrast.ts). Does every role clear its declared floor
//      against its declared surface? Structural validation cannot answer that:
//      a palette can be perfect and still be white on white.
//
// The order matters. An incomplete palette makes `buildRoleValues` yield
// `"rgba(undefined, ...)"` and `NaN` rather than throwing, so running the gate
// first would bury one missing key under a hundred unmeasurable pairs.
//
// `admit()` is the only producer of an `AdmittedPalette`, and the paint path in
// index.ts takes nothing else. That is what makes "a theme cannot reach the
// screen without passing the gate" a property of the types rather than of
// everyone remembering to call it.
import { checkPalette, formatReport } from "./contrast";
import { validatePalette } from "./schema";
import type { Palette } from "./schema";

declare const ADMITTED: unique symbol;

/** A palette that has passed both stages. Unforgeable outside this module. */
export type AdmittedPalette = Palette & { readonly [ADMITTED]: true };

export type Admission = { ok: true; palette: AdmittedPalette } | { ok: false; problems: string[] };

/** Validate then gate `value`. `source` labels the origin in every problem
 *  message: a bundled id, or the absolute path of a user theme file. */
export function admit(value: unknown, source: string): Admission {
  const structural = validatePalette(value);
  if (structural.length > 0) {
    return { ok: false, problems: structural.map((p) => `${source}: ${p}`) };
  }

  const palette = value as Palette;
  // formatReport already leads with the palette id, so a bundled theme would
  // otherwise name itself twice. A user theme still gets its file path, which
  // is the thing the reader has to go and edit.
  const prefix = source === palette.id ? "" : `${source}: `;
  const legibility = formatReport(checkPalette(palette));
  if (legibility.length > 0) {
    return { ok: false, problems: legibility.map((p) => `${prefix}${p}`) };
  }

  return { ok: true, palette: palette as AdmittedPalette };
}
