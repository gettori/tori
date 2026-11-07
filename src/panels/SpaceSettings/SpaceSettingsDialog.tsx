import { createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Copy, GitBranch, GitPullRequest, Palette, SlidersHorizontal, X, type LucideIcon } from "lucide-solid";
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
import { copyText } from "../../utils/clipboard";
import { emitWith, onWith, OPEN_SETTINGS, TOAST, type ToastEvent } from "../../utils/events";
import { spaceInitials } from "../../utils/names";
import type { PrChildState } from "../../utils/prChildState";
import { childrenOf, LANE_LABEL, PARENTS } from "../../utils/prLanes";
import { spaceHueRgb } from "../../utils/spaceTint";
import { ProjectSearch, Row, Section } from "../ProjectSettings/Section";
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

type SpaceSection = "general" | "cards" | "lanes" | "branchLine";

const SECTIONS: SpaceSection[] = ["general", "cards", "lanes", "branchLine"];

const SECTION_LABEL: Record<SpaceSection, string> = {
  general: "General",
  cards: "Cards",
  lanes: "PR lanes",
  branchLine: "Branch line",
};

const SECTION_ICON: Record<SpaceSection, LucideIcon> = {
  general: SlidersHorizontal,
  cards: Palette,
  lanes: GitPullRequest,
  branchLine: GitBranch,
};

const CARD_COLOURS: SegmentedOption<CardColours>[] = [
  { value: "subtle", label: "Subtle" },
  { value: "colourful", label: "Colourful" },
];

const tabId = (id: SpaceSection) => `space-tab-${id}`;
const paneId = (id: SpaceSection) => `space-pane-${id}`;

/**
 * Everything that is set per space, laid out as the project settings dialog
 * is: a rail of sections with a search, and the section in hand beside it. A
 * space without settings of its own follows the defaults, which first run sets.
 */
export default function SpaceSettingsDialog(props: {
  /** The settings key: the space's name, or `GLOBAL_KEY` for Home. */
  space: string;
  name: string;
  icon: string | null;
  color: string | null;
  /** The space's folder. Home has none. */
  path?: string;
  projects: number;
  global?: boolean;
  onClose: () => void;
}) {
  let railEl!: HTMLDivElement;
  let searchEl: HTMLInputElement | undefined;

  const [section, setSection] = createSignal<SpaceSection>("general");
  const [query, setQuery] = createSignal("");
  const q = () => query().trim().toLowerCase();
  const searching = () => q() !== "";
  const paneMatches: Partial<Record<SpaceSection, () => boolean>> = {};
  const nothingMatched = () => searching() && SECTIONS.every((id) => !paneMatches[id]?.());
  const openSection = (id: SpaceSection) => {
    setSection(id);
    setQuery("");
  };
  const clearQuery = () => {
    if (query() === "") return false;
    setQuery("");
    return true;
  };
  onMount(() => requestAnimationFrame(() => searchEl?.focus()));
  onCleanup(onWith(OPEN_SETTINGS, () => props.onClose()));

  function onRailKeyDown(e: KeyboardEvent) {
    const n = SECTIONS.length;
    const current = SECTIONS.indexOf(section());
    const next =
      e.key === "ArrowDown" || e.key === "ArrowRight"
        ? (current + 1) % n
        : e.key === "ArrowUp" || e.key === "ArrowLeft"
          ? (current - 1 + n) % n
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : current;
    if (next === current) return;
    e.preventDefault();
    openSection(SECTIONS[next]);
    railEl.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }

  const pane = (id: SpaceSection, body: () => JSX.Element) => {
    let el: HTMLDivElement | undefined;
    const paneHit = () => searching() && SECTION_LABEL[id].toLowerCase().includes(q());
    const matches = () => paneHit() || !!el?.textContent?.toLowerCase().includes(q());
    paneMatches[id] = matches;
    return (
      <>
        <Show when={searching() && matches()}>
          <div class={s.resultCount}>{SECTION_LABEL[id]}</div>
        </Show>
        <div
          ref={el}
          id={paneId(id)}
          data-pane={id}
          role={searching() ? "group" : "tabpanel"}
          aria-label={searching() ? SECTION_LABEL[id] : undefined}
          aria-labelledby={searching() ? undefined : tabId(id)}
          hidden={searching() ? !matches() : section() !== id}
        >
          <ProjectSearch.Provider value={{ query: q, paneHit }}>{body()}</ProjectSearch.Provider>
        </div>
      </>
    );
  };

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

  const copyPath = (path: string) =>
    void copyText(path).then((ok) =>
      emitWith<ToastEvent>(
        TOAST,
        ok ? { message: "Path copied." } : { message: "Could not copy the path.", kind: "error" },
      ),
    );

  return (
    <ModalShell label={`${props.name} settings`} onClose={props.onClose} onEscape={clearQuery}>
      <div class={s.header}>
        <div class={`${s.title} ${own.title}`}>
          <span
            class={`${own.titleIcon} ${styles.titleMark}`}
            style={{ "--space-hue-rgb": spaceHueRgb(props.name, props.color) }}
          >
            <Show when={resolveIcon(props.icon)} fallback={spaceInitials(props.name)}>
              {(glyph) => <Icon icon={glyph()} />}
            </Show>
          </span>
          <span class={`${own.titleName} ${styles.titleName}`} title={props.name}>
            {props.name}
          </span>
          <span class={own.titleKind}>space</span>
        </div>
        <div class={`${s.headerActions} ${styles.headerActions}`}>
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
        <div class={s.railCol}>
          <div class={s.railSearch}>
            <input
              ref={searchEl}
              class={s.searchInput}
              type="search"
              aria-label="Search space settings"
              placeholder="Search space settings"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
          </div>
          <OverlayScroll class={s.railScroll}>
            <div class={s.railGroup}>Space</div>
            <div
              ref={railEl}
              class={s.rail}
              role="tablist"
              aria-orientation="vertical"
              aria-label="Space settings sections"
              onKeyDown={onRailKeyDown}
            >
              <For each={SECTIONS}>
                {(id) => {
                  const selected = () => !searching() && section() === id;
                  return (
                    <button
                      type="button"
                      role="tab"
                      id={tabId(id)}
                      class={s.railItem}
                      classList={{ [s.railItemActive]: selected() }}
                      aria-controls={selected() ? paneId(id) : undefined}
                      aria-selected={selected()}
                      tabindex={section() === id ? 0 : -1}
                      onClick={() => openSection(id)}
                    >
                      <Icon icon={SECTION_ICON[id]} />
                      <span class={s.railLabel}>{SECTION_LABEL[id]}</span>
                    </button>
                  );
                }}
              </For>
            </div>
          </OverlayScroll>
          <div class={s.railFoot}>
            <div class={own.footHead}>
              <span class={s.railFootTitle}>This space</span>
              <Show when={props.path}>
                {(path) => (
                  <IconButton
                    size="xs"
                    icon={<Icon icon={Copy} />}
                    aria-label="Copy path"
                    tooltip="Copy path"
                    onClick={() => copyPath(path())}
                  />
                )}
              </Show>
            </div>
            <div class={s.railFootNote}>
              {props.projects === 1 ? "1 project" : `${props.projects} projects`}
              {props.global ? ". Built in, it can't be renamed or deleted." : "."}
            </div>
            <Show when={props.path}>
              {(path) => (
                <div class={`${s.railFootNote} ${own.footPath}`}>
                  <code>{path()}</code>
                </div>
              )}
            </Show>
            <div class={s.railFootNote}>
              {spaceHasOwn(props.space) ? "Has settings of its own." : "Follows the defaults."}
            </div>
          </div>
        </div>

        <OverlayScroll class={s.pane} contentClass={s.paneInner}>
          <Show when={nothingMatched()}>
            <div class={s.note}>No setting matches "{query().trim()}".</div>
          </Show>
          {pane("general", () => (
            <Section heading="Appearance">
              <Row label="Icon and colour" hint="How the space's tile looks in the strip.">
                <SpaceAppearance name={props.name} value={look()} onChange={setLook} />
              </Row>
            </Section>
          ))}
          {pane("cards", () => (
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
          ))}
          {pane("lanes", () => (
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
          ))}
          {pane("branchLine", () => (
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
          ))}
        </OverlayScroll>
      </div>
    </ModalShell>
  );
}
