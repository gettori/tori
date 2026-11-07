import { createSignal, For } from "solid-js";
import { Group, Row, rowLabelId, type PaneProps } from "../../components/paneKit";
import {
  lanesFor,
  resetLanes,
  setLanes,
  setSidebar,
  settings,
  type BranchLineItem,
  type SpaceStrip,
} from "../../settingsStore";
import SegmentedControl, { type SegmentedOption } from "../../../../components/SegmentedControl/SegmentedControl";
import Select from "../../../../components/Select/Select";
import Switch from "../../../../components/Switch/Switch";
import Button from "../../../../components/Button/Button";
import { createSpaces } from "../../../../utils/topicMembers";
import { GLOBAL_KEY, GLOBAL_NAME } from "../../../../utils/globalSpace";
import { LANE_LABEL, PARENTS, childrenOf } from "../../../../utils/prLanes";
import type { PrChildState } from "../../../../utils/prChildState";
import { BRANCH_LINE_ITEMS, BRANCH_LINE_MODES } from "../../../../utils/branchLineItems";
import styles from "./SidebarPane.module.css";

const SPACE_TILES: SegmentedOption<SpaceStrip>[] = [
  { value: "bottom", label: "Bottom" },
  { value: "side", label: "Left" },
];

const DEFAULT_SCOPE = "";

export default function SidebarPane(props: PaneProps) {
  const spaces = createSpaces();
  const [scope, setScope] = createSignal(DEFAULT_SCOPE);
  const space = () => (scope() === DEFAULT_SCOPE ? null : scope());
  const scopes = () => [
    { value: DEFAULT_SCOPE, label: "Default" },
    { value: GLOBAL_KEY, label: GLOBAL_NAME },
    ...(spaces() ?? []).filter((s) => s.name !== GLOBAL_KEY).map((s) => ({ value: s.name, label: s.name })),
  ];
  const lanes = () => (space() === null ? settings.sidebar.lanes.default : lanesFor(space()!));
  const own = () => space() === null || settings.sidebar.lanes.spaces[space()!] !== undefined;
  const flip = (child: PrChildState) =>
    void setLanes(space(), {
      lit: lanes().lit.includes(child) ? lanes().lit.filter((c) => c !== child) : [...lanes().lit, child],
    });
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

      <Group
        {...props}
        title="PR lanes"
        ids={["lanes-for", "pr-lanes", "lane-split", "lanes-fold"]}
        action={
          <Button size="sm" disabled={!own()} onClick={() => void resetLanes(space())}>
            Reset to default
          </Button>
        }
      >
        <Row
          {...props}
          id="lanes-for"
          label="Lanes for"
          hint={own() ? undefined : "This Space follows Default until you change something here."}
        >
          <Select
            size="sm"
            options={scopes()}
            value={scope()}
            onChange={setScope}
            aria-labelledby={rowLabelId("lanes-for")}
          />
        </Row>
        <Row {...props} id="pr-lanes" label="PR lanes">
          <Switch
            checked={lanes().enabled}
            onChange={(enabled) => void setLanes(space(), { enabled })}
            aria-label="PR lanes"
          />
        </Row>
        <Row {...props} id="lane-split" label="Own lanes" stack>
          <div class={styles.laneChips} role="group" aria-labelledby={rowLabelId("lane-split")}>
            <For each={PARENTS}>
              {(parent) => (
                <>
                  <span class={styles.laneParent}>{LANE_LABEL[parent]}</span>
                  <div class={styles.chips}>
                    <For each={childrenOf(parent)}>
                      {(child) => (
                        <button
                          type="button"
                          class={styles.chip}
                          classList={{ [styles.on]: lanes().lit.includes(child) }}
                          aria-pressed={lanes().lit.includes(child)}
                          disabled={!lanes().enabled}
                          onClick={() => flip(child)}
                        >
                          {LANE_LABEL[child]}
                        </button>
                      )}
                    </For>
                  </div>
                </>
              )}
            </For>
          </div>
        </Row>
        <Row {...props} id="lanes-fold" label="Fold into In review">
          <Switch
            checked={lanes().foldReviewing}
            disabled={!lanes().enabled}
            onChange={(foldReviewing) => void setLanes(space(), { foldReviewing })}
            aria-label="Fold into In review"
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
