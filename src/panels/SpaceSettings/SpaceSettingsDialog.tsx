import { For, Show } from "solid-js";
import { X } from "lucide-solid";
import { invoke } from "@tauri-apps/api/core";

import Button from "../../components/Button/Button";
import SpaceAppearance, { type Appearance } from "../../components/Dialogs/SpaceAppearance";
import Icon from "../../components/Icon/Icon";
import { resolveIcon } from "../../components/Icon/iconRegistry";
import IconButton from "../../components/IconButton/IconButton";
import OverlayScroll from "../../components/Scrollbar/OverlayScroll";
import SegmentedControl, { type SegmentedOption } from "../../components/SegmentedControl/SegmentedControl";
import Switch from "../../components/Switch/Switch";
import { BRANCH_LINE_ITEMS, BRANCH_LINE_MODES } from "../../utils/branchLineItems";
import { emitWith, TOAST, type ToastEvent } from "../../utils/events";
import { spaceInitials } from "../../utils/names";
import type { PrChildState } from "../../utils/prChildState";
import { childrenOf, LANE_LABEL, PARENTS } from "../../utils/prLanes";
import { spaceHueRgb } from "../../utils/spaceTint";
import { Row, Section } from "../ProjectSettings/Section";
import own from "../ProjectSettings/ProjectSettingsDialog.module.css";
import ModalShell from "../Settings/components/ModalShell";
import s from "../Settings/Settings.module.css";
import {
  branchLineFor,
  cardColoursFor,
  laneConfigFor,
  resetSpace,
  setLanes,
  setSpaceView,
  spaceHasOwn,
  type BranchLineItem,
  type CardColours,
} from "../Settings/settingsStore";
import styles from "./SpaceSettingsDialog.module.css";

const CARD_COLOURS: SegmentedOption<CardColours>[] = [
  { value: "subtle", label: "Subtle" },
  { value: "colourful", label: "Colourful" },
];

/**
 * Everything that is set per space: how it looks in the strip, and how its
 * projects lay out in the sidebar. A space without settings of its own follows
 * the defaults, which first run sets.
 */
export default function SpaceSettingsDialog(props: {
  /** The settings key: the space's name, or `GLOBAL_KEY` for Home. */
  space: string;
  name: string;
  icon: string | null;
  color: string | null;
  global?: boolean;
  onClose: () => void;
}) {
  const lanes = laneConfigFor(() => props.space);
  const line = () => branchLineFor(props.space);
  const full = () => line().mode === "full";
  const flip = (child: PrChildState) =>
    void setLanes(props.space, {
      lit: lanes().lit.includes(child) ? lanes().lit.filter((c) => c !== child) : [...lanes().lit, child],
    });
  const toggleItem = (id: BranchLineItem) =>
    void setSpaceView(props.space, {
      branchLine: { ...line(), items: { ...line().items, [id]: !line().items[id] } },
    });

  const look = (): Appearance => ({ icon: props.icon, color: props.color });
  const setLook = (next: Appearance) =>
    void (
      props.global
        ? invoke("set_global_meta", { icon: next.icon, color: next.color })
        : invoke("set_space_meta", { name: props.space, icon: next.icon, color: next.color })
    ).catch((e: unknown) => emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" }));

  return (
    <ModalShell label={`${props.name} settings`} onClose={props.onClose}>
      <div class={s.header}>
        <div class={`${s.title} ${own.title}`} style={{ "--space-hue-rgb": spaceHueRgb(props.name, props.color) }}>
          <span class={`${own.titleIcon} ${styles.titleMark}`}>
            <Show when={resolveIcon(props.icon)} fallback={spaceInitials(props.name)}>
              {(glyph) => <Icon icon={glyph()} />}
            </Show>
          </span>
          <span class={own.titleName} title={props.name}>
            {props.name}
          </span>
        </div>
        <div class={s.headerActions}>
          <Show when={spaceHasOwn(props.space)}>
            <Button size="sm" onClick={() => void resetSpace(props.space)}>
              Reset to defaults
            </Button>
          </Show>
          <IconButton
            icon={<Icon icon={X} />}
            size="sm"
            aria-label="Close"
            tooltip="Close"
            onClick={() => props.onClose()}
          />
        </div>
      </div>

      <div class={s.body}>
        <OverlayScroll class={s.pane} contentClass={s.paneInner}>
          <Section heading="General">
            <Row
              label="Icon and colour"
              hint={props.global ? "Home is built in. It can't be renamed or deleted." : undefined}
            >
              <SpaceAppearance name={props.name} value={look()} onChange={setLook} />
            </Row>
          </Section>

          <Section heading="Cards">
            <Row
              label="Card colours"
              hint="Subtle keeps every lane and group card neutral. Colourful tints each lane by its state and lets each group pick a colour."
            >
              <SegmentedControl
                size="sm"
                options={CARD_COLOURS}
                value={cardColoursFor(props.space)}
                onChange={(cardColours) => void setSpaceView(props.space, { cardColours })}
                aria-label="Card colours"
              />
            </Row>
          </Section>

          <Section heading="PR lanes">
            <Row
              label="PR lanes"
              hint="Sort each project's branches into Working, In review, Reviewing and Done by pull request state. Groups stay above the lanes."
            >
              <Switch
                checked={lanes().enabled}
                onChange={(enabled) => void setLanes(props.space, { enabled })}
                aria-label="PR lanes"
              />
            </Row>
            <Row
              label="Own lanes"
              hint="A lit state gets a lane of its own, directly above the lane it comes from."
              stack
            >
              <div class={styles.laneChips} role="group" aria-label="Own lanes">
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
            <Row label="Fold into In review" hint="Show the pull requests you review in In review, beside your own.">
              <Switch
                checked={lanes().foldReviewing}
                disabled={!lanes().enabled}
                onChange={(foldReviewing) => void setLanes(props.space, { foldReviewing })}
                aria-label="Fold into In review"
              />
            </Row>
          </Section>

          <Section heading="Branch line">
            <Row
              label="Branch line"
              hint="The second line under a branch name: nothing, the pull request alone, or every fact lit below. A running rebase or merge always shows."
            >
              <SegmentedControl
                size="sm"
                options={BRANCH_LINE_MODES}
                value={line().mode}
                onChange={(mode) => void setSpaceView(props.space, { branchLine: { ...line(), mode } })}
                aria-label="Branch line"
              />
            </Row>
            <Row
              label="Branch line items"
              hint="What Full shows. The row's tooltip lists everything, whatever is hidden."
              stack
            >
              <div class={styles.chips} role="group" aria-label="Branch line items">
                <For each={BRANCH_LINE_ITEMS}>
                  {(item) => (
                    <button
                      type="button"
                      class={styles.chip}
                      classList={{ [styles.on]: line().items[item.id] }}
                      aria-pressed={line().items[item.id]}
                      disabled={!full()}
                      onClick={() => toggleItem(item.id)}
                    >
                      {item.label}
                    </button>
                  )}
                </For>
              </div>
            </Row>
          </Section>
        </OverlayScroll>
      </div>
    </ModalShell>
  );
}
