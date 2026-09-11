import { createEffect, createSignal, on, For, Show, type JSX } from "solid-js";
import { Check, ChevronsDownUp, Ellipsis, FilePlus, FolderPlus, GitBranch, RefreshCw } from "lucide-solid";
import Button from "../../../components/Button/Button";
import Chevron from "../../../components/Chevron/Chevron";
import Icon from "../../../components/Icon/Icon";
import IconButton from "../../../components/IconButton/IconButton";
import MemberChipRow from "../../../components/MemberChipRow/MemberChipRow";
import Resizer from "../../../components/Resizer/Resizer";
import Dropdown from "../../../components/Menu/Dropdown";
import { MenuRow, MenuSeparator } from "../../../components/Menu/rows";
import { type ConfirmOpts } from "../../../components/Dialogs/ConfirmDialog";
import { gitStateFor } from "../../../utils/gitActions";
import { REPAIR_LABEL } from "../../../utils/features";
import type { TintedMember } from "../../../utils/featureMembers";
import { symbolsSupported } from "../../../utils/symbols";
import {
  OPTIONAL_SECTIONS,
  SECTION_MIN_H,
  saveSectionSizes,
  sectionOpen,
  sectionShown,
  sectionSize,
  setSectionOpen,
  setSectionShown,
  setSectionSize,
  type FilesSection,
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

const ORDER: FilesSection[] = ["folders", "scripts", "outline", "todos"];

/** One stacked section: a header that opens and closes it, then its body. Like
 *  VS Code, one open section fills what is left and the rest keep a height of
 *  their own, dragged from their top edge. */
function Section(props: {
  id: FilesSection;
  /** The open section that takes the leftover height. */
  fill: boolean;
  /** The tallest this section may be dragged to, in px. */
  maxH: () => number;
  title: JSX.Element;
  /** Buttons at the header's right, drawn only while the section is open. */
  actions?: JSX.Element;
  children: JSX.Element;
}) {
  const open = () => sectionOpen(props.id);
  const fixed = () => open() && !props.fill;
  const height = () => sectionSize(props.id) * chromeScale();
  return (
    <section
      class={styles.section}
      classList={{ [styles.fill]: open() && props.fill }}
      style={fixed() ? { flex: `0 1 ${height()}px` } : undefined}
      data-section={props.id}
    >
      <Show when={fixed()}>
        <div class={styles.sash}>
          <Resizer
            axis="y"
            side="after"
            value={height()}
            min={SECTION_MIN_H * chromeScale()}
            max={Math.max(SECTION_MIN_H * chromeScale(), props.maxH())}
            onInput={(h) => setSectionSize(props.id, h / chromeScale())}
            onCommit={saveSectionSizes}
          />
        </div>
      </Show>
      <div class={styles.sectionHeader}>
        <button
          type="button"
          class={styles.sectionToggle}
          aria-expanded={open()}
          onClick={() => setSectionOpen(props.id, !open())}
        >
          <Chevron open={open()} />
          <span class={styles.sectionTitle}>{props.title}</span>
        </button>
        <Show when={open()}>{props.actions}</Show>
      </div>
      <Show when={open()}>
        <div class={styles.sectionBody}>{props.children}</div>
      </Show>
    </section>
  );
}

/**
 * The Files tab, VS Code Explorer style: the filter and a ... menu on top, then
 * the tree under a header naming the branch, then Scripts, Outline and TODOs. Inside a
 * Feature the member chips lead the filter row, one tree per member.
 */
export default function FilesPanel(props: {
  /** The folder the workspace points at: the active member inside a Feature. */
  root: string | null;
  /** Empty outside a Feature. */
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

  const featured = () => props.members.length > 1;
  const memberOf = (key: string | null) => props.members.find((m) => m.key === key);
  const viewed = (): TintedMember | undefined =>
    memberOf(picked()) ?? props.members.find((m) => m.member.worktreePath === props.root);
  const treeRoot = () => {
    const m = viewed();
    if (!m) return props.root;
    return m.state.usable ? m.key : null;
  };
  const repoPath = () => viewed()?.member.repoPath ?? props.root ?? undefined;

  // Pointing the workspace at another member from anywhere else wins over the
  // chip picked here, and a new root is a new file list for the filter.
  createEffect(on(() => props.root, () => setPicked(null), { defer: true }));
  createEffect(
    on(treeRoot, () => {
      setFilter("");
      setWantFiles(false);
    }),
  );

  function pick(key: string) {
    setPicked(key);
    const m = memberOf(key);
    if (m?.state.usable && m.member.worktreePath) props.onActiveRoot?.(m.member.worktreePath);
  }

  const branchTitle = () => {
    const r = treeRoot();
    if (!r) return "";
    return gitStateFor(r).branch ?? basename(r);
  };

  const hasOutline = () => symbolsSupported(props.outlinePath);

  // The tree fills while it is open; with it shut, the last open section does.
  const filler = () => {
    if (sectionOpen("folders")) return "folders";
    const open = ORDER.filter((s) => sectionShown(s) && sectionOpen(s));
    return open[open.length - 1];
  };
  let stackEl: HTMLDivElement | undefined;
  // Room for the fill section's header plus a few rows, whatever is dragged.
  const maxH = () => (stackEl?.clientHeight ?? 0) - 120 * chromeScale();

  const menu = () => (
    <>
      <MenuRow disabled>
        <span class={styles.checkSlot}>
          <Icon icon={Check} />
        </span>
        Folders
      </MenuRow>
      <For each={OPTIONAL_SECTIONS}>
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
      <div class={styles.topBar}>
        <Show when={featured()}>
          <MemberChipRow
            bare
            cap={4}
            members={props.members}
            activeRoot={props.root}
            activeKey={viewed()?.key ?? null}
            onPick={(m) => pick(m.key)}
          />
        </Show>
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
          <IconButton size="md" tooltip="Views and More Actions" icon={<Icon icon={Ellipsis} />} />
        </Dropdown>
      </div>
      <div class={styles.stack} ref={stackEl}>
        <Section
          id="folders"
          fill={filler() === "folders"}
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
                <IconButton size="sm" icon={<Icon icon={FilePlus} />} tooltip="New File" onClick={() => controls()?.newFile()} />
                <IconButton
                  size="sm"
                  icon={<Icon icon={FolderPlus} />}
                  tooltip="New Folder"
                  onClick={() => controls()?.newFolder()}
                />
              </Show>
              <IconButton size="sm" icon={<Icon icon={RefreshCw} />} tooltip="Refresh" onClick={() => controls()?.refresh()} />
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
              noun={featured() ? "member folder" : "project folder"}
              member={featured() ? viewed()?.label : undefined}
              repoPath={repoPath()}
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
        </Section>
        <Show when={sectionShown("scripts")}>
          <Section id="scripts" fill={filler() === "scripts"} maxH={maxH} title="Scripts">
            <ScriptsSection root={treeRoot()} />
          </Section>
        </Show>
        <Show when={sectionShown("outline")}>
          <Section id="outline" fill={filler() === "outline"} maxH={maxH} title="Outline">
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
          </Section>
        </Show>
        <Show when={sectionShown("todos")}>
          <Section id="todos" fill={filler() === "todos"} maxH={maxH} title="TODOs">
            <TodoPanel root={treeRoot()} selected={props.selected} />
          </Section>
        </Show>
      </div>
    </div>
  );
}
