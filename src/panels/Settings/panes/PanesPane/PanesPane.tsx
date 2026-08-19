import { Group, Row, idsIn, rowLabelId, setPanePins, type PaneProps } from "../../components/paneKit";
import { settings } from "../../settingsStore";
import type { PinSide } from "../../../../layout/pinRules";
import Select, { type SelectOption } from "../../../../components/Select/Select";
import styles from "../../Settings.module.css";

/** A pane has no name to pin to, so the rule names an end of the split: the
 *  answer stays true after a split, a close or a move, which "pane 2" would
 *  not. Left and right rather than leftmost and rightmost, because with one
 *  pane on screen the superlative reads as a third option. */
const SIDES: SelectOption[] = [
  { value: "leftmost", label: "The leftmost pane" },
  { value: "rightmost", label: "The rightmost pane" },
];

/**
 * Where each family of tabs opens.
 *
 * Three rows rather than one per kind: the five terminal kinds are one family
 * to a user (they are all "a terminal tab"), and a rule per registered kind
 * would mean a new setting every time a panel registers one.
 *
 * The rules route what opens **next**. Everything already on screen carries the
 * pane it is in, so changing a rule never moves a tab out from under anyone,
 * and a pane locked to a kind from its own tab menu outranks the rule anyway.
 */
export default function PanesPane(props: PaneProps) {
  const row = (id: string, label: string, key: "terminal" | "chat" | "file") => (
    <Row {...props} id={id} label={label}>
      <div class={styles.control}>
        <Select
          options={SIDES}
          value={settings.panePins[key]}
          onChange={(value) => setPanePins({ [key]: value as PinSide })}
          aria-labelledby={rowLabelId(id)}
        />
      </div>
    </Row>
  );
  return (
    <Group {...props} title="Where tabs open" ids={idsIn("panes")}>
      {row("pin-terminal", "Terminals open in", "terminal")}
      {row("pin-chat", "Chats open in", "chat")}
      {row("pin-file", "Files open in", "file")}
    </Group>
  );
}
