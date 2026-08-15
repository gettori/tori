import {
  Content as DropdownContent,
  Item as DropdownItem,
  Portal as DropdownPortal,
  Root as DropdownRoot,
  Separator as DropdownSeparator,
  Sub as DropdownSub,
  SubContent as DropdownSubContent,
  SubTrigger as DropdownSubTrigger,
  Trigger as DropdownTrigger,
} from "@kobalte/core/dropdown-menu";
import {
  Content as ContextContent,
  Item as ContextItem,
  Portal as ContextPortal,
  Root as ContextRoot,
  Separator as ContextSeparator,
  Sub as ContextSub,
  SubContent as ContextSubContent,
  SubTrigger as ContextSubTrigger,
  Trigger as ContextTrigger,
} from "@kobalte/core/context-menu";

/**
 * Kobalte's two menus, and the only door they come through.
 *
 * The same seam `dialog.ts` documents: `src/lib/` is the whole of Sway's
 * contact surface with `@kobalte/core`, `boundary.test.ts` fails the suite if
 * anything outside this folder names the package, and the styled wrappers in
 * `src/components/Menu/` are what the app composes.
 *
 * **Two primitives, not one.** Kobalte builds both on the same `Menu` internals,
 * which is why the part lists below are identical, but their roots are not
 * interchangeable: `ContextMenuRootOptions` is
 * `Omit<MenuRootOptions, "open" | "defaultOpen" | "getAnchorRect">`, so a
 * context menu is strictly uncontrolled and places itself at the cursor through
 * its own trigger. `DropdownMenu.Root` accepts both, which is what makes the
 * virtual-anchor case (a menu with no trigger element, e.g. CodeEditor's caret
 * menu) possible at all. Sway's two wrappers exist because of that asymmetry,
 * not because the chrome differs - the chrome is shared.
 *
 * Every name here collides with its opposite number, so each import is aliased
 * on the way in: this is exactly the collision the "one namespace object per
 * primitive" convention from #94 exists to keep out of the app, and this file
 * is the first place two primitives are re-exported side by side.
 *
 * The lists are allow-lists of the parts Sway's menus are actually built from.
 * Absent deliberately rather than by oversight: `CheckboxItem`, `RadioItem`,
 * `RadioGroup`, `GroupLabel`, `Group`, `Icon`, `ItemIndicator`, `ItemLabel`,
 * `ItemDescription` and `Arrow`. Nothing composes them yet, and a re-export
 * nothing composes reads as a supported part of the surface.
 */
export const DropdownMenu = {
  Root: DropdownRoot,
  Trigger: DropdownTrigger,
  Portal: DropdownPortal,
  Content: DropdownContent,
  Item: DropdownItem,
  Separator: DropdownSeparator,
  Sub: DropdownSub,
  SubTrigger: DropdownSubTrigger,
  SubContent: DropdownSubContent,
};

export const ContextMenu = {
  Root: ContextRoot,
  Trigger: ContextTrigger,
  Portal: ContextPortal,
  Content: ContextContent,
  Item: ContextItem,
  Separator: ContextSeparator,
  Sub: ContextSub,
  SubTrigger: ContextSubTrigger,
  SubContent: ContextSubContent,
};
