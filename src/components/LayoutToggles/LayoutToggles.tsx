import { PanelLeft, SquareTerminal, Code2 } from "lucide-solid";
import { ToggleGroup } from "../../lib/toggle-group";
import Icon from "../Icon/Icon";
import IconButton from "../IconButton/IconButton";
import { emit, TOGGLE_SIDEBAR, TOGGLE_TERMINAL, TOGGLE_EDITOR } from "../../utils/events";
import styles from "./LayoutToggles.module.css";

type Pane = "sidebar" | "terminal" | "editor";

/** Which event asks the app to flip a pane. The group reports the whole new set
 *  rather than what was pressed, so the changed pane has to be looked up. */
const TOGGLE: Record<Pane, string> = {
  sidebar: TOGGLE_SIDEBAR,
  terminal: TOGGLE_TERMINAL,
  editor: TOGGLE_EDITOR,
};

const PANES = Object.keys(TOGGLE) as Pane[];

// Topbar pane show/hide toggles: one Kobalte toggle group in `multiple` mode,
// each pane an independent toggle (they are not single-select, so this is a
// cluster rather than a SegmentedControl - the two share the primitive, not the
// component). The "shown" state is the plain IconButton look and the "hidden"
// state accents the glyph as a "click to bring it back" cue, now driven off
// Kobalte's `data-pressed` in CSS rather than a passed class, which is the
// clobber the shared-component migration kept hitting. Terminal and editor are
// guarded by a ">=1 visible" invariant, so the last one showing is disabled and
// can't hide the pair. The file-tree toggle lives in the editor tab bar instead,
// since it is nested inside the editor.
//
// Each item renders *as* an `IconButton`, so the group's own props (pressed
// state, roving tabindex, the click that toggles) land on the same button the
// tooltip triggers from. Wrapping instead would break both: Kobalte's tooltip
// behaviour lives on the trigger element itself, and its collection needs the
// focusable control, not a container around it.
//
// The three items are written out rather than mapped: a `<For>` over an array
// rebuilt from props hands Solid new identities on every toggle, which tears
// down all three buttons and takes the keyboard focus with them.
export default function LayoutToggles(props: {
  showSidebar: boolean;
  showTerminal: boolean;
  showEditor: boolean;
}) {
  const termLast = () => props.showTerminal && !props.showEditor;
  const editorLast = () => props.showEditor && !props.showTerminal;

  const shown = () => {
    const on: Pane[] = [];
    if (props.showSidebar) on.push("sidebar");
    if (props.showTerminal) on.push("terminal");
    if (props.showEditor) on.push("editor");
    return on;
  };

  // Exactly one pane can change per press, and each owns an event rather than a
  // value, so the one whose membership flipped is what gets emitted. The new
  // state arrives back through props.
  const onChange = (next: string[]) => {
    const before = shown();
    const changed = PANES.find((p) => before.includes(p) !== next.includes(p));
    if (changed) emit(TOGGLE[changed]);
  };

  return (
    <ToggleGroup.Root multiple value={shown()} onChange={onChange} class={styles.cluster}>
      <ToggleGroup.Item
        as={IconButton}
        value="sidebar"
        size="sm"
        class={styles.item}
        icon={<Icon icon={PanelLeft} />}
        tooltip="Show or hide the sidebar (⌘B)"
      />
      <ToggleGroup.Item
        as={IconButton}
        value="terminal"
        size="sm"
        class={styles.item}
        icon={<Icon icon={SquareTerminal} />}
        disabled={termLast()}
        tooltipWhenDisabled
        tooltip={termLast() ? "Can't hide the terminal while the editor is hidden" : "Show or hide the terminal (⌘⌥J)"}
      />
      <ToggleGroup.Item
        as={IconButton}
        value="editor"
        size="sm"
        class={styles.item}
        icon={<Icon icon={Code2} />}
        disabled={editorLast()}
        tooltipWhenDisabled
        tooltip={editorLast() ? "Can't hide the editor while the terminal is hidden" : "Show or hide the editor (⌘⌥E)"}
      />
    </ToggleGroup.Root>
  );
}
