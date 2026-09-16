import {
  Content,
  Icon,
  Item,
  ItemIndicator,
  ItemLabel,
  Listbox,
  Portal,
  Root,
  Section,
  Trigger,
  Value,
} from "@kobalte/core/select";

/**
 * Kobalte's select, and the only door it comes through.
 *
 * The same seam `dialog.ts` documents: `src/lib/` is the whole of Tori's
 * contact surface with `@kobalte/core`, `boundary.test.ts` fails the suite if
 * anything outside this folder names the package, and the styled wrapper in
 * `src/components/Select/` is what the app composes.
 *
 * **One namespace object per primitive**, per the convention #94 settled: the
 * app writes `Select.Root`, never a bare `Root`. Kobalte names `Root`,
 * `Content` and `Portal` identically here and in four other primitives, so
 * this file would collide the moment one wrapper composed two of them.
 *
 * The list is an allow-list of the parts a Tori select is actually built from.
 * Absent deliberately rather than by oversight: `Label`/`Description`/
 * `ErrorMessage` (labeling is the call site's, wired through `aria-label` or
 * `aria-labelledby` on the trigger; nothing renders help text inside the
 * control), `HiddenSelect` (no Tori select posts an HTML form or wants browser
 * autofill), `ItemDescription` (rows are a label and a check, nothing more),
 * and `Arrow`, which nothing composes.
 */
export const Select = {
  Root,
  Trigger,
  Value,
  Icon,
  Portal,
  Content,
  Listbox,
  Section,
  Item,
  ItemLabel,
  ItemIndicator,
};
