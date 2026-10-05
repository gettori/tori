import { For, Show, type JSX } from "solid-js";
import { ArrowRight, ChevronRight, Folder, Search, SquareTerminal, Tags } from "lucide-solid";
import Button from "../../../../components/Button/Button";
import Icon from "../../../../components/Icon/Icon";
import ProjectIcon from "../../../../components/Icon/ProjectIcon";
import { WorktreeMark } from "../../../../components/Icon/gitMarks";
import { BranchRow, ProjectRow } from "../../../LeftSidebar/SidebarRows";
import SpaceTile, { ModeTile } from "../../../LeftSidebar/SpaceTile";
import sidebar from "../../../LeftSidebar/LeftSidebar.module.css";
import rows from "../../../LeftSidebar/SidebarRows.module.css";
import MiniWindow from "./MiniWindow";
import styles from "./Folders.module.css";

type Entry = { name: string; glyph: () => JSX.Element; on?: boolean; dim?: boolean; folder?: boolean };

const BASE = "~/Projects";
const at = (project: string) => `${BASE}/work/${project}`;
const dir = (name: string, on?: boolean): Entry => ({ name, glyph: () => <Icon icon={Folder} />, on, folder: true });
const project = (name: string, on?: boolean): Entry => ({
  name,
  glyph: () => <ProjectIcon seed={at(name)} />,
  on,
  folder: true,
});
const worktree = (name: string, on?: boolean): Entry => ({ name, glyph: () => <WorktreeMark active={false} />, on });

const COLUMNS: { level: string; entries: Entry[] }[] = [
  { level: "Base folder", entries: [dir("Projects", true)] },
  { level: "Space", entries: [dir("work", true), dir("personal")] },
  { level: "Project", entries: [project("api", true), project("web"), project("infra")] },
  {
    level: "Branch or worktree",
    entries: [
      { name: ".bare", glyph: () => <Icon icon={Folder} />, dim: true },
      worktree("main"),
      worktree("fix/rate-limit", true),
      worktree("feat/webhooks"),
    ],
  },
];

function Level(props: { n: number; class?: string }) {
  return <span class={`${styles.badge} ${props.class ?? ""}`}>{props.n}</span>;
}

function Lights() {
  return (
    <span class={styles.lights}>
      <span />
      <span />
      <span />
    </span>
  );
}

// The same folders in a Finder column view, each column named for the level
// Tori reads it as.
function Disk() {
  return (
    <div class={`${styles.disk} ${styles.rise}`}>
      <div class={styles.diskHead}>
        <Lights />
        <Icon icon={Folder} />
        <span class={styles.title}>api</span>
      </div>
      <div class={styles.columns}>
        <For each={COLUMNS}>
          {(c, i) => (
            <div class={styles.column}>
              <div class={`${styles.level} ${styles.rise}`} style={{ "--i": 2 + i() * 2 }}>
                <Level n={i() + 1} />
                {c.level}
              </div>
              <For each={c.entries}>
                {(e) => (
                  <div
                    class={`${styles.entry} ${styles.rise}`}
                    classList={{
                      [styles.on]: e.on,
                      [styles.dim]: e.dim,
                    }}
                    style={{ "--i": 3 + i() * 2 }}
                  >
                    <span class={styles.glyph}>{e.glyph()}</span>
                    <span class={styles.name}>{e.name}</span>
                    <Show when={e.folder}>
                      <span class={styles.chevron}>
                        <Icon icon={ChevronRight} />
                      </span>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
      <div class={styles.pathBar}>
        <For each={COLUMNS.map((c) => c.entries.find((e) => e.on)!)}>
          {(e, i) => (
            <>
              <Show when={i() > 0}>
                <span class={styles.chevron}>
                  <Icon icon={ChevronRight} />
                </span>
              </Show>
              <span class={styles.crumb}>
                <span class={styles.glyph}>{e.glyph()}</span>
                {e.name}
              </span>
            </>
          )}
        </For>
      </div>
    </div>
  );
}

// The real sidebar parts on the same folders. No row carries a session status,
// so the picture stays about structure; the badges are the only additions.
function Sidebar() {
  return (
    <div class={`${sidebar.tree} ${rows.rowScope} ${styles.tree}`}>
      <div class={sidebar.treeHead}>
        <span class={sidebar.headStrut} />
        <div class={sidebar.spaceHeader}>
          <span class={sidebar.spaceHeaderName}>work</span>
          <span class={sidebar.spaceHeaderKind}>{"\u00b7 Spaces"}</span>
          <Level n={2} class={styles.inTree} />
        </div>
        <Button
          class={sidebar.searchToggle}
          variant="ghost"
          size="md"
          aria-label="Filter"
          icon={<Icon icon={Search} />}
        />
      </div>
      <div class={`${sidebar.treeScroll} ${styles.scroll}`}>
        <ProjectRow
          name="api"
          icon={<ProjectIcon seed={at("api")} />}
          disclosure
          open
          end={<Level n={3} class={styles.inTree} />}
        >
          <BranchRow label="main" icon={<WorktreeMark active={false} />} />
          <BranchRow
            label="fix/rate-limit"
            icon={<WorktreeMark active={false} />}
            selected
            end={<Level n={4} class={styles.inTree} />}
          />
          <BranchRow label="feat/webhooks" icon={<WorktreeMark active={false} />} />
        </ProjectRow>
        <ProjectRow name="web" icon={<ProjectIcon seed={at("web")} />} disclosure open>
          <BranchRow label="main" icon={<WorktreeMark active={false} />} />
          <BranchRow label="feat/webhooks" icon={<WorktreeMark active={false} />} />
          <BranchRow label="feat/search" icon={<WorktreeMark active={false} />} />
        </ProjectRow>
        <ProjectRow name="infra" icon={<ProjectIcon seed={at("infra")} />} disclosure />
      </div>
      <div class={sidebar.spaceBar}>
        <div class={sidebar.stripNav}>
          <div class={sidebar.spaceScroll}>
            <SpaceTile name="work" color="Sky" active nameWidth="52px" />
            <SpaceTile name="personal" color="Emerald" />
          </div>
          <div class={sidebar.spaceDivider} />
          <ModeTile label="Topics" glyph={Tags} />
        </div>
        <span class={`${sidebar.stripBtn} ${sidebar.dockBtn}`}>
          <Icon icon={SquareTerminal} />
        </span>
      </div>
    </div>
  );
}

/** Slide 02: a folder tree on disk beside the Tori sidebar that reads it. */
export default function Folders() {
  return (
    <div class={styles.stage}>
      <Disk />
      <span class={`${styles.reads} ${styles.rise}`} style={{ "--i": 10 }}>
        <Icon icon={ArrowRight} />
      </span>
      <MiniWindow
        class={styles.window}
        height={380}
        zoom={0.8}
        bar={
          <span class={styles.root}>
            <Level n={1} class={styles.inTree} />
            {BASE}
          </span>
        }
      >
        <Sidebar />
      </MiniWindow>
    </div>
  );
}
