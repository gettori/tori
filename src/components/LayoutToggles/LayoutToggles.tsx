import { PanelLeft } from "lucide-solid";
import { ToggleGroup } from "../../lib/toggle-group";
import Icon from "../Icon/Icon";
import IconButton from "../IconButton/IconButton";
import { emit, TOGGLE_SIDEBAR } from "../../utils/events";
import styles from "./LayoutToggles.module.css";

// The topbar's sidebar show/hide toggle: one Kobalte toggle group in `multiple`
// mode, so the item is an independent toggle rather than a selection. The
// "shown" state is the plain IconButton look and the "hidden" state accents the
// glyph as a "click to bring it back" cue, driven off Kobalte's `data-pressed`
// in CSS rather than a passed class, which is the clobber the shared-component
// migration kept hitting.
//
// The terminal and editor toggles used to sit beside it. They went in phase 13:
// with one pane holding every kind there is nothing for them to hide, and
// Cmd+Alt+J/E now bring a kind's tab to the front instead. The file-tree toggle
// lives in the editor's own trailing cluster.
//
// The item renders *as* an `IconButton`, so the group's own props (pressed
// state, roving tabindex, the click that toggles) land on the same button the
// tooltip triggers from. Wrapping instead would break both: Kobalte's tooltip
// behaviour lives on the trigger element itself, and its collection needs the
// focusable control, not a container around it.
export default function LayoutToggles(props: { showSidebar: boolean }) {
  const shown = () => (props.showSidebar ? ["sidebar"] : []);

  return (
    <ToggleGroup.Root multiple value={shown()} onChange={() => emit(TOGGLE_SIDEBAR)} class={styles.cluster}>
      <ToggleGroup.Item
        as={IconButton}
        value="sidebar"
        size="md"
        class={styles.item}
        icon={<Icon icon={PanelLeft} />}
        tooltip="Show or hide the sidebar (⌘B)"
      />
    </ToggleGroup.Root>
  );
}
