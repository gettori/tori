import { For } from "solid-js";
import { Group, Row, rowLabelId, type PaneProps } from "../../components/paneKit";
import { setSidebar, settings, type BranchLineItem, type SpaceStrip } from "../../settingsStore";
import SegmentedControl, { type SegmentedOption } from "../../../../components/SegmentedControl/SegmentedControl";
import { BRANCH_LINE_ITEMS, BRANCH_LINE_MODES } from "../../../../utils/branchLineItems";
import styles from "./SidebarPane.module.css";

const SPACE_TILES: SegmentedOption<SpaceStrip>[] = [
  { value: "bottom", label: "Bottom" },
  { value: "side", label: "Left" },
];

export default function SidebarPane(props: PaneProps) {
  const line = () => settings.sidebar.branchLine;
  const full = () => line().mode === "full";
  const toggle = (id: BranchLineItem) =>
    setSidebar({ branchLine: { ...line(), items: { ...line().items, [id]: !line().items[id] } } });

  return (
    <>
      <Group {...props} title="Layout" ids={["space-strip"]}>
        <Row {...props} id="space-strip" label="Space tiles">
          <SegmentedControl
            size="sm"
            options={SPACE_TILES}
            value={settings.sidebar.spaceTiles}
            onChange={(spaceTiles) => setSidebar({ spaceTiles })}
            aria-label="Space tiles"
          />
        </Row>
      </Group>

      <Group {...props} title="Branch line" ids={["branch-line-mode", "branch-line-items"]}>
        <Row {...props} id="branch-line-mode" label="Branch line">
          <SegmentedControl
            size="sm"
            options={BRANCH_LINE_MODES}
            value={line().mode}
            onChange={(mode) => setSidebar({ branchLine: { ...line(), mode } })}
            aria-label="Branch line"
          />
        </Row>
        <Row {...props} id="branch-line-items" label="Branch line items" stack>
          <div class={styles.chips} role="group" aria-labelledby={rowLabelId("branch-line-items")}>
            <For each={BRANCH_LINE_ITEMS}>
              {(item) => (
                <button
                  type="button"
                  class={styles.chip}
                  classList={{ [styles.on]: line().items[item.id] }}
                  aria-pressed={line().items[item.id]}
                  disabled={!full()}
                  onClick={() => toggle(item.id)}
                >
                  {item.label}
                </button>
              )}
            </For>
          </div>
        </Row>
      </Group>
    </>
  );
}
