import { createEffect, createSignal, on, For, Show } from "solid-js";
import {
  Check,
  ChevronDown,
  ChevronUp,
  ChevronsDownUp,
  Ellipsis,
  FilePlus,
  FolderPlus,
  GitBranch,
  RefreshCw,
} from "lucide-solid";
import Button from "../../../components/Button/Button";
import Icon from "../../../components/Icon/Icon";
import IconButton from "../../../components/IconButton/IconButton";
import MemberTabs from "../../../components/MemberTabs/MemberTabs";
import OverflowTabBar from "../../../components/OverflowTabBar";
import PanelSection from "../../../components/PanelSection/PanelSection";
import Resizer from "../../../components/Resizer/Resizer";
import Tab from "../../../components/Tab/Tab";
import Dropdown from "../../../components/Menu/Dropdown";
import { MenuRow, MenuSeparator } from "../../../components/Menu/rows";
import { type ConfirmOpts } from "../../../components/Dialogs/ConfirmDialog";
import { gitStateFor } from "../../../utils/gitActions";
import { REPAIR_LABEL } from "../../../utils/topics";
import type { TintedMember } from "../../../utils/topicMembers";
import { symbolsSupported } from "../../../utils/symbols";
import {
  FILES_TABS,
  SECTION_MIN_H,
  filesLayout,
  filesTab,
  sectionShown,
  setFilesTab,
  setSectionShown,
  type FilesTab,
} from "../../../utils/filesSections";
import { chromeScale } from "../../Settings/settingsStore";
import FileTree, { type TreeControls } from "../FileTree/FileTree";
import OutlinePanel from "../OutlinePanel";
import TodoPanel from "../TodoPanel";
import type { Selection } from "../../LeftSidebar/LeftSidebar";
import ScriptsSection from "./ScriptsSection";
import tree from "../FileTree/FileTree.module.css";
import styles from "./FilesPanel.module.css";

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1) || p;

/**
 * The Files tab, VS Code Explorer style: the filter and a ... menu on top, then
 * the tree under a header naming the branch, then one section at the bottom
 * showing Scripts, Outline or TODOs, one tab at a time. Inside a Topic the
 * member chips lead the filter row, one tree per member.
 */
export default function FilesPanel(props: {
  /** The folder the workspace points at: the active member inside a Topic. */
  root: string | null;
  /** The bare container above the root, when the project is one. Turns on Share
   *  with other worktrees in a row's menu. */
  container?: string | null;
  /** Empty outside a Topic. */
  members: readonly TintedMember[];
  /** The file on screen, which the tree highlights and walks to. */
  activePath: string | null;
  /** The file the Outline describes, which outlives a chat covering the pane. */
  outlinePath: string | null;
  askText: (title: string, initial?: string) => Promise<string | null>;
  askConfirm: (opts: ConfirmOpts) => Promise<boolean>;
  onRepair: (key: string) => void;
  onActiveRoot?: (root: string) => void;
  /** Where the TODOs section's Send goes. */
  selected: Selection | null;
  settleKey: string;
  persistKey: string;
}) {
  const [filter, setFilter] = createSignal("");
  const [wantFiles, setWantFiles] = createSignal(false);
  const [controls, setControls] = createSignal<TreeControls | null>(null);
  // The member chip picked by hand. Kept apart from `root` because a member
  // with nothing on disk can be looked at (for its repair) but not pointed at.
  const [picked, setPicked] = createSignal<string | null>(null);

  const multiMember = () => props.members.length > 1;
  const memberOf = (key: string | null) => props.members.find((m) => m.key === key);
  const viewed = (): TintedMember | undefined =>
    memberOf(picked()) ?? props.members.find((m) => !!m.root && m.root === props.root);
  const treeRoot = () => {
    const m = viewed();
    if (!m) return props.root;
    return m.state.usable ? m.key : null;
  };
  const repoPath = () => viewed()?.member.repoPath ?? props.root ?? undefined;

  // Pointing the workspace at another member from anywhere else wins over the
  // chip picked here, and a new root is a new file list for the filter.
  createEffect(
    on(
      () => props.root,
      () => setPicked(null),
      { defer: true },
    ),
  );
  createEffect(
    on(treeRoot, () => {
      setFilter("");
      setWantFiles(false);
    }),
  );

  function pick(key: string) {
    setPicked(key);
    const m = memberOf(key);
    if (m?.root) props.onActiveRoot?.(m.root);
  }

  const branchTitle = () => {
    const r = treeRoot();
    if (!r) return "";
    return gitStateFor(r).branch ?? basename(r);
  };

  const hasOutline = () => symbolsSupported(props.outlinePath);

  let stackEl: HTMLDivElement | undefined;
  // Room for the tree's header plus a few rows, whatever is dragged.
  const maxH = () => (stackEl?.clientHeight ?? 0) - 120 * chromeScale();
  const viewsOpen = () => filesLayout.open("views");
  const viewsHeight = () => filesLayout.size("views") * chromeScale();

  /** Picking a tab out of the `+N` menu reorders the strip. The order keeps
   *  the tabs the ... menu hid, so they come back where they were. */
  const [tabOrder, setTabOrder] = createSignal(FILES_TABS);
  const shownTabs = () => tabOrder().filter((t) => sectionShown(t.id));
  /** The picked tab, or the first left once the ... menu has hidden it. */
  const tab = (): FilesTab | undefined =>
    shownTabs().some((t) => t.id === filesTab()) ? filesTab() : shownTabs()[0]?.id;

  /** A tab always opens the section: only the chevron closes it, so a click
   *  on the tab you are on is never a surprise collapse. */
  function showTab(id: FilesTab) {
    setFilesTab(id);
    filesLayout.setOpen("views", true);
  }

  const menu = () => (
    <>
      <MenuRow disabled>
        <span class={styles.checkSlot}>
          <Icon icon={Check} />
        </span>
        Folders
      </MenuRow>
      <For each={FILES_TABS}>
        {(s) => (
          <MenuRow onClick={() => setSectionShown(s.id, !sectionShown(s.id))}>
            <span class={styles.checkSlot}>
              <Show when={sectionShown(s.id)}>
                <Icon icon={Check} />
              </Show>
            </span>
            {s.label}
          </MenuRow>
        )}
      </For>
      <MenuSeparator />
      <MenuRow disabled={!controls()?.canReveal()} onClick={() => controls()?.reveal()}>
        <span class={styles.checkSlot} />
        Reveal Active File
      </MenuRow>
    </>
  );

  return (
    <div class={styles.filesPanel}>
      <Show when={multiMember()}>
        <MemberTabs members={props.members} activeKey={viewed()?.key ?? null} onPick={(m) => pick(m.key)} />
      </Show>
      <div class={styles.topBar}>
        <input
          class={tree.filterBox}
          type="text"
          placeholder="Filter files"
          aria-label="Filter files"
          value={filter()}
          disabled={!treeRoot()}
          onFocus={() => setWantFiles(true)}
          onInput={(e) => {
            setWantFiles(true);
            setFilter(e.currentTarget.value);
          }}
        />
        <Dropdown as="span" wrapper menu={menu()} placement="bottom-end">
          <IconButton size="sm" tooltip="Views and More Actions" icon={<Icon icon={Ellipsis} />} />
        </Dropdown>
      </div>
      <div class={styles.stack} ref={stackEl}>
        <PanelSection
          layout={filesLayout}
          id="folders"
          collapsible={false}
          fill
          maxH={maxH}
          title={
            <>
              <Show when={treeRoot() && gitStateFor(treeRoot()).branch}>
                <Icon icon={GitBranch} />
              </Show>
              <span class={styles.titleText}>{branchTitle() || viewed()?.label}</span>
            </>
          }
          actions={
            <Show when={treeRoot()}>
              <Show when={controls()?.editable()}>
                <IconButton
                  size="sm"
                  icon={<Icon icon={FilePlus} />}
                  tooltip="New File"
                  onClick={() => controls()?.newFile()}
                />
                <IconButton
                  size="sm"
                  icon={<Icon icon={FolderPlus} />}
                  tooltip="New Folder"
                  onClick={() => controls()?.newFolder()}
                />
              </Show>
              <IconButton
                size="sm"
                icon={<Icon icon={RefreshCw} />}
                tooltip="Refresh"
                onClick={() => controls()?.refresh()}
              />
              <IconButton
                size="sm"
                icon={<Icon icon={ChevronsDownUp} />}
                tooltip="Collapse Folders"
                onClick={() => controls()?.collapse()}
              />
            </Show>
          }
        >
          <Show
            when={treeRoot()}
            fallback={
              <Show when={viewed()}>
                {(m) => (
                  <div class={styles.unusable}>
                    <span>{m().state.reason ? `${m().state.label}: ${m().state.reason}` : m().state.label}</span>
                    <Show when={m().state.action}>
                      {(action) => (
                        <Button size="xs" variant="ghost" data-repair={m().key} onClick={() => props.onRepair(m().key)}>
                          {REPAIR_LABEL[action()]}
                        </Button>
                      )}
                    </Show>
                  </div>
                )}
              </Show>
            }
          >
            <FileTree
              root={treeRoot()}
              editable
              noun={multiMember() ? "member folder" : "project folder"}
              member={multiMember() ? viewed()?.label : undefined}
              repoPath={repoPath()}
              container={props.container ?? undefined}
              activePath={props.activePath}
              askText={props.askText}
              askConfirm={props.askConfirm}
              settleKey={props.settleKey}
              persistKey={props.persistKey}
              filter={filter}
              wantFiles={wantFiles}
              onControls={setControls}
            />
          </Show>
        </PanelSection>

        {/* Scripts, Outline or TODOs, one tab at a time. The strip is the
            section's header; collapsed, it is all that is left of the section,
            pinned under the tree. */}
        <Show when={shownTabs().length}>
          <section
            class={styles.views}
            classList={{ [styles.viewsOpen]: viewsOpen() }}
            style={viewsOpen() ? { flex: `0 1 ${viewsHeight()}px` } : undefined}
            data-section="views"
          >
            <Show when={viewsOpen()}>
              <div class={styles.sash}>
                <Resizer
                  axis="y"
                  side="after"
                  value={viewsHeight()}
                  min={SECTION_MIN_H * chromeScale()}
                  max={Math.max(SECTION_MIN_H * chromeScale(), maxH())}
                  onInput={(h) => filesLayout.setSize("views", h / chromeScale())}
                  onCommit={filesLayout.saveSizes}
                />
              </div>
            </Show>
            <OverflowTabBar
              class={styles.tabStrip}
              items={shownTabs()}
              activeId={tab() ?? null}
              idOf={(t) => t.id}
              onActivate={(id) => showTab(id as FilesTab)}
              onReorder={(next) => setTabOrder([...next, ...tabOrder().filter((t) => !next.includes(t))])}
              renderTab={(t) => (
                <Tab quiet value={t.id} id={`files-tab-${t.id}`}>
                  {t.label}
                </Tab>
              )}
              renderMenuItem={(t) => <span class="tab-name">{t.label}</span>}
              trailing={
                <IconButton
                  size="sm"
                  icon={<Icon icon={viewsOpen() ? ChevronDown : ChevronUp} />}
                  aria-expanded={viewsOpen()}
                  tooltip={viewsOpen() ? "Collapse" : "Expand"}
                  onClick={() => filesLayout.setOpen("views", !viewsOpen())}
                />
              }
            />
            {/* Only the showing tab is mounted: TODOs greps the tree, and a
                hidden tab is no reason to keep that running. */}
            <Show when={viewsOpen() && tab()}>
              {(id) => (
                <div
                  id={`files-panel-${id()}`}
                  role="tabpanel"
                  aria-labelledby={`files-tab-${id()}`}
                  class={styles.tabPanel}
                >
                  <Show when={id() === "scripts"}>
                    <ScriptsSection root={treeRoot()} />
                  </Show>
                  <Show when={id() === "outline"}>
                    <Show
                      when={hasOutline()}
                      fallback={
                        <div class={tree.empty}>
                          {props.outlinePath ? "No outline for this file." : "Open a file to see its outline."}
                        </div>
                      }
                    >
                      <OutlinePanel path={props.outlinePath} />
                    </Show>
                  </Show>
                  <Show when={id() === "todos"}>
                    <TodoPanel root={treeRoot()} selected={props.selected} />
                  </Show>
                </div>
              )}
            </Show>
          </section>
        </Show>
      </div>
    </div>
  );
}
