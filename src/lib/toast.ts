import { CloseButton, List, Region, Root, Title, toaster } from "@kobalte/core/toast";

/**
 * Kobalte's toast, and the only door it comes through.
 *
 * The same seam `dialog.ts` documents: `src/lib/` is the whole of Sway's
 * contact surface with `@kobalte/core`, `boundary.test.ts` fails the suite if
 * anything outside this folder names the package, and the styled wrapper in
 * `src/components/Toasts/` is what the app composes.
 *
 * **One namespace object per primitive**, per the convention #94 settled: the
 * app writes `Toast.Root`, never a bare `Root`. Kobalte names `Root` and
 * `Title` identically here and in the dialog, so bare re-exports would collide
 * the moment one wrapper composed both.
 *
 * Unlike the other primitives, this one is imperative: `toaster.show()` is the
 * whole write API, feeding whatever `Region` is mounted, so the function rides
 * in the namespace alongside the parts. The list is an allow-list of what a
 * toast is actually built from. Absent deliberately rather than by oversight:
 * `Description` (a toast here is one line of text, which `Title` already
 * labels), `ProgressFill`/`ProgressTrack` (no visual countdown), the swipe
 * handlers (swipe-to-dismiss is out of scope, see #105), and
 * `useToastContext` (`CloseButton` already composes the close for both the
 * dismiss control and the action button, so nothing needs the raw context).
 */
export const Toast = {
  Region,
  List,
  Root,
  Title,
  CloseButton,
  toaster,
};
